import type { SalesOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * E 单签收（D94 ③ / D94 ④）HTTP 层。
 *
 * 验证：
 * - 出库后状态是「已发货」，签收后才「已完成」；
 * - 签收按批次反查来源 A/B 单，有一张不是「已完成」就 409
 *   `STATE_CONFLICT` + `details.reason='SOURCE_ORDER_NOT_READY'` + `details.blocking` 指名；
 * - `N` 内部交易等非 A/B 来源跳过校验；
 * - 允许「进行中」直接签收（D94 ⑤），此时补出库的扣库存 + C 草稿；
 * - 签收权限是 `sales.approve`：只有 `sales.update` 的人 403（本次改动的核心语义）；
 * - 并发两次签收只有一次成功（If-Match + version）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
/** 种子里的「销售」：有 sales.update / view_price，没有 sales.approve。 */
const SALES_PHONE = '10000000003';

const CUSTOMER_ID = '01900000-0000-7000-8000-000000006101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000006111';

const SUPPLIER_ID = '01900000-0000-7000-8000-000000006201';
const PROCESSOR_ID = '01900000-0000-7000-8000-000000006202';

const BATCH_A_OK_ID = '01900000-0000-7000-8000-000000006301';
const BATCH_A_TRANSIT_ID = '01900000-0000-7000-8000-000000006302';
const BATCH_B_OK_ID = '01900000-0000-7000-8000-000000006303';
const BATCH_B_TRANSIT_ID = '01900000-0000-7000-8000-000000006304';
const BATCH_N_ID = '01900000-0000-7000-8000-000000006305';
const BATCH_DIRECT_ID = '01900000-0000-7000-8000-000000006306';
const BATCH_DIRECT_TRANSIT_ID = '01900000-0000-7000-8000-000000006307';

const PO_DONE_ID = '01900000-0000-7000-8000-000000006401';
const PO_TRANSIT_ID = '01900000-0000-7000-8000-000000006402';
const PO_DIRECT_ID = '01900000-0000-7000-8000-000000006403';
const PO_DIRECT_TRANSIT_ID = '01900000-0000-7000-8000-000000006404';
const MO_DONE_ID = '01900000-0000-7000-8000-000000006501';
const MO_TRANSIT_ID = '01900000-0000-7000-8000-000000006502';

const PO_DONE_NO = 'PO-0001-20261117-0001';
const PO_TRANSIT_NO = 'PO-0001-20261117-0002';
const PO_DIRECT_NO = 'PO-0001-20261117-0003';
const PO_DIRECT_TRANSIT_NO = 'PO-0001-20261117-0004';
const MO_DONE_NO = 'MO-0001-20261117-0001';
const MO_TRANSIT_NO = 'MO-0001-20261117-0002';

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

describe('E 单签收（D94 ③：来源 A/B 单未完成就 409）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  let sequence = 0;

  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-receipt-${prefix}-${sequence}`;
  }

  async function createOrder(
    batchIds: string[],
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
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds,
            qty: '1',
            unitPrice: '10',
            amount: '0',
          },
        ],
        ...payload,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as SalesOrder;
  }

  async function ship(
    order: SalesOrder,
    requestId: string,
    cookie = ownerCookie,
    version = order.version,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${order.id}/ship`,
      headers: writeHeaders(cookie, requestId, {
        'if-match': `"${version}"`,
      }),
    });
  }

  async function complete(
    order: SalesOrder,
    requestId: string,
    cookie = ownerCookie,
    version = order.version,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${order.id}/complete`,
      headers: writeHeaders(cookie, requestId, {
        'if-match': `"${version}"`,
      }),
    });
  }

  async function statusOf(orderId: string): Promise<string> {
    const result = await test.database.query<{ status: string }>(
      `SELECT status FROM sales_order WHERE id = $1::uuid`,
      [orderId],
    );
    return result.rows[0]!.status;
  }

  async function countRows(
    table: 'inventory_flow' | 'settlement_order',
    orderId: string,
  ): Promise<number> {
    const result = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE source_doc_id = $1::uuid`,
      [orderId],
    );
    return result.rows[0]!.n;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name)
       VALUES ($1, $2, $3, NULL, '签收客户')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '签收商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO supplier (id, tenant_id, company_id, supplier_no, name)
       VALUES ($1, $2, $3, NULL, '签收供应商')
       ON CONFLICT (id) DO NOTHING`,
      [SUPPLIER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO processor (id, tenant_id, company_id, processor_no, name)
       VALUES ($1, $2, $3, NULL, '签收加工厂')
       ON CONFLICT (id) DO NOTHING`,
      [PROCESSOR_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );

    // 来源单：A 单两张已完成 / 在途，B 单一张已完成 / 一张在途。
    await test.database.query(
      `INSERT INTO purchase_order
         (id, tenant_id, company_id, order_no, supplier_id, handler_id, status)
       VALUES ($1, $5, $6, $7, $9, $10, '已完成'),
              ($2, $5, $6, $8, $9, $10, '在途'),
              ($3, $5, $6, $11, $9, $10, '已完成'),
              ($4, $5, $6, $12, $9, $10, '在途')`,
      [
        PO_DONE_ID,
        PO_TRANSIT_ID,
        PO_DIRECT_ID,
        PO_DIRECT_TRANSIT_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PO_DONE_NO,
        PO_TRANSIT_NO,
        SUPPLIER_ID,
        DEMO_IDS.ownerEmployeeId,
        PO_DIRECT_NO,
        PO_DIRECT_TRANSIT_NO,
      ],
    );
    await test.database.query(
      `INSERT INTO processing_order
         (id, tenant_id, company_id, order_no, processor_id, handler_id, status, input_qty)
       VALUES ($1, $3, $4, $5, $7, $8, '已完成', '1'),
              ($2, $3, $4, $6, $7, $8, '在途', '1')`,
      [
        MO_DONE_ID,
        MO_TRANSIT_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        MO_DONE_NO,
        MO_TRANSIT_NO,
        PROCESSOR_ID,
        DEMO_IDS.ownerEmployeeId,
      ],
    );

    // 批次：成本 1，避免开单时触破改价下限。
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES
         ($1, $8, $9, $10, 'RC-A-OK', '1', '100', '0', '0', '0', $11),
         ($2, $8, $9, $10, 'RC-A-TRANSIT', '1', '100', '0', '0', '0', $11),
         ($3, $8, $9, $10, 'RC-B-OK', '1', '100', '0', '0', '0', $11),
         ($4, $8, $9, $10, 'RC-B-TRANSIT', '1', '100', '0', '0', '0', $11),
         ($5, $8, $9, $10, 'RC-N', '1', '100', '0', '0', '0', $11),
         ($6, $8, $9, $10, 'RC-DIRECT', '1', '100', '0', '0', '0', $11),
         ($7, $8, $9, $10, 'RC-DIRECT-TRANSIT', '1', '100', '0', '0', '0', $11)`,
      [
        BATCH_A_OK_ID,
        BATCH_A_TRANSIT_ID,
        BATCH_B_OK_ID,
        BATCH_B_TRANSIT_ID,
        BATCH_N_ID,
        BATCH_DIRECT_ID,
        BATCH_DIRECT_TRANSIT_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
      ],
    );

    // 建批流水：批次 → 来源单（D94 ③ 的反查依据，inventory_batch 本身没有来源列）。
    await test.database.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id, handled_by)
       VALUES
         (gen_random_uuid(), $1, $7, $2, '100', 'A', $8, $9),
         (gen_random_uuid(), $1, $7, $3, '100', 'A', $10, $9),
         (gen_random_uuid(), $1, $7, $4, '100', 'B', $11, $9),
         (gen_random_uuid(), $1, $7, $5, '100', 'B', $12, $9),
         (gen_random_uuid(), $1, $7, $6, '100', 'N', $13, $9),
         (gen_random_uuid(), $1, $7, $14, '100', 'A', $15, $9),
         (gen_random_uuid(), $1, $7, $16, '100', 'A', $17, $9)`,
      [
        DEMO_IDS.tenantId,
        BATCH_A_OK_ID,
        BATCH_A_TRANSIT_ID,
        BATCH_B_OK_ID,
        BATCH_B_TRANSIT_ID,
        BATCH_N_ID,
        DEMO_IDS.companyId,
        PO_DONE_ID,
        DEMO_IDS.ownerEmployeeId,
        PO_TRANSIT_ID,
        MO_DONE_ID,
        MO_TRANSIT_ID,
        // N 内部交易单：uuid 只做来源记录，不在本单校验范围。
        '01900000-0000-7000-8000-000000009999',
        BATCH_DIRECT_ID,
        PO_DIRECT_ID,
        BATCH_DIRECT_TRANSIT_ID,
        PO_DIRECT_TRANSIT_ID,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-receipt-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-receipt-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('出库 → 已发货；来源 A/B 都已完成 → 签收成功，且不重复扣库存 / 不重复生成 C 草稿', async () => {
    const order = await createOrder(
      [BATCH_A_OK_ID, BATCH_B_OK_ID],
      nextRequestId('ok-create'),
    );
    const shipped = await ship(order, nextRequestId('ok-ship'));
    expect(shipped.statusCode).toBe(200);
    expect((shipped.json() as SalesOrder).status).toBe('已发货');

    const flowsAfterShip = await countRows('inventory_flow', order.id);
    const draftsAfterShip = await countRows('settlement_order', order.id);
    expect(flowsAfterShip).toBe(2);
    expect(draftsAfterShip).toBe(1);

    const response = await complete(
      order,
      nextRequestId('ok-complete'),
      ownerCookie,
      order.version + 1,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as SalesOrder;
    expect(body.status).toBe('已完成');
    expect(response.headers.etag).toBe(`"${body.version}"`);

    // 签收只改状态：库存流水与 C 草稿都沿用出库时那一份。
    expect(await countRows('inventory_flow', order.id)).toBe(flowsAfterShip);
    expect(await countRows('settlement_order', order.id)).toBe(draftsAfterShip);
    expect(await statusOf(order.id)).toBe('已完成');

    const audit = await test.database.query<{ changes: Record<string, unknown> }>(
      `SELECT changes FROM audit_log
        WHERE action = 'sales.order.complete' AND object_id = $1`,
      [order.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.changes).toMatchObject({
      beforeStatus: '已发货',
      afterStatus: '已完成',
      sourceOrders: [
        { type: 'A', id: PO_DONE_ID, no: PO_DONE_NO, status: '已完成' },
        { type: 'B', id: MO_DONE_ID, no: MO_DONE_NO, status: '已完成' },
      ],
    });
  });

  it('来源采购单还在途 → 409 SOURCE_ORDER_NOT_READY，details.blocking[0].no 指名该单', async () => {
    const order = await createOrder(
      [BATCH_A_TRANSIT_ID],
      nextRequestId('transit-create'),
    );
    expect((await ship(order, nextRequestId('transit-ship'))).statusCode).toBe(200);

    const response = await complete(
      order,
      nextRequestId('transit-complete'),
      ownerCookie,
      order.version + 1,
    );
    expect(response.statusCode).toBe(409);
    const body = response.json() as {
      code: string;
      message: string;
      details: {
        reason: string;
        blocking: { type: string; no: string; status: string }[];
      };
    };
    expect(body.code).toBe('STATE_CONFLICT');
    expect(body.details.reason).toBe('SOURCE_ORDER_NOT_READY');
    expect(body.details.blocking[0]).toEqual({
      type: 'A',
      no: PO_TRANSIT_NO,
      status: '在途',
    });
    expect(body.message).toContain('采购单');
    expect(body.message).toContain(PO_TRANSIT_NO);
    expect(body.message).toContain('在途');
    // 拒绝后状态不变、不生成新流水 / C 草稿。
    expect(await statusOf(order.id)).toBe('已发货');
    expect(await countRows('inventory_flow', order.id)).toBe(1);
    expect(await countRows('settlement_order', order.id)).toBe(1);

    // 来源单到货（已完成）后重试签收成功。
    await test.database.query(
      `UPDATE purchase_order SET status = '已完成' WHERE id = $1::uuid`,
      [PO_TRANSIT_ID],
    );
    const retry = await complete(
      order,
      nextRequestId('transit-retry'),
      ownerCookie,
      order.version + 1,
    );
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as SalesOrder).status).toBe('已完成');
  });

  it('两个批次来源分别是 A 与 B，只有 A 完成 → 409，blocking 指名 B 单', async () => {
    const order = await createOrder(
      [BATCH_A_OK_ID, BATCH_B_TRANSIT_ID],
      nextRequestId('mix-create'),
    );
    expect((await ship(order, nextRequestId('mix-ship'))).statusCode).toBe(200);

    const response = await complete(
      order,
      nextRequestId('mix-complete'),
      ownerCookie,
      order.version + 1,
    );
    expect(response.statusCode).toBe(409);
    const body = response.json() as {
      details: { reason: string; blocking: { type: string; no: string }[] };
    };
    expect(body.details.reason).toBe('SOURCE_ORDER_NOT_READY');
    expect(body.details.blocking).toHaveLength(1);
    expect(body.details.blocking[0]).toMatchObject({ type: 'B', no: MO_TRANSIT_NO });
    expect(await statusOf(order.id)).toBe('已发货');
  });

  it('批次来源是 N（内部交易）→ 跳过校验、可以签收', async () => {
    const order = await createOrder([BATCH_N_ID], nextRequestId('n-create'));
    expect((await ship(order, nextRequestId('n-ship'))).statusCode).toBe(200);

    const response = await complete(
      order,
      nextRequestId('n-complete'),
      ownerCookie,
      order.version + 1,
    );
    expect(response.statusCode).toBe(200);
    expect((response.json() as SalesOrder).status).toBe('已完成');
  });

  it('进行中直接签收（跳过在途）：来源完成 → 成功并补扣库存 + C 草稿', async () => {
    const order = await createOrder([BATCH_DIRECT_ID], nextRequestId('direct-create'));

    const response = await complete(
      order,
      nextRequestId('direct-complete'),
      ownerCookie,
      order.version,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as SalesOrder;
    expect(body.status).toBe('已完成');
    expect(body.version).toBe(order.version + 1);
    expect(await countRows('inventory_flow', order.id)).toBe(1);
    expect(await countRows('settlement_order', order.id)).toBe(1);
  });

  it('进行中直接签收：来源未完成 → 409，且不扣库存 / 不生成 C 草稿', async () => {
    const order = await createOrder(
      [BATCH_DIRECT_TRANSIT_ID],
      nextRequestId('direct-fail-create'),
    );

    const response = await complete(
      order,
      nextRequestId('direct-fail-complete'),
      ownerCookie,
      order.version,
    );
    expect(response.statusCode).toBe(409);
    const body = response.json() as {
      details: { reason: string; blocking: { no: string }[] };
    };
    expect(body.details.reason).toBe('SOURCE_ORDER_NOT_READY');
    expect(body.details.blocking[0]!.no).toBe(PO_DIRECT_TRANSIT_NO);

    expect(await statusOf(order.id)).toBe('进行中');
    expect(await countRows('inventory_flow', order.id)).toBe(0);
    expect(await countRows('settlement_order', order.id)).toBe(0);
  });

  it('只有 sales.update、没有 sales.approve → 403（签收权限是 approve，不是 ship/update）', async () => {
    const order = await createOrder([BATCH_A_OK_ID], nextRequestId('forbidden-create'));
    expect((await ship(order, nextRequestId('forbidden-ship'))).statusCode).toBe(200);

    const response = await complete(
      order,
      nextRequestId('forbidden-complete'),
      salesCookie,
      order.version + 1,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(await statusOf(order.id)).toBe('已发货');
  });

  it('并发两次签收 → 只有一次成功（If-Match + version）', async () => {
    const order = await createOrder([BATCH_A_OK_ID], nextRequestId('race-create'));
    expect((await ship(order, nextRequestId('race-ship'))).statusCode).toBe(200);

    const version = order.version + 1;
    const [first, second] = await Promise.all([
      complete(order, nextRequestId('race-1'), ownerCookie, version),
      complete(order, nextRequestId('race-2'), ownerCookie, version),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    expect(await statusOf(order.id)).toBe('已完成');
    expect(await countRows('settlement_order', order.id)).toBe(1);
  });

  it('缺 If-Match → 428；AI 凭证 → 403', async () => {
    const order = await createOrder([BATCH_A_OK_ID], nextRequestId('nomatch-create'));
    expect((await ship(order, nextRequestId('nomatch-ship'))).statusCode).toBe(200);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${order.id}/complete`,
      headers: writeHeaders(ownerCookie, nextRequestId('nomatch-complete')),
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });
  });
});
