import type { SalesOrder, SalesOrderDetail } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * sales 销售单 E HTTP 层（D15 / D16 / D20 / D21 / D22 / D51 / D52）。
 *
 * 覆盖 routes.ts 的 5 个 handler 注入、201 / 200 状态码、If-Match、
 * 审计失败留痕、D20 下限拒绝与 AI 危险动作拦截。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
const WAREHOUSE_PHONE = '10000000004';

const CUSTOMER_ID = '01900000-0000-7000-8000-000000004101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000004111';
const BATCH_A_ID = '01900000-0000-7000-8000-000000004121';
const BATCH_B_ID = '01900000-0000-7000-8000-000000004122';
const FLOW_ID = '01900000-0000-7000-8000-000000004131';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_A_ID, BATCH_B_ID],
  qty: '2',
  unitPrice: '15',
  amount: '999',
};

const FEE = {
  feeName: '运费',
  qty: '2',
  unitPrice: '5.5',
  amount: '999',
  remark: null,
};

function readHeaders(
  cookie: string,
  requestId: string,
): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(
  cookie: string,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie,
    origin: PUBLIC_BASE_URL,
    'x-request-id': requestId,
    ...extra,
  };
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

describe('sales 销售单 HTTP（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let warehouseCookie: string;

  async function createOrder(
    requestId: string,
    payload: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId: CUSTOMER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        fees: [FEE],
        ...payload,
      },
    });
  }

  async function createOne(
    requestId: string,
    payload: Record<string, unknown> = {},
  ): Promise<SalesOrder> {
    const response = await createOrder(requestId, payload);
    expect(response.statusCode).toBe(201);
    return response.json() as SalesOrder;
  }

  let sequence = 0;
  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-sales-${prefix}-${sequence}`;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, NULL, 'HTTP销售客户', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, 'HTTP销售商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E-HTTP-A', '10', '1000', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'E-HTTP-B', '20', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
        BATCH_B_ID,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-sales-login-owner');
    warehouseCookie = await login(
      app,
      WAREHOUSE_PHONE,
      'req-sales-login-warehouse',
    );
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 → 401；无 sales.read / sales.create → 403', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/sales-orders',
      headers: { 'x-request-id': 'req-sales-anonymous' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/sales-orders',
      headers: readHeaders(warehouseCookie, 'req-sales-no-perm-list'),
    });
    expect(list.statusCode).toBe(403);
    expect(list.json()).toMatchObject({ code: 'FORBIDDEN' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: writeHeaders(warehouseCookie, 'req-sales-no-perm-create'),
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId: CUSTOMER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
      },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('开单 → 201 + E 单号 + SQL 聚合 + 强 ETag；详情 / 列表 / 审计', async () => {
    const response = await createOrder(nextRequestId('create-ok'));
    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers.etag).toMatch(/^"\d+"$/);

    const body = response.json() as SalesOrder;
    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      customerId: CUSTOMER_ID,
      customerName: 'HTTP销售客户',
      handlerId: DEMO_IDS.ownerEmployeeId,
      status: '进行中',
      totalAmount: '41',
      version: 1,
    });
    expect(body.orderNo).toMatch(/^E-0001-\d{8}-\d{4}$/);
    expect(body.lines).toEqual([
      {
        productId: PRODUCT_ID,
        batchIds: [BATCH_A_ID, BATCH_B_ID],
        qty: '2',
        unitPrice: '15',
        amount: '30',
      },
    ]);
    expect(body.fees[0]?.amount).toBe('11');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/sales-orders/${body.id}`,
      headers: readHeaders(ownerCookie, 'req-sales-detail-ok'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect(detail.json()).toMatchObject({
      id: body.id,
      orderNo: body.orderNo,
      receipts: [],
      receiptBalance: '0',
      cancelable: { allowed: true, reason: null },
    });

    const list = await app.inject({
      method: 'GET',
      url:
        `/api/v1/sales-orders?customerId=${CUSTOMER_ID}` +
        `&status=${encodeURIComponent('进行中')}` +
        `&keyword=${encodeURIComponent(body.orderNo)}`,
      headers: readHeaders(ownerCookie, 'req-sales-list-ok'),
    });
    expect(list.statusCode).toBe(200);
    const page = list.json() as {
      items: SalesOrder[];
      nextCursor: string | null;
    };
    expect(page.items.map((item) => item.id)).toEqual([body.id]);
    expect(page.items[0]?.lines[0]?.batchIds).toEqual([BATCH_A_ID, BATCH_B_ID]);
    expect(page.nextCursor).toBeNull();

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result FROM audit_log WHERE object_id = $1 AND action <> 'amount.detail'`,
      [body.id],
    );
    expect(audit.rows).toEqual([
      { action: 'sales.order.create', result: 'success' },
    ]);

    const reads = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action IN ('sales.order.list.read', 'sales.order.detail.read')`,
    );
    expect(reads.rows[0]?.count).toBe('0');
  });

  it('负责人字段按身份脱敏：老板/经理可见 handlerId，销售返回 null（Issue #227）', async () => {
    const order = await createOne(nextRequestId('handler-mask-seed'));

    const managerCookie = await login(app, '10000000002', 'req-sales-manager-login');
    const salesCookie = await login(app, '10000000003', 'req-sales-sales-login');

    const listAs = async (cookie: string, requestId: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/sales-orders',
        headers: readHeaders(cookie, requestId),
      });

    const handlerOf = (response: Awaited<ReturnType<typeof listAs>>): string | null => {
      const page = response.json() as { items: Array<{ id: string; handlerId: string | null }> };
      return page.items.find((item) => item.id === order.id)?.handlerId ?? null;
    };

    const asOwner = await listAs(ownerCookie, 'req-sales-handler-owner');
    const asManager = await listAs(managerCookie, 'req-sales-handler-manager');
    const asSales = await listAs(salesCookie, 'req-sales-handler-sales');

    expect(asOwner.statusCode).toBe(200);
    expect(asManager.statusCode).toBe(200);
    expect(asSales.statusCode).toBe(200);

    expect(handlerOf(asOwner)).toBe(DEMO_IDS.ownerEmployeeId);
    expect(handlerOf(asManager)).toBe(DEMO_IDS.ownerEmployeeId);
    expect(handlerOf(asSales)).toBeNull();
  });

  it('D20 / D39：破下限、负数费用、非法商品 / 批次 → 422；失败写操作留审计', async () => {
    const belowFloor = await createOrder(nextRequestId('below-floor'), {
      lines: [{ ...LINE, unitPrice: '14.999999' }],
    });
    expect(belowFloor.statusCode).toBe(422);
    expect(belowFloor.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const badFee = await createOrder(nextRequestId('negative-fee'), {
      fees: [
        {
          feeName: '返利',
          qty: '1',
          unitPrice: '5',
          amount: '-5',
          remark: '禁止',
        },
      ],
    });
    expect(badFee.statusCode).toBe(422);
    expect(badFee.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const badBatch = await createOrder(nextRequestId('bad-batch'), {
      lines: [
        {
          ...LINE,
          batchIds: ['01900000-0000-7000-8000-000000004199'],
        },
      ],
    });
    expect(badBatch.statusCode).toBe(422);
    expect(badBatch.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const failures = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'sales.order.create'
          AND result = 'fail'`,
    );
    expect(Number(failures.rows[0]?.count)).toBeGreaterThanOrEqual(3);
  });

  it('修改 / 取消：缺 If-Match 428、旧版本 / 有下游 409、成功回新 ETag + 审计', async () => {
    const created = await createOne(nextRequestId('write-ok'));

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sales-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sales-update-428'),
      payload: { fees: [] },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sales-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sales-update-409', {
        'if-match': '"9"',
      }),
      payload: { fees: [] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sales-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sales-update-ok', {
        'if-match': '"1"',
      }),
      payload: {
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds: [BATCH_B_ID],
            qty: '1',
            unitPrice: '20',
            amount: '1',
          },
        ],
        fees: [],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe('"2"');
    expect(updated.json()).toMatchObject({
      version: 2,
      totalAmount: '20',
    });

    const withDownstream = await createOne(nextRequestId('cancel-downstream'));
    await test.database.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id, handled_by)
       VALUES ($1, $2, $3, $4, '-1', 'E', $5, $6)`,
      [
        FLOW_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        BATCH_A_ID,
        withDownstream.id,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
    const downstream = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${withDownstream.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-sales-cancel-downstream', {
        'if-match': '"1"',
      }),
    });
    expect(downstream.statusCode).toBe(409);
    expect(downstream.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${created.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-sales-cancel-ok', {
        'if-match': '"2"',
      }),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.headers.etag).toBe('"3"');
    expect(cancelled.json()).toMatchObject({ status: '已取消', version: 3 });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/sales-orders/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-sales-cancel-detail'),
    });
    expect((detail.json() as SalesOrderDetail).cancelable).toEqual({
      allowed: false,
      reason: 'already_cancelled',
    });

    const audits = await test.database.query<{ action: string }>(
      `SELECT action
         FROM audit_log
        WHERE object_id = $1
          AND result = 'success'
          AND action <> 'amount.detail'
        ORDER BY action`,
      [created.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      'sales.order.cancel',
      'sales.order.create',
      'sales.order.update',
    ]);
  });

  it('D52①：AI 凭证开单 / 取消 → 403 AI_ACTION_FORBIDDEN', async () => {
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-sales-ai-token'),
      payload: {
        name: 'HTTP Sales AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [
          { domain: 'sales', actions: ['read', 'create', 'update', 'delete', 'view_price'] },
        ],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const createForbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 开销售单',
        'x-request-id': 'req-sales-ai-create',
      },
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId: CUSTOMER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
      },
    });
    expect(createForbidden.statusCode).toBe(403);
    expect(createForbidden.json()).toMatchObject({
      code: 'AI_ACTION_FORBIDDEN',
    });

    const target = await createOne(nextRequestId('ai-cancel'));
    const cancelForbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${target.id}/cancel`,
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 取消销售单',
        'if-match': '"1"',
        'x-request-id': 'req-sales-ai-cancel',
      },
    });
    expect(cancelForbidden.statusCode).toBe(403);
    expect(cancelForbidden.json()).toMatchObject({
      code: 'AI_ACTION_FORBIDDEN',
    });
  });
});
