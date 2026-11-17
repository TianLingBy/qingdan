import { randomUUID } from 'node:crypto';
import type { DedupeKind } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 主数据合并（#302 块 D / D103）HTTP 行为。
 *
 * 覆盖「必须做对的事」：
 *   - 引用真的改到留存档案上（客户 / 商品 / 加工厂三类，逐表核对 rows）；
 *   - 被并档案记 `merged_into_id` + `dedupe_state='merged'`，队列行落 `merged` 且记判定人；
 *   - `kept` / `merged` 的对子不许再合（422），`merged_into_id` 非空的不许再合（422）；
 *   - 跨公司对子 → 422 且库里一条都没动；
 *   - 按行真实 kind 鉴权：只有 `customer.merge` 的人合供应商对子 → 403，无副作用；
 *   - 纯 `read`（仓管）→ 403，无副作用；
 *   - 请求体不许夹带 id（`.strict()` → 422）；
 *   - 连锁：A 并进 B 后，「A vs C」自动落 `merged`（`decided_by` 为 NULL：没人判过它）；
 *   - 审计留痕：`object_type='masterdata_dedupe'`，`changes` 里带 keptId / mergedId / 改写行数。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';

const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const WAREHOUSE_PHONE = '10000000004';

/** 第二家公司：只用来验证「两条档案不同公司 → 422」。 */
const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000003';

/** 经理岗位（seed 的 POSITIONS[1]）：测试里撤掉它的 `supplier.merge`。 */
const MANAGER_POSITION_ID = '01900000-0000-7000-8000-000000000012';

interface MovedReference {
  table: string;
  column: string;
  rows: number;
}

interface MergeResultBody {
  keptId?: string;
  mergedId?: string;
  movedReferences?: MovedReference[];
  code?: string;
}

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

/** Cookie 认证的非安全请求需要同源 Origin（D59⑧）。 */
function writeHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId };
}

