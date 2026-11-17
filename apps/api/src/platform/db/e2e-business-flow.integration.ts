import type { SalesOrder } from '@qingdan/contracts';
import { buildApp } from '../../app.js';
import { testConfig } from '../config.js';
import { createPgDatabase } from './client.js';
import { DEMO_IDS, seed } from './seed.js';

/**
 * L3 真 PostgreSQL 端到端业务流（#103 第二项）。
 *
 * 只在真实 PostgreSQL 上跑：`QINGDAN_TEST_DB`（或 `DATABASE_URL`）指向一个**可清空**的测试库。
 * 与 `db-concurrency.integration.ts` 的区别：那个验库语义（锁/RLS/生成列），这个走完整 HTTP 链路。
 *
 * 覆盖六条链路（#354 第 1 条：把「迁移后的真表 + 真事务 + 真生成列 + 真触发器」跑一遍）：
 * - E：登录 → 建单 → 出库扣库存 → 签收 → 生成 C 草稿 → 确认结算；
 * - A：建采购单 → 完成入库（费用摊入批次锁价 #272）；
 * - B：建加工单 → 完成（材料扣减、成品入库、待执行占用释放 #286 / D94）；
 * - R：客户退货完成回补批次，红冲靠收款负数行（D24 / D40）；
 * - S：供应商退货完成扣减批次，金额按批次锁价（不读商品单价）；
 * - N：内部交易发货进「在途」→ 到货确认转移批次归属，不写库存流水（#208）。
 *
 * 库存仍有一份来自直接造数（E 单要能引用到已有批次），A/B/R/S/N 各自的库存变化全部走真实 HTTP 链路。
 */

const databaseUrl = process.env.QINGDAN_TEST_DB ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log('SKIP e2e-business-flow：未设置 QINGDAN_TEST_DB / DATABASE_URL（本机没有真 PG 时属预期）。');
  process.exit(0);
}

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';

// 固定 ID：重跑幂等（ON CONFLICT DO NOTHING），不与其它测试的固定 ID 冲突。
const CUSTOMER_ID = '01900000-0000-7000-8000-000000006201';
const PRODUCT_ID = '01900000-0000-7000-8000-000000006211';
const BATCH_A_ID = '01900000-0000-7000-8000-000000006221';
const BATCH_B_ID = '01900000-0000-7000-8000-000000006222';
const SUPPLIER_ID = '01900000-0000-7000-8000-000000006231';
const PROCESSOR_ID = '01900000-0000-7000-8000-000000006232';
const OUTPUT_PRODUCT_ID = '01900000-0000-7000-8000-000000006233';
/** N 内部交易的接收公司（与发出公司不同公司，才验得出「批次归属转移」）。 */
const COMPANY_B_ID = '01900000-0000-7000-8000-000000006234';

let passed = 0;
let failures = 0;

function ok(name: string): void {
  passed += 1;
  console.log(`PASS ${name}`);
}

