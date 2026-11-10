import type { InventoryCostAdjustment } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 成本更正 HTTP 切片（Issue #163 / #100）。
 *
 * 用 PGlite 真库 + 真迁移覆盖：
 * - T1 无下游引用 → 直接生效、批次锁定成本更新、**不写 inventory_flow**；
 * - T2 被销售单引用但未结算 → 落 pending_approval，审批 / 驳回走 If-Match；
 * - T3 已结算 → 409 STATE_CONFLICT（COST_ADJUSTMENT_LOCKED），不落库；
 * - 无 view_price 的读取金额置 null（不 403、不出 0）；
 * - 写操作审计落 audit_log。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';
const WAREHOUSE_PHONE = '10000000004';

const PRODUCT_ID = '01900000-0000-7000-8000-000000000201';
const CUSTOMER_ID = '01900000-0000-7000-8000-000000000351';

const T1_BATCH_ID = '01900000-0000-7000-8000-000000000301';
const T2_BATCH_ID = '01900000-0000-7000-8000-000000000302';
const T3_BATCH_ID = '01900000-0000-7000-8000-000000000303';

const T2_ORDER_ID = '01900000-0000-7000-8000-000000000311';
const T2_LINE_ID = '01900000-0000-7000-8000-000000000321';
const T2_LINE_BATCH_ID = '01900000-0000-7000-8000-000000000331';

const T3_ORDER_ID = '01900000-0000-7000-8000-000000000312';
const T3_LINE_ID = '01900000-0000-7000-8000-000000000322';
const T3_LINE_BATCH_ID = '01900000-0000-7000-8000-000000000332';
const T3_SETTLEMENT_ID = '01900000-0000-7000-8000-000000000341';

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(
  cookie: string,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId, ...extra };
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

async function insertBatch(
  test: TestDatabase,
  input: { id: string; batchNo: string; inboundQty: string; unitCost: string },
): Promise<void> {
  await test.database.query(
    `INSERT INTO inventory_batch
       (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
        inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, $8)`,
    [
      input.id,
      DEMO_IDS.tenantId,
      DEMO_IDS.companyId,
      PRODUCT_ID,
      input.batchNo,
      input.unitCost,
      input.inboundQty,
      DEMO_IDS.ownerEmployeeId,
    ],
  );
}

/** 造一张引用了指定批次的销售单（E 单），用于把批次推到 T2 / T3。 */
async function insertSalesOrderReferencing(
  test: TestDatabase,
  input: { orderId: string; lineId: string; lineBatchId: string; orderNo: string; batchId: string },
): Promise<void> {
  await test.database.query(
    `INSERT INTO sales_order
       (id, tenant_id, company_id, order_no, customer_id, handler_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, '进行中')`,
    [
      input.orderId,
      DEMO_IDS.tenantId,
      DEMO_IDS.companyId,
      input.orderNo,
      CUSTOMER_ID,
      DEMO_IDS.salesEmployeeId,
    ],
  );
  await test.database.query(
    `INSERT INTO sales_order_line
       (id, tenant_id, company_id, order_id, line_no, product_id, qty, unit_price, amount, cost_floor)
     VALUES ($1, $2, $3, $4, 1, $5, 10, 30, 300, 18.75)`,
    [input.lineId, DEMO_IDS.tenantId, DEMO_IDS.companyId, input.orderId, PRODUCT_ID],
  );
  await test.database.query(
    `INSERT INTO sales_order_line_batch
       (id, tenant_id, company_id, order_id, order_line_id, line_no, batch_id)
     VALUES ($1, $2, $3, $4, $5, 1, $6)`,
    [
      input.lineBatchId,
      DEMO_IDS.tenantId,
      DEMO_IDS.companyId,
      input.orderId,
      input.lineId,
      input.batchId,
    ],
  );
}

