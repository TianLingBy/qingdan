import type {
  InternalTradeOrder,
  InternalTradeOrderDetail,
} from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * internal-trade N 单 HTTP 层（D15 / D16 / D21 / D22 / D51 / D52 / D68）。
 *
 * 覆盖 routes.ts 的 5 个 handler 注入、201 / 200 状态码、If-Match、
 * 独立四态校验、AI 危险动作拦截、SQL 计算金额与审计落库。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
const WAREHOUSE_PHONE = '10000000004';

const TO_COMPANY_ID = '01900000-0000-7000-8000-000000006101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000006111';
const BATCH_A_ID = '01900000-0000-7000-8000-000000006121';
const BATCH_B_ID = '01900000-0000-7000-8000-000000006122';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_A_ID, BATCH_B_ID],
  qty: '2',
  unitPrice: '15',
  amount: '999',
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

describe('internal-trade N 单 HTTP（PGlite + seed 演示租户）', () => {
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
      url: '/api/v1/internal-trade-orders',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        fromCompanyId: DEMO_IDS.companyId,
        toCompanyId: TO_COMPANY_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        internalPrice: '10.5',
        ...payload,
      },
    });
  }

  async function createOne(
    requestId: string,
    payload: Record<string, unknown> = {},
  ): Promise<InternalTradeOrder> {
    const response = await createOrder(requestId, payload);
    expect(response.statusCode).toBe(201);
    return response.json() as InternalTradeOrder;
  }

  let sequence = 0;
  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-internal-${prefix}-${sequence}`;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, 'HTTP内部交易接收公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [TO_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, 'HTTP内部交易商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'N-HTTP-A', '10', '1000', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'N-HTTP-B', '20', '1000', '0', '0', '0', $5)
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
    ownerCookie = await login(app, OWNER_PHONE, 'req-internal-login-owner');
    warehouseCookie = await login(
      app,
      WAREHOUSE_PHONE,
      'req-internal-login-warehouse',
    );
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 → 401；无 internal_trade.read / create → 403', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/internal-trade-orders',
      headers: { 'x-request-id': 'req-internal-anonymous' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/internal-trade-orders',
      headers: readHeaders(
        warehouseCookie,
        'req-internal-no-perm-list',
      ),
    });
    expect(list.statusCode).toBe(403);
    expect(list.json()).toMatchObject({ code: 'FORBIDDEN' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/internal-trade-orders',
      headers: writeHeaders(
        warehouseCookie,
        'req-internal-no-perm-create',
      ),
      payload: {
        fromCompanyId: DEMO_IDS.companyId,
        toCompanyId: TO_COMPANY_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        internalPrice: '10.5',
      },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('开单 → 201 + N 单号 + SQL 聚合 + 强 ETag；详情 / 列表 / 审计', async () => {
    const response = await createOrder(nextRequestId('create-ok'));
    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');

    const body = response.json() as InternalTradeOrder;
    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      fromCompanyId: DEMO_IDS.companyId,
      fromCompanyName: '演示公司',
      toCompanyId: TO_COMPANY_ID,
      toCompanyName: 'HTTP内部交易接收公司',
      handlerId: DEMO_IDS.ownerEmployeeId,
      status: '进行中',
      internalPrice: '10.5',
      inTransitQty: '2',
      version: 1,
    });
    expect(body.orderNo).toMatch(/^N-0001-\d{8}-\d{4}$/);
    expect(body.lines).toEqual([
      {
        productId: PRODUCT_ID,
        batchIds: [BATCH_A_ID, BATCH_B_ID],
        qty: '2',
        unitPrice: '15',
        amount: '30',
      },
    ]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/internal-trade-orders/${body.id}`,
      headers: readHeaders(ownerCookie, 'req-internal-detail-ok'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect(detail.json()).toMatchObject({
      id: body.id,
      orderNo: body.orderNo,
      cancelable: { allowed: true, reason: null },
    });

    const list = await app.inject({
      method: 'GET',
      url:
        `/api/v1/internal-trade-orders?fromCompanyId=${DEMO_IDS.companyId}` +
        `&toCompanyId=${TO_COMPANY_ID}` +
        `&status=${encodeURIComponent('进行中')}` +
        `&keyword=${encodeURIComponent(body.orderNo)}`,
      headers: readHeaders(ownerCookie, 'req-internal-list-ok'),
    });
    expect(list.statusCode).toBe(200);
    const page = list.json() as {
      items: InternalTradeOrder[];
      nextCursor: string | null;
    };
    expect(page.items.map((item) => item.id)).toEqual([body.id]);
    expect(page.items[0]?.lines[0]?.amount).toBe('30');
    expect(page.nextCursor).toBeNull();

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result FROM audit_log WHERE object_id = $1`,
      [body.id],
    );
    expect(audit.rows).toEqual([
      { action: 'internal_trade.order.create', result: 'success' },
    ]);

    const reads = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action IN (
          'internal_trade.order.list.read',
          'internal_trade.order.detail.read'
        )`,
    );
    expect(reads.rows[0]?.count).toBe('0');
  });

  it('批次归属 / 公司可见性 → 422；AI 开单 / 取消 → 403；失败审计留痕', async () => {
    const badBatch = await createOrder(nextRequestId('bad-batch'), {
      lines: [
        {
          ...LINE,
          batchIds: ['01900000-0000-7000-8000-000000006199'],
        },
      ],
    });
    expect(badBatch.statusCode).toBe(422);
    expect(badBatch.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const sameCompany = await createOrder(nextRequestId('same-company'), {
      toCompanyId: DEMO_IDS.companyId,
    });
    expect(sameCompany.statusCode).toBe(422);
    expect(sameCompany.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-internal-ai-token'),
      payload: {
        name: 'HTTP Internal Trade AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [
          {
            domain: 'internal_trade',
            actions: ['read', 'create', 'update', 'delete'],
          },
        ],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const createForbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/internal-trade-orders',
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 开内部交易单',
        'x-request-id': 'req-internal-ai-create',
      },
      payload: {
        fromCompanyId: DEMO_IDS.companyId,
        toCompanyId: TO_COMPANY_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        internalPrice: '10.5',
      },
    });
    expect(createForbidden.statusCode).toBe(403);
    expect(createForbidden.json()).toMatchObject({
      code: 'AI_ACTION_FORBIDDEN',
    });

    const target = await createOne(nextRequestId('ai-cancel'));
    const cancelForbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/internal-trade-orders/${target.id}/cancel`,
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 取消内部交易单',
        'if-match': '"1"',
        'x-request-id': 'req-internal-ai-cancel',
      },
    });
    expect(cancelForbidden.statusCode).toBe(403);
    expect(cancelForbidden.json()).toMatchObject({
      code: 'AI_ACTION_FORBIDDEN',
    });

    const failures = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action IN (
          'internal_trade.order.create',
          'internal_trade.order.cancel'
        )
          AND result = 'fail'`,
    );
    expect(Number(failures.rows[0]?.count)).toBeGreaterThanOrEqual(4);
  });

  it('修改 / 取消：缺 If-Match 428、旧版本 409、四态流转、AI 修改放行', async () => {
    const created = await createOne(nextRequestId('write-ok'));

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/internal-trade-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-internal-update-428'),
      payload: { internalPrice: '20' },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/internal-trade-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-internal-update-409', {
        'if-match': '"9"',
      }),
      payload: { internalPrice: '20' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/internal-trade-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-internal-update-ok', {
        'if-match': '"1"',
      }),
      payload: {
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds: [BATCH_B_ID],
            qty: '3',
            unitPrice: '20',
            amount: '1',
          },
        ],
        internalPrice: '18.25',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe('"2"');
    expect(updated.json()).toMatchObject({
      version: 2,
      internalPrice: '18.25',
      inTransitQty: '3',
      lines: [
        {
          batchIds: [BATCH_B_ID],
          amount: '60',
        },
      ],
    });

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-internal-ai-update-token'),
      payload: {
        name: 'HTTP Internal Trade AI Update Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'internal_trade', actions: ['update'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const aiUpdated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/internal-trade-orders/${created.id}`,
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 修改内部交易单',
        'if-match': '"2"',
        'x-request-id': 'req-internal-ai-update',
      },
      payload: { handlerId: DEMO_IDS.managerEmployeeId },
    });
    expect(aiUpdated.statusCode).toBe(200);
    expect(aiUpdated.headers.etag).toBe('"3"');
    expect(aiUpdated.json()).toMatchObject({
      handlerId: DEMO_IDS.managerEmployeeId,
      version: 3,
    });

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/internal-trade-orders/${created.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-internal-cancel-ok', {
        'if-match': '"3"',
      }),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.headers.etag).toBe('"4"');
    expect(cancelled.json()).toMatchObject({
      status: '已取消',
      version: 4,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/internal-trade-orders/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-internal-cancel-detail'),
    });
    expect((detail.json() as InternalTradeOrderDetail).cancelable).toEqual({
      allowed: false,
      reason: 'already_cancelled',
    });

    const inTransit = await createOne(nextRequestId('in-transit'));
    await test.database.query(
      `UPDATE internal_trade_order SET status = '在途' WHERE id = $1`,
      [inTransit.id],
    );
    const updateInTransit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/internal-trade-orders/${inTransit.id}`,
      headers: writeHeaders(ownerCookie, 'req-internal-update-transit', {
        'if-match': '"1"',
      }),
      payload: { internalPrice: '22' },
    });
    expect(updateInTransit.statusCode).toBe(422);
    expect(updateInTransit.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    const cancelInTransit = await app.inject({
      method: 'POST',
      url: `/api/v1/internal-trade-orders/${inTransit.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-internal-cancel-transit', {
        'if-match': '"1"',
      }),
    });
    expect(cancelInTransit.statusCode).toBe(200);
    expect(cancelInTransit.json()).toMatchObject({
      status: '已取消',
      version: 2,
    });

    const audits = await test.database.query<{ action: string }>(
      `SELECT action
         FROM audit_log
        WHERE object_id = $1
          AND result = 'success'
        ORDER BY action`,
      [created.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      'internal_trade.order.cancel',
      'internal_trade.order.create',
      'internal_trade.order.update',
      'internal_trade.order.update',
    ]);
  });
});