function fail(name: string, detail: unknown): void {
  failures += 1;
  const message = detail instanceof Error ? detail.message : String(detail);
  console.log(`FAIL ${name}：${message}`);
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    ok(name);
  } catch (error) {
    fail(name, error);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const { database, pool } = createPgDatabase(databaseUrl!, { max: 4 });
  const app = buildApp({
    config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
    database,
    requestIdFactory: () => 'req-e2e-fallback',
  });

  let sequence = 0;
  function rid(prefix: string): string {
    sequence += 1;
    return `req-e2e-${prefix}-${sequence}`;
  }

  try {
    await seed(database);
    // 库存来自造数：E 单要引用到「已完成 A 单」才会有的批次，造数最省事；
    // A/B/R/S/N 五条链路的库存变化全部走真实 HTTP 端点（见下方各自 check）。
    await database.query(
      `INSERT INTO customer (id, tenant_id, company_id, customer_no, name)
       VALUES ($1, $2, $3, NULL, 'E2E 客户')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await database.query(
      `INSERT INTO product (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, 'E2E 商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E2E-FLOW-A', '10', '100', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'E2E-FLOW-B', '20', '100', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [BATCH_A_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, PRODUCT_ID, DEMO_IDS.ownerEmployeeId, BATCH_B_ID],
    );
    // A / B / S 单要用到的供应商与加工厂（主数据，建单时二选一里选「传 id」）。
    await database.query(
      `INSERT INTO supplier (id, tenant_id, company_id, supplier_no, name)
       VALUES ($1, $2, $3, NULL, 'E2E 供应商')
       ON CONFLICT (id) DO NOTHING`,
      [SUPPLIER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await database.query(
      `INSERT INTO processor (id, tenant_id, company_id, processor_no, name)
       VALUES ($1, $2, $3, NULL, 'E2E 加工厂')
       ON CONFLICT (id) DO NOTHING`,
      [PROCESSOR_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    // B 单的产出商品：与原料商品分开，才能用「该商品下的批次」精确断言成品批次。
    await database.query(
      `INSERT INTO product (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, 'E2E 加工成品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [OUTPUT_PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    // N 单要有第二个公司；老板在接收公司也挂同一个岗位，否则 receive 的
    // `principal.companyIds` 不含 toCompanyId（用例按公司鉴权，角色不算数）。
    await database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, 'E2E 接收公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY_B_ID, DEMO_IDS.tenantId],
    );
    await database.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       SELECT tenant_id, employee_id, $1::uuid, position_id
         FROM employee_company_position
        WHERE employee_id = $2::uuid AND company_id = $3::uuid
       ON CONFLICT DO NOTHING`,
      [COMPANY_B_ID, DEMO_IDS.ownerEmployeeId, DEMO_IDS.companyId],
    );
    await app.ready();

    let cookie = '';
    const writeHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
      cookie,
      origin: PUBLIC_BASE_URL,
      'x-request-id': rid('write'),
      ...extra,
    });

    await check('登录（业主手机号 + 开发验证码）', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-request-id': rid('login') },
        payload: { phone: OWNER_PHONE, code: '000000' },
      });
      assert(response.statusCode === 200, `登录返回 ${response.statusCode}：${response.body.slice(0, 200)}`);
      cookie = String(response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
      assert(cookie.length > 0, '登录没拿到会话 cookie');
    });

    let order: SalesOrder | null = null;
    await check('建 E 单（销售单）', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sales-orders',
        headers: writeHeaders(),
        payload: {
          companyId: DEMO_IDS.companyId,
          customerId: CUSTOMER_ID,
          handlerId: DEMO_IDS.ownerEmployeeId,
          lines: [
            {
              productId: PRODUCT_ID,
              batchIds: [BATCH_A_ID, BATCH_B_ID],
              qty: '5',
              unitPrice: '15',
              amount: '0',
            },
          ],
        },
      });
      assert(response.statusCode === 201, `建单返回 ${response.statusCode}：${response.body.slice(0, 300)}`);
      order = response.json() as SalesOrder;
      assert(order.status === '进行中', `新单状态期望「进行中」，实际「${order.status}」`);
    });

    await check('出库 E 单 → 扣库存（流水 2 条，每批 -2.5），状态「已发货」', async () => {
      const created = order;
      assert(created !== null, '前一步没建出单据');
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/sales-orders/${created.id}/ship`,
        headers: writeHeaders({ 'if-match': `"${created.version}"` }),
      });
      assert(response.statusCode === 200, `出库返回 ${response.statusCode}：${response.body.slice(0, 300)}`);
      const shipped = response.json() as SalesOrder;
      assert(shipped.status === '已发货', `出库状态期望「已发货」，实际「${shipped.status}」`);

      const flows = await database.query<{ batch_id: string; delta: string; source_doc_type: string }>(
        `SELECT batch_id, trim_scale(delta) AS delta, source_doc_type
           FROM inventory_flow WHERE source_doc_id = $1::uuid ORDER BY batch_id`,
        [created.id],
      );
      assert(flows.rows.length === 2, `期望 2 条库存流水，实际 ${flows.rows.length}`);
      for (const row of flows.rows) {
        assert(row.source_doc_type === 'E', `流水来源期望 E，实际 ${row.source_doc_type}`);
        assert(row.delta === '-2.5', `流水数量期望 -2.5，实际 ${row.delta}`);
      }

      const batches = await database.query<{ batch_no: string; available_qty: string }>(
        `SELECT b.batch_no, trim_scale(b.available_qty) AS available_qty
           FROM inventory_batch b WHERE b.id IN ($1::uuid, $2::uuid) ORDER BY b.batch_no`,
        [BATCH_A_ID, BATCH_B_ID],
      );
      for (const row of batches.rows) {
        assert(row.available_qty === '97.5', `批次 ${row.batch_no} 可用量期望 97.5，实际 ${row.available_qty}`);
      }

      // D94 ③：签收是独立一步，走 sales.approve；造数批次没有来源单，来源校验跳过。
      const committed = await app.inject({
        method: 'POST',
        url: `/api/v1/sales-orders/${created.id}/complete`,
        headers: writeHeaders({ 'if-match': `"${shipped.version}"` }),
      });
      assert(committed.statusCode === 200, `签收返回 ${committed.statusCode}：${committed.body.slice(0, 300)}`);
      const completed = committed.json() as SalesOrder;
      assert(completed.status === '已完成', `签收状态期望「已完成」，实际「${completed.status}」`);
    });

    let settlementId = '';
    let settlementVersion = 0;
    await check('完成即生成 C 草稿（待确认，金额 75 / 成本 75）', async () => {
      const created = order;
      assert(created !== null, '前一步没建出单据');
      const rows = await database.query<{
        id: string;
        status: string;
        total_sale_amount: string;
        total_cost_amount: string;
      }>(
        `SELECT id, status,
                trim_scale(total_sale_amount) AS total_sale_amount,
                trim_scale(total_cost_amount) AS total_cost_amount
           FROM settlement_order WHERE source_doc_type = 'E' AND source_doc_id = $1::uuid`,
        [created.id],
      );
      assert(rows.rows.length === 1, `期望生成 1 张 C 草稿，实际 ${rows.rows.length}`);
      const draft = rows.rows[0]!;
      assert(draft.status === '待确认', `草稿状态期望「待确认」，实际「${draft.status}」`);
      assert(draft.total_sale_amount === '75', `总售价期望 75，实际 ${draft.total_sale_amount}`);
      assert(draft.total_cost_amount === '75', `总成本期望 75，实际 ${draft.total_cost_amount}`);
      settlementId = draft.id;

      // 走 HTTP 读详情：确认真实链路能读，并拿到当前版本号（ETag）供确认用。
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/settlement-orders/${settlementId}`,
        headers: { cookie, 'x-request-id': rid('settlement-detail') },
      });
      assert(detail.statusCode === 200, `结算详情返回 ${detail.statusCode}：${detail.body.slice(0, 200)}`);
      const body = detail.json() as { version: number; confirmable: { allowed: boolean } };
      assert(body.confirmable.allowed, '结算单不可确认（confirmable.allowed=false）');
      settlementVersion = body.version;
    });

    await check('确认结算（待确认 → 已结算，审计落库）', async () => {
      assert(settlementId !== '', '前一步没取到结算单');
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/settlement-orders/${settlementId}/confirm`,
        headers: writeHeaders({ 'if-match': `"${settlementVersion}"` }),
      });
      assert(response.statusCode === 200, `确认返回 ${response.statusCode}：${response.body.slice(0, 300)}`);
      const confirmed = response.json() as { status: string };
      assert(confirmed.status === '已结算', `确认后状态期望「已结算」，实际「${confirmed.status}」`);

      const confirmAudit = await database.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE object_id = $1 AND action = 'settlement.order.confirm'`,
        [settlementId],
      );
      assert(confirmAudit.rows.length === 1, `确认结算审计期望 1 条，实际 ${confirmAudit.rows.length}`);

      const created = order;
      assert(created !== null, '前一步没建出单据');
      const completeAudit = await database.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE object_id = $1 AND action = 'sales.order.ship'`,
        [created.id],
      );
      assert(completeAudit.rows.length === 1, `完成 E 单审计期望 1 条，实际 ${completeAudit.rows.length}`);
    });

    // ---------------------------------------------------------------------
    // A 采购单：建单 → 完成入库（D83 / #272：费用按明细金额占比摊入批次锁价）
    // ---------------------------------------------------------------------
    let purchaseOrderId = '';
    let purchaseBatches: { batchId: string; lockedUnitCost: string }[] = [];
    await check('建 A 单并完成入库（2 行 → 2 批 2 流水，锁价 = 单价 + 摊入费用）', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/purchase-orders',
        headers: writeHeaders(),
        payload: {
          companyId: DEMO_IDS.companyId,
          supplierId: SUPPLIER_ID,
          handlerId: DEMO_IDS.ownerEmployeeId,
          // 两行金额 20 : 40 → 费用 6 按占比摊 2 : 4；
          // 锁价 = (2×10 + 2)/2 = 11、(2×20 + 4)/2 = 22。
          lines: [
            { productId: PRODUCT_ID, qty: '2', unitPrice: '10', amount: '20' },
            { productId: PRODUCT_ID, qty: '2', unitPrice: '20', amount: '40' },
          ],
          fees: [{ feeName: '运费', qty: '1', unitPrice: '6', amount: '6' }],
        },
      });
      assert(created.statusCode === 201, `建 A 单返回 ${created.statusCode}：${created.body.slice(0, 300)}`);
      const purchase = created.json() as { id: string; version: number; status: string };
      assert(purchase.status === '进行中', `新 A 单状态期望「进行中」，实际「${purchase.status}」`);
      purchaseOrderId = purchase.id;

      const completed = await app.inject({
        method: 'POST',
        url: `/api/v1/purchase-orders/${purchase.id}/complete`,
        headers: writeHeaders({ 'if-match': `"${purchase.version}"` }),
      });
      assert(completed.statusCode === 200, `完成 A 单返回 ${completed.statusCode}：${completed.body.slice(0, 300)}`);
      const done = completed.json() as { status: string };
      assert(done.status === '已完成', `完成 A 单状态期望「已完成」，实际「${done.status}」`);

      const flows = await database.query<{ batch_id: string; delta: string; source_doc_type: string }>(
        `SELECT batch_id, trim_scale(delta) AS delta, source_doc_type
           FROM inventory_flow WHERE source_doc_type = 'A' AND source_doc_id = $1::uuid
          ORDER BY batch_id`,
        [purchase.id],
      );
      assert(flows.rows.length === 2, `A 单完成期望 2 条库存流水，实际 ${flows.rows.length}`);
      for (const row of flows.rows) {
        assert(row.source_doc_type === 'A', `流水来源期望 A，实际 ${row.source_doc_type}`);
        assert(row.delta === '2', `A 单入库流水期望 +2，实际 ${row.delta}`);
      }

      const batches = await database.query<{
        id: string;
        locked_unit_cost: string;
        inbound_qty: string;
        available_qty: string;
        custodian_id: string;
      }>(
        `SELECT id, trim_scale(locked_unit_cost) AS locked_unit_cost,
                trim_scale(inbound_qty) AS inbound_qty, trim_scale(available_qty) AS available_qty,
                custodian_id
           FROM inventory_batch WHERE id = ANY($1::uuid[]) ORDER BY locked_unit_cost`,
        [flows.rows.map((row) => row.batch_id)],
      );
      assert(batches.rows.length === 2, `A 单完成期望新增 2 个批次，实际 ${batches.rows.length}`);
      const costs = batches.rows.map((row) => row.locked_unit_cost);
      assert(costs.join(',') === '11,22', `批次锁价期望 11,22（单价 10/20 + 摊入费用），实际 ${costs.join(',')}`);
      for (const row of batches.rows) {
        assert(row.inbound_qty === '2', `批次入库量期望 2，实际 ${row.inbound_qty}`);
        assert(row.available_qty === '2', `批次可用量期望 2（生成列自算），实际 ${row.available_qty}`);
        assert(
          row.custodian_id === DEMO_IDS.ownerEmployeeId,
          `批次保管人期望经手人，实际 ${row.custodian_id}`,
        );
      }
      purchaseBatches = batches.rows.map((row) => ({ batchId: row.id, lockedUnitCost: row.locked_unit_cost }));
    });

    // ---------------------------------------------------------------------
    // B 加工单：建单（占用待执行量）→ 完成（释放占用 + 材料扣减 + 成品入库）
    // ---------------------------------------------------------------------
    await check('建 B 加工单并完成（材料批次 −2、成品批次 +2、pending_execution_qty 归零）', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/processing-orders',
        headers: writeHeaders(),
        payload: {
          companyId: DEMO_IDS.companyId,
          processorId: PROCESSOR_ID,
          outputProductId: OUTPUT_PRODUCT_ID,
          handlerId: DEMO_IDS.ownerEmployeeId,
          materialBatchIds: [{ batchId: BATCH_A_ID, qty: '2' }],
          inputQty: '2',
          fees: [{ feeName: '加工费', qty: '1', unitPrice: '10', amount: '10' }],
        },
      });
      assert(created.statusCode === 201, `建 B 单返回 ${created.statusCode}：${created.body.slice(0, 300)}`);
      const processing = created.json() as { id: string; version: number; status: string };
      assert(processing.status === '进行中', `新 B 单状态期望「进行中」，实际「${processing.status}」`);

      // D92 / #286：建单即占用待执行量（E 单出库后 BATCH_A 入库量 97.5）。
      const reserved = await database.query<{ pending: string; available: string }>(
        `SELECT trim_scale(pending_execution_qty) AS pending, trim_scale(available_qty) AS available
           FROM inventory_batch WHERE id = $1::uuid`,
        [BATCH_A_ID],
      );
      const held = reserved.rows[0]!;
      assert(held.pending === '2', `B 单建单后待执行占用期望 2，实际 ${held.pending}`);
      assert(held.available === '95.5', `B 单建单后材料批次可用量期望 95.5（97.5 − 占用 2），实际 ${held.available}`);

      const completed = await app.inject({
        method: 'POST',
        url: `/api/v1/processing-orders/${processing.id}/complete`,
        headers: writeHeaders({ 'if-match': `"${processing.version}"` }),
        payload: { lossQty: '0' },
      });
      assert(completed.statusCode === 200, `完成 B 单返回 ${completed.statusCode}：${completed.body.slice(0, 300)}`);
      const done = completed.json() as { status: string; sellableQty: string };
      assert(done.status === '已完成', `B 单状态期望「已完成」，实际「${done.status}」`);
      assert(done.sellableQty === '2', `B 单可售量期望 2（2 − 损耗 0），实际 ${done.sellableQty}`);

      const material = await database.query<{ inbound_qty: string; pending: string; available: string }>(
        `SELECT trim_scale(inbound_qty) AS inbound_qty, trim_scale(pending_execution_qty) AS pending,
                trim_scale(available_qty) AS available
           FROM inventory_batch WHERE id = $1::uuid`,
        [BATCH_A_ID],
      );
      const left = material.rows[0]!;
      assert(left.inbound_qty === '95.5', `材料批次入库量期望 95.5（97.5 − 2），实际 ${left.inbound_qty}`);
      assert(left.pending === '0', `#286 / D94：完成后待执行占用必须释放为 0，实际 ${left.pending}`);
      assert(left.available === '95.5', `材料批次可用量期望 95.5，实际 ${left.available}`);

      // 成品批次：材料成本 2×10 = 20 + 加工费 10 = 30，摊到 2 件 = 15/件（D5：加工产出锁价）。
      const output = await database.query<{
        locked_unit_cost: string;
        inbound_qty: string;
        available_qty: string;
      }>(
        `SELECT trim_scale(locked_unit_cost) AS locked_unit_cost, trim_scale(inbound_qty) AS inbound_qty,
                trim_scale(available_qty) AS available_qty
           FROM inventory_batch WHERE product_id = $1::uuid AND company_id = $2::uuid`,
        [OUTPUT_PRODUCT_ID, DEMO_IDS.companyId],
      );
      assert(output.rows.length === 1, `成品批次期望 1 批，实际 ${output.rows.length}`);
      const product = output.rows[0]!;
      assert(product.locked_unit_cost === '15', `成品批次锁价期望 15（(2×10 + 10)/2），实际 ${product.locked_unit_cost}`);
      assert(product.inbound_qty === '2', `成品批次入库量期望 2，实际 ${product.inbound_qty}`);
      assert(product.available_qty === '2', `成品批次可用量期望 2，实际 ${product.available_qty}`);

      const flows = await database.query<{ delta: string }>(
        `SELECT trim_scale(delta) AS delta FROM inventory_flow
          WHERE source_doc_type = 'B' AND source_doc_id = $1::uuid ORDER BY delta`,
        [processing.id],
      );
      assert(flows.rows.length === 2, `B 单流水期望 2 条（材料 −2 + 成品 +2），实际 ${flows.rows.length}`);
      const deltas = flows.rows.map((row) => row.delta).join(',');
      assert(deltas === '-2,2', `B 单流水数量期望 -2,2，实际 ${deltas}`);
    });

    // ---------------------------------------------------------------------
    // R 客户退货：完成回补批次可用量 + 收款追加负数行（D24 / D34 / D40 红冲口径）
    // ---------------------------------------------------------------------
    await check('R 客户退货完成 → 批次回补 +2，红冲以收款负数行追加（原正数行不变）', async () => {
      const sold = order;
      assert(sold !== null, '前一步没建出 E 单');

      // 先落一条正数收款行做基准：红冲是「追加负数行」，不是改原行、也不是对消。
      const collected = await app.inject({
        method: 'POST',
        url: `/api/v1/sales-orders/${sold.id}/receipts`,
        headers: writeHeaders(),
        payload: { direction: '收款', amount: '75', method: '线下转账', occurredAt: new Date().toISOString() },
      });
      assert(collected.statusCode === 201, `追加收款返回 ${collected.statusCode}：${collected.body.slice(0, 300)}`);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/customer-returns',
        headers: writeHeaders(),
        payload: {
          companyId: DEMO_IDS.companyId,
          originalSalesOrderId: sold.id,
          returnType: '退货退款',
          refundMode: '原路退款',
          lines: [{ productId: PRODUCT_ID, batchIds: [BATCH_A_ID], qty: '2', unitPrice: '15', amount: '30' }],
          refundAmount: '30',
        },
      });
      assert(created.statusCode === 201, `建 R 单返回 ${created.statusCode}：${created.body.slice(0, 300)}`);
      const returned = created.json() as { id: string; version: number; status: string };
      assert(returned.status === '进行中', `新 R 单状态期望「进行中」，实际「${returned.status}」`);

      const completed = await app.inject({
        method: 'POST',
        url: `/api/v1/customer-returns/${returned.id}/complete`,
        headers: writeHeaders({ 'if-match': `"${returned.version}"` }),
      });
      assert(completed.statusCode === 200, `完成 R 单返回 ${completed.statusCode}：${completed.body.slice(0, 300)}`);
      const done = completed.json() as { status: string };
      assert(done.status === '已完成', `R 单状态期望「已完成」，实际「${done.status}」`);

      // 批次可用量回补：B 单完成后 95.5，退货 2 件 → 97.5。
      const batch = await database.query<{ inbound_qty: string; available_qty: string }>(
        `SELECT trim_scale(inbound_qty) AS inbound_qty, trim_scale(available_qty) AS available_qty
           FROM inventory_batch WHERE id = $1::uuid`,
        [BATCH_A_ID],
      );
      assert(batch.rows[0]!.inbound_qty === '97.5', `退货后批次入库量期望 97.5（95.5 + 2），实际 ${batch.rows[0]!.inbound_qty}`);
      assert(batch.rows[0]!.available_qty === '97.5', `退货后批次可用量期望 97.5，实际 ${batch.rows[0]!.available_qty}`);

      const flows = await database.query<{ delta: string }>(
        `SELECT trim_scale(delta) AS delta FROM inventory_flow
          WHERE source_doc_type = 'R' AND source_doc_id = $1::uuid`,
        [returned.id],
      );
      assert(flows.rows.length === 1, `R 单流水期望 1 条，实际 ${flows.rows.length}`);
      assert(flows.rows[0]!.delta === '2', `R 单流水数量期望 +2，实际 ${flows.rows[0]!.delta}`);

      // 红冲：R 完成本身只动库存，退款金额靠收款端点追加**负数行**。
      const refunded = await app.inject({
        method: 'POST',
        url: `/api/v1/sales-orders/${sold.id}/receipts`,
        headers: writeHeaders(),
        payload: {
          direction: '退款',
          amount: '-30',
          method: '原路退款',
          occurredAt: new Date().toISOString(),
          reversalDocId: returned.id,
        },
      });
      assert(refunded.statusCode === 201, `追加退款返回 ${refunded.statusCode}：${refunded.body.slice(0, 300)}`);

      const receipts = await database.query<{ direction: string; amount: string; reversal_doc_id: string | null }>(
        `SELECT direction, trim_scale(amount) AS amount, reversal_doc_id
           FROM sales_receipt WHERE sales_order_id = $1::uuid ORDER BY created_at, direction`,
        [sold.id],
      );
      assert(receipts.rows.length === 2, `收款记录期望 2 行（+75 与 −30），实际 ${receipts.rows.length}`);
      const positive = receipts.rows.find((row) => row.direction === '收款');
      const negative = receipts.rows.find((row) => row.direction === '退款');
      assert(positive !== undefined, '缺少原来的正数收款行');
      assert(positive.amount === '75', `原正数收款行金额必须一字不改（75），实际 ${positive.amount}`);
      assert(negative !== undefined, '缺少退款负数行');
      assert(Number(negative.amount) < 0, `退款行金额必须为负（红冲口径），实际 ${negative.amount}`);
      assert(negative.amount === '-30', `退款行金额期望 -30，实际 ${negative.amount}`);
      assert(negative.reversal_doc_id === returned.id, `退款行应指向 R 单（reversal_doc_id），实际 ${negative.reversal_doc_id}`);

      // 余额 = 收款合计 − 退款合计（D34）。
      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/sales-orders/${sold.id}/receipts`,
        headers: { cookie, 'x-request-id': rid('receipts') },
      });
      assert(listed.statusCode === 200, `读收款列表返回 ${listed.statusCode}：${listed.body.slice(0, 200)}`);
      const balance = (listed.json() as { amount: string | null }[]).reduce(
        (sum, row) => sum + Number(row.amount ?? '0'),
        0,
      );
      assert(balance === 45, `收款余额期望 45（75 − 30），实际 ${balance}`);
    });

    // ---------------------------------------------------------------------
    // S 供应商退货：完成扣减批次；退款额按批次锁价（不读商品当前单价）
    // ---------------------------------------------------------------------
    await check('S 供应商退货完成 → 批次 −2，退款按批次锁价（改商品单价也影响不到）', async () => {
      assert(purchaseOrderId !== '', '前一步没建出 A 单');
      const target = purchaseBatches[0];
      assert(target !== undefined, '前一步没取到 A 单批次');

      // 先把商品参考单价改成 999：若实现读商品单价，退货额就会变成 1998。
      await database.query(`UPDATE product SET default_sale_price = '999' WHERE id = $1::uuid`, [PRODUCT_ID]);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/supplier-returns',
        headers: writeHeaders(),
        payload: {
          companyId: DEMO_IDS.companyId,
          originalPurchaseOrderId: purchaseOrderId,
          lines: [
            {
              productId: PRODUCT_ID,
              batchIds: [target.batchId],
              qty: '2',
              unitPrice: target.lockedUnitCost,
              amount: '22',
            },
          ],
          refundAmount: '22',
        },
      });
      assert(created.statusCode === 201, `建 S 单返回 ${created.statusCode}：${created.body.slice(0, 300)}`);
      const supplierReturn = created.json() as { id: string; version: number; status: string; refundAmount: string };
      assert(supplierReturn.status === '进行中', `新 S 单状态期望「进行中」，实际「${supplierReturn.status}」`);
      // 应退金额 = Σ 明细数量 × 单价，单价取的是**批次锁价 11**（D83 入库成本口径）。
      const expectedRefund = 2 * Number(target.lockedUnitCost);
      assert(
        Number(supplierReturn.refundAmount) === expectedRefund,
        `S 单应退金额期望 ${expectedRefund}（2 × 批次锁价 ${target.lockedUnitCost}），实际 ${supplierReturn.refundAmount}`,
      );
      assert(
        Number(supplierReturn.refundAmount) !== 999 * 2,
        `S 单应退金额不应取商品当前单价（999 × 2 = 1998），实际 ${supplierReturn.refundAmount}`,
      );

      // D92：建单即占用，完成时先释放占用再扣减。
      const reserved = await database.query<{ pending: string }>(
        `SELECT trim_scale(pending_execution_qty) AS pending FROM inventory_batch WHERE id = $1::uuid`,
        [target.batchId],
      );
      assert(reserved.rows[0]!.pending === '2', `S 单建单后待执行占用期望 2，实际 ${reserved.rows[0]!.pending}`);

      const completed = await app.inject({
        method: 'POST',
        url: `/api/v1/supplier-returns/${supplierReturn.id}/complete`,
        headers: writeHeaders({ 'if-match': `"${supplierReturn.version}"` }),
      });
      assert(completed.statusCode === 200, `完成 S 单返回 ${completed.statusCode}：${completed.body.slice(0, 300)}`);
      const done = completed.json() as { status: string };
      assert(done.status === '已完成', `S 单状态期望「已完成」，实际「${done.status}」`);

      const batch = await database.query<{ inbound_qty: string; available_qty: string; pending: string }>(
        `SELECT trim_scale(inbound_qty) AS inbound_qty, trim_scale(available_qty) AS available_qty,
                trim_scale(pending_execution_qty) AS pending
           FROM inventory_batch WHERE id = $1::uuid`,
        [target.batchId],
      );
      const left = batch.rows[0]!;
      assert(left.inbound_qty === '0', `退货后批次入库量期望 0（2 − 2），实际 ${left.inbound_qty}`);
      assert(left.available_qty === '0', `退货后批次可用量期望 0，实际 ${left.available_qty}`);
      assert(left.pending === '0', `S 单完成后待执行占用必须归零，实际 ${left.pending}`);

      const flows = await database.query<{ delta: string }>(
        `SELECT trim_scale(delta) AS delta FROM inventory_flow
          WHERE source_doc_type = 'S' AND source_doc_id = $1::uuid`,
        [supplierReturn.id],
      );
      assert(flows.rows.length === 1, `S 单流水期望 1 条，实际 ${flows.rows.length}`);
      assert(flows.rows[0]!.delta === '-2', `S 单流水数量期望 -2，实际 ${flows.rows[0]!.delta}`);
    });

    // ---------------------------------------------------------------------
    // N 内部交易：发货进「在途」→ 到货确认转移批次归属，不写库存流水（#208 口径 3）
    // ---------------------------------------------------------------------
    await check('N 内部交易：发货进「在途」→ 到货确认转移批次归属，且不新增库存流水', async () => {
      const flowBefore = await database.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM inventory_flow WHERE batch_id = $1::uuid`,
        [BATCH_B_ID],
      );

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/internal-trade-orders',
        headers: writeHeaders(),
        payload: {
          fromCompanyId: DEMO_IDS.companyId,
          toCompanyId: COMPANY_B_ID,
          handlerId: DEMO_IDS.ownerEmployeeId,
          lines: [{ productId: PRODUCT_ID, batchIds: [BATCH_B_ID], qty: '1', unitPrice: '30', amount: '30' }],
          internalPrice: '30',
        },
      });
      assert(created.statusCode === 201, `建 N 单返回 ${created.statusCode}：${created.body.slice(0, 300)}`);
      const trade = created.json() as { id: string; version: number; status: string };
      assert(trade.status === '进行中', `新 N 单状态期望「进行中」，实际「${trade.status}」`);

      const dispatched = await app.inject({
        method: 'POST',
        url: `/api/v1/internal-trade-orders/${trade.id}/dispatch`,
        headers: writeHeaders({ 'if-match': `"${trade.version}"` }),
        payload: { confirm: true },
      });
      assert(dispatched.statusCode === 200, `N 单发货返回 ${dispatched.statusCode}：${dispatched.body.slice(0, 300)}`);
      const inTransit = dispatched.json() as { version: number; status: string };
      assert(inTransit.status === '在途', `N 单发货后状态期望「在途」（D68②），实际「${inTransit.status}」`);

      // 在途只占 in_transit_qty：可用量减少，入库量不变。
      const occupied = await database.query<{ in_transit_qty: string; available_qty: string }>(
        `SELECT trim_scale(in_transit_qty) AS in_transit_qty, trim_scale(available_qty) AS available_qty
           FROM inventory_batch WHERE id = $1::uuid`,
        [BATCH_B_ID],
      );
      assert(occupied.rows[0]!.in_transit_qty === '1', `在途期望占用 1，实际 ${occupied.rows[0]!.in_transit_qty}`);
      assert(occupied.rows[0]!.available_qty === '96.5', `在途时可用量期望 96.5（97.5 − 1），实际 ${occupied.rows[0]!.available_qty}`);

      const received = await app.inject({
        method: 'POST',
        url: `/api/v1/internal-trade-orders/${trade.id}/receive`,
        headers: writeHeaders({ 'if-match': `"${inTransit.version}"` }),
        payload: { confirm: true },
      });
      assert(received.statusCode === 200, `N 单到货确认返回 ${received.statusCode}：${received.body.slice(0, 300)}`);
      assert(
        (received.json() as { status: string }).status === '已完成',
        `N 单到货后状态期望「已完成」，实际「${(received.json() as { status: string }).status}」`,
      );

      // 到货确认 = 批次转司：批次归属公司从发出公司变为接收公司（inventory_batch.company_id）。
      const moved = await database.query<{ company_id: string; in_transit_qty: string; inbound_qty: string }>(
        `SELECT company_id, trim_scale(in_transit_qty) AS in_transit_qty, trim_scale(inbound_qty) AS inbound_qty
           FROM inventory_batch WHERE id = $1::uuid`,
        [BATCH_B_ID],
      );
      assert(moved.rows[0]!.company_id === COMPANY_B_ID, `批次归属公司期望转到接收公司，实际 ${moved.rows[0]!.company_id}`);
      assert(moved.rows[0]!.in_transit_qty === '0', `到货后在途量期望归零，实际 ${moved.rows[0]!.in_transit_qty}`);
      assert(moved.rows[0]!.inbound_qty === '97.5', `到货后入库量不应变化（仍 97.5），实际 ${moved.rows[0]!.inbound_qty}`);

      // #208 口径 3：N 单是所有权/保管权转移，不是物理出入库，记流水会污染出入库统计。
      const flowAfter = await database.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM inventory_flow WHERE batch_id = $1::uuid`,
        [BATCH_B_ID],
      );
      assert(
        flowAfter.rows[0]!.total === flowBefore.rows[0]!.total,
        `N 单不应新增库存流水：前 ${flowBefore.rows[0]!.total} 条，后 ${flowAfter.rows[0]!.total} 条`,
      );
    });
  } finally {
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await database.close().catch(() => undefined);
  }

  console.log(`\n结果：${passed} passed, ${failures} failed`);
  if (failures > 0) {
    console.log('FAIL e2e-business-flow：存在未通过的断言（见上）。');
    process.exit(1);
  }
  console.log(
    'OK e2e-business-flow：真 PostgreSQL 业务流（登录→E单→出库扣库存→签收→C草稿→确认结算 / A采购入库摊费用 / B加工释放占用 / R退货负数行 / S按批次锁价退货 / N转司不写流水）通过。',
  );
}

main().catch((error: unknown) => {
  console.error('FAIL e2e-business-flow：脚本异常终止', error);
  process.exit(1);
});