describe('库存成本更正 HTTP（PGlite + 0025）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  let warehouseCookie: string;

  async function createRequest(
    cookie: string,
    requestId: string,
    batchId: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/inventory/batches/${batchId}/cost-adjustments`,
      headers: writeHeaders(cookie, requestId),
      payload,
    });
  }

  async function listRequest(cookie: string, requestId: string, batchId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/inventory/batches/${batchId}/cost-adjustments`,
      headers: readHeaders(cookie, requestId),
    });
  }

  async function approveRequest(
    cookie: string,
    requestId: string,
    id: string,
    extra: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/inventory/cost-adjustments/${id}/approve`,
      headers: writeHeaders(cookie, requestId, extra),
    });
  }

  async function rejectRequest(
    cookie: string,
    requestId: string,
    id: string,
    payload: Record<string, unknown>,
    extra: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/inventory/cost-adjustments/${id}/reject`,
      headers: writeHeaders(cookie, requestId, extra),
      payload,
    });
  }

  async function batchCost(batchId: string): Promise<{ cost: string; version: number }> {
    const result = await test.database.query<{ cost: string; version: number }>(
      `SELECT trim_scale(locked_unit_cost)::text AS cost, version
         FROM inventory_batch
        WHERE id = $1`,
      [batchId],
    );
    return result.rows[0]!;
  }

  async function flowCount(batchId: string): Promise<string> {
    const result = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_flow WHERE batch_id = $1`,
      [batchId],
    );
    return result.rows[0]!.count;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, 'C-163', '成本更正测试客户', '启用')`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, specification, unit, status)
       VALUES ($1, $2, $3, 'CA-001', '成本更正苹果', '{}', NULL, '件', '启用')`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );

    await insertBatch(test, {
      id: T1_BATCH_ID,
      batchNo: 'COST-T1-0001',
      inboundQty: '100',
      unitCost: '18.750000',
    });
    await insertBatch(test, {
      id: T2_BATCH_ID,
      batchNo: 'COST-T2-0002',
      inboundQty: '50',
      unitCost: '18.750000',
    });
    await insertBatch(test, {
      id: T3_BATCH_ID,
      batchNo: 'COST-T3-0003',
      inboundQty: '40',
      unitCost: '18.750000',
    });

    await insertSalesOrderReferencing(test, {
      orderId: T2_ORDER_ID,
      lineId: T2_LINE_ID,
      lineBatchId: T2_LINE_BATCH_ID,
      orderNo: 'E-163-T2',
      batchId: T2_BATCH_ID,
    });
    await insertSalesOrderReferencing(test, {
      orderId: T3_ORDER_ID,
      lineId: T3_LINE_ID,
      lineBatchId: T3_LINE_BATCH_ID,
      orderNo: 'E-163-T3',
      batchId: T3_BATCH_ID,
    });
    const t3 = await batchCost(T3_BATCH_ID);
    expect(t3.cost).toBe('18.75');

    await test.database.query(
      `INSERT INTO settlement_order
         (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id, status,
          total_sale_amount, total_cost_amount, gross_profit, gross_margin_rate,
          related_loss_amount, net_profit, commission_rate_snapshot, commission_amount)
       VALUES ($1, $2, $3, 'S-163-T3', 'E', $4, '待确认',
               300, 187.5, 112.5, 37.5, 0, 112.5, 0, 0)`,
      [T3_SETTLEMENT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, T3_ORDER_ID],
    );

    const built = await buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-cost-adjustment',
    });
    app = built;
    ownerCookie = await login(app, OWNER_PHONE, 'req-cost-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-cost-login-sales');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-cost-login-warehouse');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('T1：无下游引用直接生效，改成本不改数量，并记成功审计', async () => {
    const response = await createRequest(ownerCookie, 'req-cost-t1', T1_BATCH_ID, {
      afterUnitCost: '20',
      reason: '供应商补价',
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    const adjustment = response.json() as InventoryCostAdjustment;
    expect(adjustment).toMatchObject({
      batchId: T1_BATCH_ID,
      tier: 'T1',
      status: 'applied',
      beforeUnitCost: '18.75',
      afterUnitCost: '20',
      deltaAmount: '125',
      requestedBy: DEMO_IDS.ownerEmployeeId,
      approvedBy: null,
    });
    expect(adjustment.appliedAt).not.toBeNull();
    expect(adjustment.referenceSnapshot).toMatchObject({ referenced: false, settled: false });

    const batch = await batchCost(T1_BATCH_ID);
    expect(batch.cost).toBe('20');
    expect(batch.version).toBe(2);

    // 铁律：成本更正绝不写 inventory_flow（那会改库存数量）。
    expect(await flowCount(T1_BATCH_ID)).toBe('0');

    const audit = await test.database.query<{
      action: string;
      result: string;
      before: string;
      after: string;
      tier: string;
    }>(
      `SELECT action, result, changes->>'beforeUnitCost' AS before,
              changes->>'afterUnitCost' AS after, changes->>'tier' AS tier
         FROM audit_log
        WHERE object_id = $1 AND result = 'success'`,
      [adjustment.id],
    );
    expect(audit.rows).toEqual([
      {
        action: 'inventory.cost.adjustment.create',
        result: 'success',
        before: '18.75',
        after: '20',
        tier: 'T1',
      },
    ]);
  });

  it('列表：按批次倒序；无 view_price 时金额置 null（不 403、不出 0）', async () => {
    const owner = await listRequest(ownerCookie, 'req-cost-list-owner', T1_BATCH_ID);
    expect(owner.statusCode).toBe(200);
    const ownerPage = owner.json() as { items: InventoryCostAdjustment[] };
    expect(ownerPage.items.map((item) => item.batchId)).toEqual([T1_BATCH_ID]);
    expect(ownerPage.items[0]).toMatchObject({ deltaAmount: '125' });

    const sales = await listRequest(salesCookie, 'req-cost-list-sales', T1_BATCH_ID);
    expect(sales.statusCode).toBe(200);
    const salesPage = sales.json() as { items: InventoryCostAdjustment[] };
    expect(salesPage.items).toHaveLength(1);
    expect(salesPage.items[0]).toMatchObject({
      id: ownerPage.items[0]!.id,
      beforeUnitCost: null,
      afterUnitCost: null,
      deltaAmount: null,
    });
  });

  it('T2：被销售单引用但未结算 → 待审批；审批需权限 + If-Match，通过后改批次成本', async () => {
    const created = await createRequest(ownerCookie, 'req-cost-t2', T2_BATCH_ID, {
      afterUnitCost: '21.5',
      reason: '运费摊入',
    });
    expect(created.statusCode).toBe(201);
    const adjustment = created.json() as InventoryCostAdjustment;
    expect(adjustment).toMatchObject({
      tier: 'T2',
      status: 'pending_approval',
      beforeUnitCost: '18.75',
      afterUnitCost: '21.5',
      // (21.5 - 18.75) * 50 = 137.5
      deltaAmount: '137.5',
      approvedBy: null,
    });
    expect(adjustment.referenceSnapshot).toMatchObject({
      referenced: true,
      settled: false,
      references: [{ module: 'sales', docType: 'E', docId: T2_ORDER_ID }],
    });
    expect(await batchCost(T2_BATCH_ID)).toMatchObject({ cost: '18.75' });

    const noPermission = await approveRequest(
      warehouseCookie,
      'req-cost-t2-warehouse',
      adjustment.id,
      { 'if-match': '"1"' },
    );
    expect(noPermission.statusCode).toBe(403);

    const missingIfMatch = await approveRequest(ownerCookie, 'req-cost-t2-no-ifmatch', adjustment.id);
    expect(missingIfMatch.statusCode).toBe(428);

    const stale = await approveRequest(ownerCookie, 'req-cost-t2-stale', adjustment.id, {
      'if-match': '"9"',
    });
    expect(stale.statusCode).toBe(409);

    const approved = await approveRequest(ownerCookie, 'req-cost-t2-approve', adjustment.id, {
      'if-match': '"1"',
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.headers.etag).toBe('"2"');
    expect(approved.json()).toMatchObject({
      status: 'applied',
      approvedBy: DEMO_IDS.ownerEmployeeId,
      version: 2,
    });
    expect((await batchCost(T2_BATCH_ID)).cost).toBe('21.5');
    expect(await flowCount(T2_BATCH_ID)).toBe('0');

    const repeated = await approveRequest(ownerCookie, 'req-cost-t2-repeat', adjustment.id, {
      'if-match': '"2"',
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { reason: 'NOT_PENDING_APPROVAL', status: 'applied' },
    });
  });

  it('T2 驳回：写原因后置 rejected，批次成本不变', async () => {
    const created = await createRequest(ownerCookie, 'req-cost-reject-create', T2_BATCH_ID, {
      afterUnitCost: '19',
      reason: '尝试调低',
    });
    expect(created.statusCode).toBe(201);
    const adjustment = created.json() as InventoryCostAdjustment;
    expect(adjustment).toMatchObject({ tier: 'T2', status: 'pending_approval' });

    const missingIfMatch = await rejectRequest(
      ownerCookie,
      'req-cost-reject-no-ifmatch',
      adjustment.id,
      { reason: '不同意' },
    );
    expect(missingIfMatch.statusCode).toBe(428);

    const rejected = await rejectRequest(
      ownerCookie,
      'req-cost-reject',
      adjustment.id,
      { reason: '依据不足' },
      { 'if-match': '"1"' },
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      status: 'rejected',
      approvedBy: DEMO_IDS.ownerEmployeeId,
      version: 2,
    });
    expect((await batchCost(T2_BATCH_ID)).cost).toBe('21.5');
    expect(await flowCount(T2_BATCH_ID)).toBe('0');
  });

  it('T3：结算单「待确认」按 T2 走审批；转「已结算」后 409 STATE_CONFLICT + 一键退货入口，不再落库', async () => {
    // 「待确认」只是草稿，还没结算 —— 按口径算「有引用未结算」，走 T2 审批。
    const pending = await createRequest(ownerCookie, 'req-cost-t3-pending', T3_BATCH_ID, {
      afterUnitCost: '22',
      reason: '结算前调价',
    });
    expect(pending.statusCode).toBe(201);
    expect(pending.json()).toMatchObject({ tier: 'T2', status: 'pending_approval' });

    await test.database.query(
      `UPDATE settlement_order
          SET status = '已结算', related_loss_amount_snapshot = 0
        WHERE id = $1`,
      [T3_SETTLEMENT_ID],
    );

    const response = await createRequest(ownerCookie, 'req-cost-t3', T3_BATCH_ID, {
      afterUnitCost: '22',
      reason: '结算后调价',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'STATE_CONFLICT',
      details: {
        reason: 'COST_ADJUSTMENT_LOCKED',
        tier: 'T3',
        settled: true,
        returnEntry: {
          operationId: 'customer_return.create',
          method: 'POST',
          path: '/api/v1/customer-returns',
        },
      },
    });

    // 被拒的那次一行都不落；之前 T2 的那条仍在等审批。
    const rows = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_cost_adjustment
        WHERE batch_id = $1 AND status = 'pending_approval'`,
      [T3_BATCH_ID],
    );
    expect(rows.rows[0]!.count).toBe('1');
    expect((await batchCost(T3_BATCH_ID)).cost).toBe('18.75');
  });
  it('权限：无 inventory_qty.update 不得提交；AI 不得提交', async () => {
    const forbidden = await createRequest(salesCookie, 'req-cost-sales-create', T1_BATCH_ID, {
      afterUnitCost: '23',
      reason: '销售尝试',
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});
