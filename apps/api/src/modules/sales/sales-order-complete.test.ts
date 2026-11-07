import type { SalesOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * E 单「完成」HTTP 层（D72 / D19 / D70）。
 *
 * 验证：
 * - 完成 = 扣批次可用量（按行均分，末批承余量）+ 生成 C 单草稿 + 状态改「已完成」，同一事务；
 * - 流水来源为 E 单（`inventory_flow.source_doc_type = 'E'`）；
 * - C 草稿金额：总售价 = 单据总金额，总成本 = Σ(行数量 × 行加权平均批次成本)；
 * - 仅「进行中」可完成，重复完成 422；库存不足整单回滚。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';

const CUSTOMER_ID = '01900000-0000-7000-8000-000000005101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000005111';
const BATCH_A_ID = '01900000-0000-7000-8000-000000005121';
const BATCH_B_ID = '01900000-0000-7000-8000-000000005122';
const BATCH_C_ID = '01900000-0000-7000-8000-000000005123';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_A_ID, BATCH_B_ID],
  qty: '5',
  unitPrice: '15',
  amount: '0',
};

function writeHeaders(
  cookie: string,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId, ...extra };
}

async function login(
  app: FastifyInstance,
  phone: string,
  requestId: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

describe('E 单完成（D72：扣库存 + C 草稿同事务）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let sequence = 0;

  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-complete-${prefix}-${sequence}`;
  }

  async function createOrder(
    requestId: string,
    payload: Record<string, unknown> = {},
  ): Promise<SalesOrder> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId: CUSTOMER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        ...payload,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as SalesOrder;
  }

  async function complete(
    order: SalesOrder,
    requestId: string,
    version = order.version,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${order.id}/complete`,
      headers: writeHeaders(ownerCookie, requestId, {
        'if-match': `"${version}"`,
      }),
    });
  }

  async function batchAvailable(batchId: string): Promise<string> {
    const result = await test.database.query<{ available_qty: string }>(
      `SELECT trim_scale(available_qty) AS available_qty
         FROM inventory_batch WHERE id = $1::uuid`,
      [batchId],
    );
    return result.rows[0]!.available_qty;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, NULL, '完成态客户', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '完成态商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    // 三个批次：A 成本 10、B 成本 20、C 成本 30，各入库 100。
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E-COMPLETE-A', '10', '100', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'E-COMPLETE-B', '20', '100', '0', '0', '0', $5),
              ($7, $2, $3, $4, 'E-COMPLETE-C', '30', '100', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
        BATCH_B_ID,
        BATCH_C_ID,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-complete-login-owner');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('完成 → 扣两批各 2.5 + 生成 C 草稿 + 状态已完成 + ETag 前进', async () => {
    const order = await createOrder(nextRequestId('ok'));
    const saleBefore = await batchAvailable(BATCH_A_ID);
    const costBefore = await batchAvailable(BATCH_B_ID);

    const response = await complete(order, nextRequestId('ok-complete'));
    expect(response.statusCode).toBe(200);
    const body = response.json() as SalesOrder;
    expect(body.status).toBe('已完成');
    expect(body.version).toBe(order.version + 1);
    expect(response.headers.etag).toBe(`"${body.version}"`);

    // 库存：行数量 5 均分给两个批次 → 各 2.5（末批承余量，此处恰好整除）。
    expect(saleBefore).toBe('100');
    expect(costBefore).toBe('100');
    expect(await batchAvailable(BATCH_A_ID)).toBe('97.5');
    expect(await batchAvailable(BATCH_B_ID)).toBe('97.5');

    // 库存流水：来源是 E 单，两行，数量为负。
    const flows = await test.database.query<{
      batch_id: string;
      delta: string;
      source_doc_type: string;
      source_doc_id: string;
    }>(
      `SELECT batch_id, trim_scale(delta) AS delta, source_doc_type, source_doc_id
         FROM inventory_flow WHERE source_doc_id = $1::uuid ORDER BY batch_id`,
      [order.id],
    );
    expect(flows.rows).toHaveLength(2);
    for (const row of flows.rows) {
      expect(row.source_doc_type).toBe('E');
      expect(row.delta).toBe('-2.5');
    }

    // C 单草稿：总售价 = 单据总金额（5 × 15 = 75），总成本 = 5 × 加权平均成本。
    const settlement = await test.database.query<{
      status: string;
      total_sale_amount: string;
      total_cost_amount: string;
      gross_profit: string;
      net_profit: string;
      commission_rate_snapshot: string;
      related_loss_amount: string;
      order_no: string;
    }>(
      `SELECT status,
              trim_scale(total_sale_amount) AS total_sale_amount,
              trim_scale(total_cost_amount) AS total_cost_amount,
              trim_scale(gross_profit) AS gross_profit,
              trim_scale(net_profit) AS net_profit,
              trim_scale(commission_rate_snapshot) AS commission_rate_snapshot,
              trim_scale(related_loss_amount) AS related_loss_amount,
              order_no
         FROM settlement_order
        WHERE source_doc_type = 'E' AND source_doc_id = $1::uuid`,
      [order.id],
    );
    expect(settlement.rows).toHaveLength(1);
    const draft = settlement.rows[0]!;
    expect(draft.status).toBe('待确认');
    expect(draft.order_no).toMatch(/^C-0001-\d{8}-\d{4}$/);
    expect(draft.total_sale_amount).toBe('75');
    // 行加权平均批次成本 = (10 + 20) / 2 = 15 → 总成本 5 × 15 = 75 → 毛利 0。
    expect(draft.total_cost_amount).toBe('75');
    expect(draft.gross_profit).toBe('0');
    expect(draft.net_profit).toBe('0');
    // 本期占位：损失与提成比例取 0（D72 ③④），不是算错。
    expect(draft.related_loss_amount).toBe('0');
    expect(draft.commission_rate_snapshot).toBe('0');

    // 审计：一条 sales.order.complete，带结算草稿与流水数量。
    const audit = await test.database.query<{ changes: Record<string, unknown> }>(
      `SELECT changes FROM audit_log
        WHERE action = 'sales.order.complete' AND object_id = $1`,
      [order.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.changes).toMatchObject({
      beforeStatus: '进行中',
      afterStatus: '已完成',
      stockFlowCount: 2,
    });
  });

  it('除不尽时末批承余量：3 个批次分 1 件 → 0.333333 / 0.333333 / 0.333334', async () => {
    const order = await createOrder(nextRequestId('split'), {
      lines: [
        {
          ...LINE,
          batchIds: [BATCH_A_ID, BATCH_B_ID, BATCH_C_ID],
          qty: '1',
          unitPrice: '30',
        },
      ],
    });
    const response = await complete(order, nextRequestId('split-complete'));
    expect(response.statusCode).toBe(200);

    const flows = await test.database.query<{ batch_no: string; delta: string }>(
      `SELECT b.batch_no, trim_scale(f.delta) AS delta
         FROM inventory_flow f
         JOIN inventory_batch b ON b.id = f.batch_id
        WHERE f.source_doc_id = $1::uuid ORDER BY b.batch_no`,
      [order.id],
    );
    // 末批（按 batchIds 顺序的最后一个）承接除不尽的余量。
    expect(flows.rows.map((row) => [row.batch_no, row.delta])).toEqual([
      ['E-COMPLETE-A', '-0.333333'],
      ['E-COMPLETE-B', '-0.333333'],
      ['E-COMPLETE-C', '-0.333334'],
    ]);
  });

  it('重复完成 → 422；已完成单不可再取消', async () => {
    const order = await createOrder(nextRequestId('twice'));
    const first = await complete(order, nextRequestId('twice-1'));
    expect(first.statusCode).toBe(200);

    const again = await complete(order, nextRequestId('twice-2'), order.version + 1);
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${order.id}/cancel`,
      headers: writeHeaders(ownerCookie, nextRequestId('twice-cancel'), {
        'if-match': '"2"',
        'x-audit-reason': '重复完成后再尝试取消',
      }),
    });
    expect(cancel.statusCode).toBe(422);
  });

  it('库存不足 → 409 且整单回滚（状态仍进行中、无 C 草稿、无流水）', async () => {
    const thinBatch = '01900000-0000-7000-8000-000000005129';
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E-COMPLETE-THIN', '10', '1', '0', '0', '0', $5)`,
      [thinBatch, DEMO_IDS.tenantId, DEMO_IDS.companyId, PRODUCT_ID, DEMO_IDS.ownerEmployeeId],
    );
    const order = await createOrder(nextRequestId('thin'), {
      lines: [{ ...LINE, batchIds: [thinBatch], qty: '3' }],
    });

    const response = await complete(order, nextRequestId('thin-complete'));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const state = await test.database.query<{ status: string }>(
      `SELECT status FROM sales_order WHERE id = $1::uuid`,
      [order.id],
    );
    expect(state.rows[0]!.status).toBe('进行中');

    const drafts = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM settlement_order WHERE source_doc_id = $1::uuid`,
      [order.id],
    );
    expect(drafts.rows[0]!.n).toBe(0);
    const flows = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inventory_flow WHERE source_doc_id = $1::uuid`,
      [order.id],
    );
    expect(flows.rows[0]!.n).toBe(0);
  });

  it('缺 If-Match → 428', async () => {
    const order = await createOrder(nextRequestId('nomatch'));
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${order.id}/complete`,
      headers: writeHeaders(ownerCookie, nextRequestId('nomatch-complete')),
    });
    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });
  });
});
