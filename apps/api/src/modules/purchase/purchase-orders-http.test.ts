import type { PurchaseOrder, PurchaseOrderDetail } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * purchase 采购单 HTTP 层（D15 / D16 / D21 / D39 / D51 / D52 / D52.1 / D54）。
 *
 * 覆盖 routes.ts 的分派与 platform 统一错误映射：
 *   - 未认证 401、无 purchase 写权限 403、跨公司不可见 404 / 空列表；
 *   - create 201 + 强 ETag，detail 200 + ETag + cancelable（D21）；
 *   - update / cancel 必须带 If-Match；缺失 428、弱 ETag / 旧版本 409；
 *   - 已完成不可改、不可取消（422）；有下游不可取消（409）；
 *   - D39 负数费用无备注 422；
 *   - D52.1 AI 凭证开单 / 取消 → 403 AI_ACTION_FORBIDDEN；
 *   - 写操作成功审计落 audit_log（D51），普通读不记。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';

const OWNER_PHONE = '10000000001';
const WAREHOUSE_PHONE = '10000000004';
const OUTSIDE_PHONE = '10000000005';

const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000403';
const OUTSIDE_EMPLOYEE_ID = '01900000-0000-7000-8000-000000000425';
const PURCHASE_POSITION_ID = '01900000-0000-7000-8000-000000000017';

const SUPPLIER_ID = '01900000-0000-7000-8000-000000000401';
const SUPPLIER_2_ID = '01900000-0000-7000-8000-000000000402';
const PRODUCT_ID = '01900000-0000-7000-8000-000000000411';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000000412';
const BATCH_ID = '01900000-0000-7000-8000-000000000421';
const FLOW_ID = '01900000-0000-7000-8000-000000000422';

const LINE = {
  productId: PRODUCT_ID,
  qty: '2',
  unitPrice: '12.5',
  amount: '25',
};

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

/** Cookie 认证的非安全请求需要同源 Origin（D59⑧）。 */
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

