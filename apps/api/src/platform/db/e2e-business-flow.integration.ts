import type { SalesOrder } from '@qingdan/contracts';
import { buildApp } from '../../app.js';
import { testConfig } from '../config.js';
import { createPgDatabase } from './client.js';
import { DEMO_IDS, seed } from './seed.js';

/**
 * L3 真 PostgreSQL 端到端业务流（#103 第二项）。
 *
 * 只在真实 PostgreSQL 上跑：`QINGDAN_TEST_DB`（或 `DATABASE_URL`）指向一个**可清空**的测试库。
 * 与 `db-concurrency.integration.ts` 的区别：那个验库语义（锁/RLS/生成列），这个走完整 HTTP 链路，
 * 验「登录 → 建 E 单 → 完成扣库存 → 生成 C 草稿 → 确认结算」在真库上串得通。
 *
 * 缺口（#99 未接，故意跳过而不是假装通过）：`登录 → 建 A 单 → 完成入库` 这一段没有端点，
 * 所以库存来自直接造数；等 #99 落地后把这一段补进这里。
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
    // 库存来自造数而不是 A 单入库（#99 未接，见文件头）。
    await database.query(
      `INSERT INTO customer (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, NULL, 'E2E 客户', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await database.query(
      `INSERT INTO product (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, 'E2E 商品', '{}', '件', '启用')
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

    await check('完成 E 单 → 扣库存（流水 2 条，每批 -2.5）', async () => {
      const created = order;
      assert(created !== null, '前一步没建出单据');
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/sales-orders/${created.id}/complete`,
        headers: writeHeaders({ 'if-match': `"${created.version}"` }),
      });
      assert(response.statusCode === 200, `完成返回 ${response.statusCode}：${response.body.slice(0, 300)}`);
      const completed = response.json() as SalesOrder;
      assert(completed.status === '已完成', `完成状态期望「已完成」，实际「${completed.status}」`);

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
        `SELECT action FROM audit_log WHERE object_id = $1 AND action = 'sales.order.complete'`,
        [created.id],
      );
      assert(completeAudit.rows.length === 1, `完成 E 单审计期望 1 条，实际 ${completeAudit.rows.length}`);
    });

    console.log('SKIP A 单完成入库：该端点属于 #99（未接），库存由造数提供。');
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
  console.log('OK e2e-business-flow：真 PostgreSQL 业务流（登录→E单→扣库存→C草稿→确认结算）通过。');
}

main().catch((error: unknown) => {
  console.error('FAIL e2e-business-flow：脚本异常终止', error);
  process.exit(1);
});