async function login(app: FastifyInstance, phone: string, requestId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

describe('主数据合并（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let warehouseCookie: string;
  let seq = 0;

  function code(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}`;
  }

  /** 按类型插档案：四张表必填列不同（product 要 unit，processor 连电话列都没有）。 */
  async function insertArchive(
    kind: DedupeKind,
    name: string,
    options: { companyId?: string; contactPhone?: string | null; specification?: string | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    const companyId = options.companyId ?? DEMO_IDS.companyId;
    if (kind === 'product') {
      await test.database.query(
        `INSERT INTO product (id, tenant_id, company_id, name, unit, specification)
         VALUES ($1, $2, $3, $4, '件', $5)`,
        [id, DEMO_IDS.tenantId, companyId, name, options.specification ?? null],
      );
    } else if (kind === 'processor') {
      await test.database.query(
        `INSERT INTO processor (id, tenant_id, company_id, name) VALUES ($1, $2, $3, $4)`,
        [id, DEMO_IDS.tenantId, companyId, name],
      );
    } else {
      await test.database.query(
        `INSERT INTO ${kind} (id, tenant_id, company_id, name, contact_phone)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, DEMO_IDS.tenantId, companyId, name, options.contactPhone ?? null],
      );
    }
    return id;
  }

  interface PairFixture {
    readonly pairId: string;
    readonly leftId: string;
    readonly rightId: string;
  }

  /** 造一条队列行：`left_id` 放 uuid 字典序小的一侧（与 recordDedupeCandidate 同口径）。 */
  async function insertPair(options: {
    kind?: DedupeKind;
    aId: string;
    bId: string;
    state?: 'pending' | 'kept' | 'merged';
    companyId?: string;
  }): Promise<PairFixture> {
    const kind = options.kind ?? 'customer';
    const state = options.state ?? 'pending';
    const [leftId, rightId] = options.aId < options.bId ? [options.aId, options.bId] : [options.bId, options.aId];
    const pairId = randomUUID();
    await test.database.query(
      `INSERT INTO masterdata_dedupe
         (id, tenant_id, company_id, kind, left_id, right_id, score, matched_by, note,
          state, decided_at, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0.950, 'name_only', NULL, $7, $8, $9)`,
      [
        pairId,
        DEMO_IDS.tenantId,
        options.companyId ?? DEMO_IDS.companyId,
        kind,
        leftId,
        rightId,
        state,
        state === 'pending' ? null : new Date().toISOString(),
        state === 'pending' ? null : DEMO_IDS.managerEmployeeId,
      ],
    );
    return { pairId, leftId, rightId };
  }

  /** 两条新档案 + 一条队列行。 */
  async function createPair(options: {
    kind?: DedupeKind;
    leftName: string;
    rightName: string;
    state?: 'pending' | 'kept' | 'merged';
    leftCompanyId?: string;
    rightCompanyId?: string;
  }): Promise<PairFixture & { aId: string; bId: string }> {
    const kind = options.kind ?? 'customer';
    const aId = await insertArchive(kind, options.leftName, {
      companyId: options.leftCompanyId,
    });
    const bId = await insertArchive(kind, options.rightName, {
      companyId: options.rightCompanyId,
    });
    const pair = await insertPair({ kind, aId, bId, state: options.state });
    return { ...pair, aId, bId };
  }

  async function merge(
    cookie: string,
    requestId: string,
    pairId: string,
    payload: Record<string, unknown> = { direction: 'left_into_right' },
  ): Promise<{ statusCode: number; body: MergeResultBody }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/masterdata/dedupe/${pairId}/merge`,
      headers: writeHeaders(cookie, requestId),
      payload,
    });
    return { statusCode: response.statusCode, body: response.json() as MergeResultBody };
  }

  async function archiveRow(
    kind: DedupeKind,
    id: string,
  ): Promise<{ merged_into_id: string | null; dedupe_state: string }> {
    const { rows } = await test.database.query<{ merged_into_id: string | null; dedupe_state: string }>(
      `SELECT merged_into_id, dedupe_state FROM ${kind} WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function pairRow(
    id: string,
  ): Promise<{ state: string; decided_by: string | null }> {
    const { rows } = await test.database.query<{ state: string; decided_by: string | null }>(
      `SELECT state, decided_by FROM masterdata_dedupe WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function salesOrder(customerId: string): Promise<string> {
    const id = randomUUID();
    await test.database.query(
      `INSERT INTO sales_order
         (id, tenant_id, company_id, order_no, customer_id, handler_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, code('E'), customerId, DEMO_IDS.managerEmployeeId],
    );
    return id;
  }

  async function salesOrderLine(orderId: string, productId: string): Promise<string> {
    const id = randomUUID();
    await test.database.query(
      `INSERT INTO sales_order_line
         (id, tenant_id, company_id, order_id, line_no, product_id, qty, unit_price, amount, cost_floor)
       VALUES ($1, $2, $3, $4, 1, $5, 1, 10, 10, 0)`,
      [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, orderId, productId],
    );
    return id;
  }

  async function purchaseOrder(supplierId: string): Promise<string> {
    const id = randomUUID();
    await test.database.query(
      `INSERT INTO purchase_order
         (id, tenant_id, company_id, order_no, supplier_id, handler_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, code('P'), supplierId, DEMO_IDS.managerEmployeeId],
    );
    return id;
  }

  async function purchaseOrderLine(
    orderId: string,
    productId: string,
    processorId: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await test.database.query(
      `INSERT INTO purchase_order_line
         (id, tenant_id, company_id, order_id, line_no, product_id, qty, unit_price, amount, processor_id)
       VALUES ($1, $2, $3, $4, 1, $5, 1, 10, 10, $6)`,
      [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, orderId, productId, processorId],
    );
    return id;
  }

  async function processingOrder(processorId: string, outputProductId: string | null = null): Promise<string> {
    const id = randomUUID();
    await test.database.query(
      `INSERT INTO processing_order
         (id, tenant_id, company_id, order_no, processor_id, handler_id, input_qty, output_product_id)
       VALUES ($1, $2, $3, $4, $5, $6, 10, $7)`,
      [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, code('G'), processorId, DEMO_IDS.managerEmployeeId, outputProductId],
    );
    return id;
  }

  async function processorQuote(processorId: string): Promise<string> {
    const id = randomUUID();
    await test.database.query(
      `INSERT INTO processor_quote
         (id, tenant_id, company_id, processor_id, quote_date, process_name, unit_price)
       VALUES ($1, $2, $3, $4, '2026-11-01', '冲压', 12.5)`,
      [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, processorId],
    );
    return id;
  }

  async function inventoryBatch(productId: string, heldByProcessorId: string | null = null): Promise<string> {
    const id = randomUUID();
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, inbound_qty, held_by_processor_id,
          locked_unit_cost, custodian_id)
       VALUES ($1, $2, $3, $4, $5, 10, $6, 0, $7)`,
      [
        id,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        productId,
        code('B'),
        heldByProcessorId,
        // 0009 把这两列收紧成 NOT NULL（锁价成本默认 0、保管员是仓管）。
        DEMO_IDS.warehouseEmployeeId,
      ],
    );
    return id;
  }

  function moved(result: MergeResultBody, table: string, column: string): number | undefined {
    return result.movedReferences?.find((item) => item.table === table && item.column === column)?.rows;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);

    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [SECOND_COMPANY_ID, DEMO_IDS.tenantId],
    );

    // 经理默认四类 `merge` 全有（D98）。撤掉 `supplier.merge` 才能测出「按 kind 分别鉴权」。
    await test.database.query(
      `UPDATE position_permission SET granted = false
        WHERE tenant_id = $1 AND position_id = $2 AND domain = 'supplier' AND action = 'merge'`,
      [DEMO_IDS.tenantId, MANAGER_POSITION_ID],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();

    ownerCookie = await login(app, OWNER_PHONE, 'req-merge-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-merge-login-manager');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-merge-login-warehouse');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('并客户：销售单改挂到留存客户，被并客户记 merged_into_id', async () => {
    const pair = await createPair({ leftName: '张记建材（老）', rightName: '张记建材' });
    const orderId = await salesOrder(pair.leftId);

    const result = await merge(ownerCookie, 'req-merge-customer', pair.pairId, {
      direction: 'left_into_right',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.keptId).toBe(pair.rightId);
    expect(result.body.mergedId).toBe(pair.leftId);
    expect(moved(result.body, 'sales_order', 'customer_id')).toBe(1);

    const { rows } = await test.database.query<{ customer_id: string }>(
      `SELECT customer_id FROM sales_order WHERE id = $1`,
      [orderId],
    );
    expect(rows[0]!.customer_id).toBe(pair.rightId);

    const source = await archiveRow('customer', pair.leftId);
    expect(source.merged_into_id).toBe(pair.rightId);
    expect(source.dedupe_state).toBe('merged');
    const kept = await archiveRow('customer', pair.rightId);
    expect(kept.merged_into_id).toBeNull();

    const pairAfter = await pairRow(pair.pairId);
    expect(pairAfter.state).toBe('merged');
    expect(pairAfter.decided_by).toBe(DEMO_IDS.ownerEmployeeId);

    // 审计：对象是队列行，changes 里能读出「并到哪去了」与改写行数。
    const audit = await test.database.query<{ action: string; changes: Record<string, unknown> }>(
      `SELECT action, changes FROM audit_log
        WHERE object_type = 'masterdata_dedupe' AND object_id = $1 AND result = 'success'`,
      [pair.pairId],
    );
    expect(audit.rows.some((row) => row.action === 'customer.dedupe.merge')).toBe(true);
  });

  it('并商品：库存批次 / 销售明细 / 采购明细三处引用都改过去', async () => {
    const pair = await createPair({ kind: 'product', leftName: '螺栓 M8（旧）', rightName: '螺栓 M8' });
    const batchId = await inventoryBatch(pair.leftId);
    const orderId = await salesOrder(await insertArchive('customer', '商品合并客户'));
    const lineId = await salesOrderLine(orderId, pair.leftId);
    const purchaseId = await purchaseOrder(await insertArchive('supplier', '商品合并供应商'));
    const purchaseLineId = await purchaseOrderLine(purchaseId, pair.leftId);

    const result = await merge(ownerCookie, 'req-merge-product', pair.pairId, {
      direction: 'left_into_right',
    });

    expect(result.statusCode).toBe(200);
    expect(moved(result.body, 'inventory_batch', 'product_id')).toBe(1);
    expect(moved(result.body, 'sales_order_line', 'product_id')).toBe(1);
    expect(moved(result.body, 'purchase_order_line', 'product_id')).toBe(1);

    const batch = await test.database.query<{ product_id: string }>(
      `SELECT product_id FROM inventory_batch WHERE id = $1`,
      [batchId],
    );
    expect(batch.rows[0]!.product_id).toBe(pair.rightId);
    const line = await test.database.query<{ product_id: string }>(
      `SELECT product_id FROM sales_order_line WHERE id = $1`,
      [lineId],
    );
    expect(line.rows[0]!.product_id).toBe(pair.rightId);
    const purchaseLine = await test.database.query<{ product_id: string }>(
      `SELECT product_id FROM purchase_order_line WHERE id = $1`,
      [purchaseLineId],
    );
    expect(purchaseLine.rows[0]!.product_id).toBe(pair.rightId);

    // 生成列（available_qty / remaining_qty）不依赖 product_id，改完仍算得对。
    const batchAfter = await test.database.query<{ available_qty: string }>(
      `SELECT available_qty FROM inventory_batch WHERE id = $1`,
      [batchId],
    );
    expect(Number(batchAfter.rows[0]!.available_qty)).toBe(10);
  });

  it('并加工厂：加工单 / 采购明细加工厂列 / 批次受托加工厂 / 历史报价四列都改', async () => {
    const pair = await createPair({ kind: 'processor', leftName: '永盛加工厂（老）', rightName: '永盛加工厂' });
    const productId = await insertArchive('product', '加工厂合并商品');
    const processingId = await processingOrder(pair.leftId, productId);
    const supplierId = await insertArchive('supplier', '加工厂合并供应商');
    const purchaseId = await purchaseOrder(supplierId);
    const purchaseLineId = await purchaseOrderLine(purchaseId, productId, pair.leftId);
    const batchId = await inventoryBatch(productId, pair.leftId);
    const quoteId = await processorQuote(pair.leftId);

    const result = await merge(ownerCookie, 'req-merge-processor', pair.pairId, {
      direction: 'left_into_right',
    });

    expect(result.statusCode).toBe(200);
    expect(moved(result.body, 'processing_order', 'processor_id')).toBe(1);
    expect(moved(result.body, 'purchase_order_line', 'processor_id')).toBe(1);
    expect(moved(result.body, 'inventory_batch', 'held_by_processor_id')).toBe(1);
    // 任务书漏列、仓库实测存在的引用（`0007_masterdata_processor.sql:54`）。
    expect(moved(result.body, 'processor_quote', 'processor_id')).toBe(1);

    const processing = await test.database.query<{ processor_id: string }>(
      `SELECT processor_id FROM processing_order WHERE id = $1`,
      [processingId],
    );
    expect(processing.rows[0]!.processor_id).toBe(pair.rightId);
    const purchaseLine = await test.database.query<{ processor_id: string }>(
      `SELECT processor_id FROM purchase_order_line WHERE id = $1`,
      [purchaseLineId],
    );
    expect(purchaseLine.rows[0]!.processor_id).toBe(pair.rightId);
    const batch = await test.database.query<{ held_by_processor_id: string }>(
      `SELECT held_by_processor_id FROM inventory_batch WHERE id = $1`,
      [batchId],
    );
    expect(batch.rows[0]!.held_by_processor_id).toBe(pair.rightId);
    const quote = await test.database.query<{ processor_id: string }>(
      `SELECT processor_id FROM processor_quote WHERE id = $1`,
      [quoteId],
    );
    expect(quote.rows[0]!.processor_id).toBe(pair.rightId);
  });

  it('right_into_left 与 left_into_right 结果对称', async () => {
    const pair = await createPair({ leftName: '对称客户甲', rightName: '对称客户乙' });
    const orderId = await salesOrder(pair.rightId);

    const result = await merge(ownerCookie, 'req-merge-direction-right', pair.pairId, {
      direction: 'right_into_left',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.keptId).toBe(pair.leftId);
    expect(result.body.mergedId).toBe(pair.rightId);
    expect(moved(result.body, 'sales_order', 'customer_id')).toBe(1);

    const order = await test.database.query<{ customer_id: string }>(
      `SELECT customer_id FROM sales_order WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0]!.customer_id).toBe(pair.leftId);
    expect((await archiveRow('customer', pair.rightId)).merged_into_id).toBe(pair.leftId);
    expect((await archiveRow('customer', pair.leftId)).merged_into_id).toBeNull();
  });

  it('只有 customer.merge 的人合供应商对子 → 403，两条档案与队列行都没动', async () => {
    const pair = await createPair({ kind: 'supplier', leftName: '越权供应商甲', rightName: '越权供应商乙' });
    const purchaseId = await purchaseOrder(pair.leftId);

    const result = await merge(managerCookie, 'req-merge-forbidden-supplier', pair.pairId, {
      direction: 'left_into_right',
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.code).toBe('FORBIDDEN');
    expect((await archiveRow('supplier', pair.leftId)).merged_into_id).toBeNull();
    expect((await archiveRow('supplier', pair.rightId)).merged_into_id).toBeNull();
    const pairAfter = await pairRow(pair.pairId);
    expect(pairAfter.state).toBe('pending');
    expect(pairAfter.decided_by).toBeNull();
    const order = await test.database.query<{ supplier_id: string }>(
      `SELECT supplier_id FROM purchase_order WHERE id = $1`,
      [purchaseId],
    );
    expect(order.rows[0]!.supplier_id).toBe(pair.leftId);
  });

  it('纯 read（仓管）→ 403 且无副作用', async () => {
    const pair = await createPair({ leftName: '仓管无权客户甲', rightName: '仓管无权客户乙' });

    const result = await merge(warehouseCookie, 'req-merge-forbidden-no-perm', pair.pairId);

    expect(result.statusCode).toBe(403);
    expect((await archiveRow('customer', pair.leftId)).merged_into_id).toBeNull();
    expect((await pairRow(pair.pairId)).state).toBe('pending');
  });

  it('已判为不同（kept）的对子 → 422，先 reopen 才能合并', async () => {
    const pair = await createPair({ leftName: '已判不同客户甲', rightName: '已判不同客户乙', state: 'kept' });

    const result = await merge(ownerCookie, 'req-merge-kept', pair.pairId);

    expect(result.statusCode).toBe(422);
    expect(result.body.code).toBe('VALIDATION_FAILED');
    expect((await archiveRow('customer', pair.leftId)).merged_into_id).toBeNull();
    expect((await pairRow(pair.pairId)).state).toBe('kept');
  });

  it('已合并（merged）的对子 → 422，不能重复合并', async () => {
    const pair = await createPair({ leftName: '已合并客户甲', rightName: '已合并客户乙', state: 'merged' });

    const result = await merge(ownerCookie, 'req-merge-already', pair.pairId);

    expect(result.statusCode).toBe(422);
    expect(result.body.code).toBe('VALIDATION_FAILED');
    expect((await archiveRow('customer', pair.leftId)).merged_into_id).toBeNull();
  });

  it('两条档案不同公司 → 422，库里一条都没动', async () => {
    const pair = await createPair({
      leftName: '本公司客户',
      rightName: '别家公司客户',
      rightCompanyId: SECOND_COMPANY_ID,
    });

    const result = await merge(ownerCookie, 'req-merge-cross-company', pair.pairId);

    expect(result.statusCode).toBe(422);
    expect(result.body.code).toBe('VALIDATION_FAILED');
    expect((await archiveRow('customer', pair.leftId)).merged_into_id).toBeNull();
    expect((await archiveRow('customer', pair.rightId)).merged_into_id).toBeNull();
    expect((await pairRow(pair.pairId)).state).toBe('pending');
  });

  it('其中一条已经被并过（merged_into_id 非空）→ 422', async () => {
    const pair = await createPair({ leftName: '重复被并客户甲', rightName: '重复被并客户乙' });
    const elsewhere = await insertArchive('customer', '重复被并目标客户');
    await test.database.query(`UPDATE customer SET merged_into_id = $1 WHERE id = $2`, [
      elsewhere,
      pair.leftId,
    ]);

    const result = await merge(ownerCookie, 'req-merge-already-merged', pair.pairId);

    expect(result.statusCode).toBe(422);
    expect(result.body.code).toBe('VALIDATION_FAILED');
    expect((await archiveRow('customer', pair.leftId)).merged_into_id).toBe(elsewhere);
    expect((await archiveRow('customer', pair.rightId)).merged_into_id).toBeNull();
  });

  it('连锁：A 并进 B 之后，「A vs C」自动落 merged（decided_by 为空）', async () => {
    const aId = await insertArchive('customer', '连锁客户 A');
    const bId = await insertArchive('customer', '连锁客户 B');
    const cId = await insertArchive('customer', '连锁客户 C');
    const ab = await insertPair({ aId, bId });
    const ac = await insertPair({ aId, bId: cId });

    const direction = ab.leftId === aId ? 'left_into_right' : 'right_into_left';
    const result = await merge(ownerCookie, 'req-merge-chain', ab.pairId, { direction });
    expect(result.statusCode).toBe(200);
    expect(result.body.mergedId).toBe(aId);
    expect(result.body.keptId).toBe(bId);

    const chained = await pairRow(ac.pairId);
    expect(chained.state).toBe('merged');
    // 没人判过这条，写操作人等于伪造一条判定记录。
    expect(chained.decided_by).toBeNull();
  });

  it('请求体不许夹带 id（只接受 direction）→ 422', async () => {
    const pair = await createPair({ leftName: '夹带 id 客户甲', rightName: '夹带 id 客户乙' });

    const result = await merge(ownerCookie, 'req-merge-extra-field', pair.pairId, {
      direction: 'left_into_right',
      sourceId: pair.rightId,
    });

    expect(result.statusCode).toBe(422);
    expect(result.body.code).toBe('VALIDATION_FAILED');
    expect((await archiveRow('customer', pair.leftId)).merged_into_id).toBeNull();
  });

  it('对子不存在 → 404；id 不是 uuid → 422', async () => {
    const missing = await merge(ownerCookie, 'req-merge-missing', randomUUID());
    expect(missing.statusCode).toBe(404);

    const malformed = await merge(ownerCookie, 'req-merge-malformed', 'not-a-uuid');
    expect(malformed.statusCode).toBe(422);
    expect(malformed.body.code).toBe('VALIDATION_FAILED');
  });
});