describe('purchase 采购单 HTTP（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let warehouseCookie: string;
  let outsideCookie: string;

  async function createOrder(
    requestId: string,
    payload: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        companyId: DEMO_IDS.companyId,
        supplierId: SUPPLIER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        ...payload,
      },
    });
  }

  async function createOne(requestId: string, payload: Record<string, unknown> = {}) {
    const response = await createOrder(requestId, payload);
    expect(response.statusCode).toBe(201);
    return response.json() as PurchaseOrder;
  }

  let sequence = 0;
  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-po-${prefix}-${sequence}`;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // 第二家公司 + 只绑定该公司的采购员工，用于跨公司隔离（D15）。
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [SECOND_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1, $2, '000005', $3, '外部员工', '在职', false)
       ON CONFLICT (id) DO NOTHING`,
      [OUTSIDE_EMPLOYEE_ID, DEMO_IDS.tenantId, OUTSIDE_PHONE],
    );
    await test.database.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [DEMO_IDS.tenantId, OUTSIDE_EMPLOYEE_ID, SECOND_COMPANY_ID, PURCHASE_POSITION_ID],
    );

    for (const [id, companyId, name] of [
      [SUPPLIER_ID, DEMO_IDS.companyId, 'HTTP采购供应商'],
      [SUPPLIER_2_ID, SECOND_COMPANY_ID, 'HTTP二司供应商'],
    ] as const) {
      await test.database.query(
        `INSERT INTO supplier
           (id, tenant_id, company_id, supplier_no, name, supplied_materials, status)
         VALUES ($1, $2, $3, NULL, $4, '{}', '启用')
         ON CONFLICT (id) DO NOTHING`,
        [id, DEMO_IDS.tenantId, companyId, name],
      );
    }
    for (const [id, name] of [
      [PRODUCT_ID, 'HTTP采购商品'],
      [PRODUCT_2_ID, 'HTTP采购商品二'],
    ] as const) {
      await test.database.query(
        `INSERT INTO product
           (id, tenant_id, company_id, product_no, name, aliases, unit, status)
         VALUES ($1, $2, $3, NULL, $4, '{}', '件', '启用')
         ON CONFLICT (id) DO NOTHING`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, name],
      );
    }

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-po-login-owner');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-po-login-warehouse');
    outsideCookie = await login(app, OUTSIDE_PHONE, 'req-po-login-outside');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 → 401；无 purchase.create → 403', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/purchase-orders',
      headers: { 'x-request-id': 'req-po-anonymous' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    // 纯仓管只有 purchase.read。
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/purchase-orders',
      headers: readHeaders(warehouseCookie, 'req-po-no-perm-list'),
    });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: writeHeaders(warehouseCookie, 'req-po-no-perm-create'),
      payload: {
        companyId: DEMO_IDS.companyId,
        supplierId: SUPPLIER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
      },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('开单 → 201 + 单号 + 金额聚合 + 强 ETag；详情 → 200 + cancelable；审计落库', async () => {
    const response = await createOrder(nextRequestId('create-ok'), {
      lines: [
        LINE,
        { productId: PRODUCT_2_ID, qty: '3', unitPrice: '1.5', amount: '4.5' },
      ],
      fees: [
        { feeName: '运费', qty: '2', unitPrice: '10', amount: '20', remark: null },
        { feeName: '供应商返利', qty: '1', unitPrice: '5', amount: '-5', remark: '返利' },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers.etag).toMatch(/^"\d+"$/);

    const body = response.json() as PurchaseOrder;
    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      supplierId: SUPPLIER_ID,
      supplierName: 'HTTP采购供应商',
      handlerId: DEMO_IDS.ownerEmployeeId,
      status: '进行中',
      version: 1,
    });
    expect(body.orderNo).toMatch(/^A-0001-\d{8}-\d{4}$/);
    expect(typeof body.goodsAmount).toBe('string');
    expect(Number(body.goodsAmount)).toBe(29.5);
    expect(Number(body.feeAmount)).toBe(15);
    expect(Number(body.totalAmount)).toBe(44.5);
    expect(body.lines).toHaveLength(2);
    expect(body.fees).toHaveLength(2);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders/${body.id}`,
      headers: readHeaders(ownerCookie, 'req-po-detail-ok'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect(detail.json()).toMatchObject({
      id: body.id,
      orderNo: body.orderNo,
      cancelable: { allowed: true, reason: null },
    });

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result FROM audit_log WHERE object_id = $1 AND action <> 'amount.detail'`,
      [body.id],
    );
    expect(audit.rows).toEqual([{ action: 'purchase.order.create', result: 'success' }]);

    const reads = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE action IN ('purchase.order.list.read', 'purchase.order.detail.read')`,
    );
    expect(reads.rows[0]?.count).toBe('0');
  });

  it('D39：负数费用无备注 → 422；D15：跨公司详情 404、列表为空', async () => {
    const badFee = await createOrder(nextRequestId('bad-fee'), {
      fees: [{ feeName: '返利', qty: '1', unitPrice: '5', amount: '-5' }],
    });
    expect(badFee.statusCode).toBe(422);
    expect(badFee.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const created = await createOne(nextRequestId('cross'));

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders/${created.id}`,
      headers: readHeaders(outsideCookie, 'req-po-cross-detail'),
    });
    expect(detail.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders?keyword=${encodeURIComponent(created.orderNo)}`,
      headers: readHeaders(outsideCookie, 'req-po-cross-list'),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: PurchaseOrder[] }).items).toHaveLength(0);

    // 列表过滤：供应商 + 状态 + 单号关键字。
    const ownerList = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders?supplierId=${SUPPLIER_ID}&status=${encodeURIComponent('进行中')}&keyword=${encodeURIComponent(created.orderNo)}`,
      headers: readHeaders(ownerCookie, 'req-po-list-filter'),
    });
    expect(ownerList.statusCode).toBe(200);
    const page = ownerList.json() as { items: PurchaseOrder[]; nextCursor: string | null };
    expect(page.items.map((item) => item.id)).toEqual([created.id]);
    expect(page.items[0]?.lines).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('修改：缺 If-Match 428、旧版本/弱 ETag 409、成功回新 ETag；已完成 422', async () => {
    const created = await createOne(nextRequestId('update'));

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/purchase-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-po-update-428'),
      payload: { handlerId: DEMO_IDS.ownerEmployeeId },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/purchase-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-po-update-409', { 'if-match': '"9"' }),
      payload: { handlerId: DEMO_IDS.ownerEmployeeId },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const weak = await app.inject({
      method: 'PATCH',
      url: `/api/v1/purchase-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-po-update-weak', { 'if-match': '1' }),
      payload: { handlerId: DEMO_IDS.ownerEmployeeId },
    });
    expect(weak.statusCode).toBe(409);
    expect(weak.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/purchase-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-po-update-ok', { 'if-match': '"1"' }),
      payload: {
        lines: [{ productId: PRODUCT_2_ID, qty: '4', unitPrice: '2.25', amount: '9' }],
        fees: [{ feeName: '杂费', qty: '1', unitPrice: '3', amount: '3' }],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({ version: 2 });
    expect(Number((ok.json() as PurchaseOrder).totalAmount)).toBe(12);

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE action = 'purchase.order.update' AND object_id = $1 AND result = 'success'`,
      [created.id],
    );
    expect(audit.rows[0]?.count).toBe('1');

    // 已完成单不可改（D4）。
    const completed = await createOne(nextRequestId('update-completed'));
    await test.database.query(`UPDATE purchase_order SET status = '已完成' WHERE id = $1`, [
      completed.id,
    ]);
    const rejected = await app.inject({
      method: 'PATCH',
      url: `/api/v1/purchase-orders/${completed.id}`,
      headers: writeHeaders(ownerCookie, 'req-po-update-completed', { 'if-match': '"1"' }),
      payload: { handlerId: DEMO_IDS.ownerEmployeeId },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('取消：缺 If-Match 428；有下游 409；已完成 422；成功置已取消 + 审计', async () => {
    const created = await createOne(nextRequestId('cancel'));

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${created.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-po-cancel-428'),
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${created.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-po-cancel-ok', { 'if-match': '"1"' }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({ status: '已取消', version: 2 });

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE action = 'purchase.order.cancel' AND object_id = $1 AND result = 'success'`,
      [created.id],
    );
    expect(audit.rows[0]?.count).toBe('1');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-po-cancel-detail'),
    });
    expect((detail.json() as PurchaseOrderDetail).cancelable).toEqual({
      allowed: false,
      reason: 'already_cancelled',
    });

    // 有直接下游（库存流水）→ D21 先取消下游。
    const withDownstream = await createOne(nextRequestId('cancel-downstream'));
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'PO-HTTP-DOWNSTREAM-1', '10', '10', '0', '0', '0', $5)`,
      [BATCH_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, PRODUCT_ID, DEMO_IDS.ownerEmployeeId],
    );
    await test.database.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id, handled_by)
       VALUES ($1, $2, $3, $4, '10', 'A', $5, $6)`,
      [FLOW_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, BATCH_ID, withDownstream.id, DEMO_IDS.ownerEmployeeId],
    );
    const downstream = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${withDownstream.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-po-cancel-downstream', { 'if-match': '"1"' }),
    });
    expect(downstream.statusCode).toBe(409);
    expect(downstream.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const completed = await createOne(nextRequestId('cancel-completed'));
    await test.database.query(`UPDATE purchase_order SET status = '已完成' WHERE id = $1`, [
      completed.id,
    ]);
    const completedCancel = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${completed.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-po-cancel-completed', { 'if-match': '"1"' }),
    });
    expect(completedCancel.statusCode).toBe(422);
    expect(completedCancel.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('D52.1：AI 凭证开单 / 取消 → 403 AI_ACTION_FORBIDDEN', async () => {
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-po-ai-token'),
      payload: {
        name: 'HTTP Purchase AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'purchase', actions: ['read', 'create', 'delete', 'view_price'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const createForbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 开单',
        'x-request-id': 'req-po-ai-create',
      },
      payload: {
        companyId: DEMO_IDS.companyId,
        supplierId: SUPPLIER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
      },
    });
    expect(createForbidden.statusCode).toBe(403);
    expect(createForbidden.json()).toMatchObject({ code: 'AI_ACTION_FORBIDDEN' });

    const target = await createOne(nextRequestId('ai-cancel'));
    const cancelForbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${target.id}/cancel`,
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 取消',
        'if-match': '"1"',
        'x-request-id': 'req-po-ai-cancel',
      },
    });
    expect(cancelForbidden.statusCode).toBe(403);
    expect(cancelForbidden.json()).toMatchObject({ code: 'AI_ACTION_FORBIDDEN' });

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM purchase_order WHERE id = $1',
      [target.id],
    );
    expect(row.rows[0]?.status).toBe('进行中');
  });
});
