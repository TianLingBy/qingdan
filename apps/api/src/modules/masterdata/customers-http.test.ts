import type { Customer } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * masterdata 客户 HTTP 层（D15 / D49 / D51 / D52① / D54 / D63）。
 *
 * 覆盖 routes.ts 的分派与 platform 统一错误映射：
 *   - 未认证 401、无 customer 权限 403、跨公司不可见 404 / 空列表；
 *   - create 201、detail 200，均回强 ETag `"<version>"`；update/delete 必须带 If-Match；
 *   - D49 keyword 只匹配名称/联系人/联系电话，不按 customer_no 检索；
 *   - D63 账期整数天且 >= 0：负数 422，0 合法；
 *   - D52① 停用属危险动作：AI 凭证 403 AI_ACTION_FORBIDDEN 且状态不变。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';

const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';
const WAREHOUSE_PHONE = '10000000004';
const OUTSIDE_PHONE = '10000000005';

const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000003';
const OUTSIDE_EMPLOYEE_ID = '01900000-0000-7000-8000-000000000025';
/** seed 里的「销售」岗位：有 customer.read/create/update，无 customer.delete。 */
const SALES_POSITION_ID = '01900000-0000-7000-8000-000000000013';

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

describe('masterdata 客户 HTTP（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  let warehouseCookie: string;
  let outsideCookie: string;

  async function createCustomer(
    cookie: string,
    requestId: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: writeHeaders(cookie, requestId),
      payload: { companyId: DEMO_IDS.companyId, ...payload },
    });
  }

  async function listCustomersRequest(cookie: string, requestId: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/customers${query}`,
      headers: readHeaders(cookie, requestId),
    });
  }

  let createSequence = 0;
  async function createOne(name: string, extra: Record<string, unknown> = {}): Promise<Customer> {
    createSequence += 1;
    const response = await createCustomer(ownerCookie, `req-cust-create-${createSequence}`, {
      name,
      ...extra,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Customer;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // 第二家公司 + 只绑定该公司的销售员工，用于跨公司隔离（D15）。
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
      [DEMO_IDS.tenantId, OUTSIDE_EMPLOYEE_ID, SECOND_COMPANY_ID, SALES_POSITION_ID],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-cust-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-cust-login-sales');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-cust-login-warehouse');
    outsideCookie = await login(app, OUTSIDE_PHONE, 'req-cust-login-outside');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 → 401 UNAUTHENTICATED', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/customers',
      headers: { 'x-request-id': 'req-cust-anonymous' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('无 customer 权限 → 403；销售无 customer.delete → 403', async () => {
    const noCustomer = await listCustomersRequest(warehouseCookie, 'req-cust-no-perm');
    expect(noCustomer.statusCode).toBe(403);
    expect(noCustomer.json()).toMatchObject({ code: 'FORBIDDEN' });

    const created = await createOne('HTTP权限客户');
    const noDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${created.id}`,
      headers: writeHeaders(salesCookie, 'req-cust-no-delete', { 'if-match': '"1"' }),
    });
    expect(noDelete.statusCode).toBe(403);
    expect(noDelete.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('创建 → 201 + 实体 + 强 ETag "<version>"；详情 → 200 + ETag', async () => {
    const response = await createCustomer(ownerCookie, 'req-cust-create-ok', {
      name: 'HTTP创建客户',
      customerNo: 'HTTP-CREATE-001',
      contactName: 'HTTP联系人',
      contactPhone: '13500001111',
      creditTermDays: 30,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers.etag).toMatch(/^"\d+"$/);

    const body = response.json() as Customer;
    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      name: 'HTTP创建客户',
      customerNo: 'HTTP-CREATE-001',
      contactName: 'HTTP联系人',
      contactPhone: '13500001111',
      creditTermDays: 30,
      status: '启用',
      version: 1,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${body.id}`,
      headers: readHeaders(ownerCookie, 'req-cust-detail-ok'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect(detail.json()).toMatchObject({ id: body.id, name: 'HTTP创建客户', version: 1 });
  });

  it('D49：keyword 命中名称/联系人/电话，不按 customer_no 检索', async () => {
    await createOne('HTTP青禾农场', {
      customerNo: 'HTTP-CUST-ZZZ-777',
      contactName: 'HTTP陈经理',
      contactPhone: '13911112222',
    });
    await createOne('HTTP南岸超市', { customerNo: 'HTTP-CUST-AAA-111' });

    const byName = await listCustomersRequest(
      ownerCookie,
      'req-cust-search-name',
      `?keyword=${encodeURIComponent('HTTP青禾')}`,
    );
    expect(byName.statusCode).toBe(200);
    expect((byName.json() as { items: Customer[] }).items.map((item) => item.name)).toEqual([
      'HTTP青禾农场',
    ]);

    const byContact = await listCustomersRequest(
      ownerCookie,
      'req-cust-search-contact',
      `?keyword=${encodeURIComponent('HTTP陈经理')}`,
    );
    expect((byContact.json() as { items: Customer[] }).items.map((item) => item.name)).toEqual([
      'HTTP青禾农场',
    ]);

    const byNo = await listCustomersRequest(
      ownerCookie,
      'req-cust-search-no',
      `?keyword=${encodeURIComponent('HTTP-CUST-ZZZ')}`,
    );
    expect(byNo.statusCode).toBe(200);
    expect((byNo.json() as { items: Customer[] }).items).toHaveLength(0);
  });

  it('D63：creditTermDays 负数 → 422；0 → 成功（现结）', async () => {
    const negative = await createCustomer(ownerCookie, 'req-cust-credit-negative', {
      name: 'HTTP负账期客户',
      creditTermDays: -1,
    });
    expect(negative.statusCode).toBe(422);
    expect(negative.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const zero = await createCustomer(ownerCookie, 'req-cust-credit-zero', {
      name: 'HTTP现结客户',
      creditTermDays: 0,
    });
    expect(zero.statusCode).toBe(201);
    expect((zero.json() as Customer).creditTermDays).toBe(0);

    const created = zero.json() as Customer;
    const updateNegative = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-cust-credit-update-negative', { 'if-match': '"1"' }),
      payload: { creditTermDays: -5 },
    });
    expect(updateNegative.statusCode).toBe(422);
    expect(updateNegative.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('update：缺 If-Match → 428；版本过期/弱 ETag → 409；成功回新 ETag', async () => {
    const created = await createOne('HTTP并发客户');

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-cust-update-428'),
      payload: { name: '缺少前置' },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-cust-update-409', { 'if-match': '"9"' }),
      payload: { name: '旧版本' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const weak = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-cust-update-weak', { 'if-match': '1' }),
      payload: { name: '弱 ETag' },
    });
    expect(weak.statusCode).toBe(409);
    expect(weak.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-cust-update-ok', { 'if-match': '"1"' }),
      payload: { name: 'HTTP并发客户改名', creditTermDays: 0 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({
      name: 'HTTP并发客户改名',
      creditTermDays: 0,
      version: 2,
    });

    const replay = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-cust-update-replay', { 'if-match': '"1"' }),
      payload: { name: '重复旧版本' },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('delete：软停用（status=停用、详情仍可读），成功后回新 ETag', async () => {
    const created = await createOne('HTTP软删客户');

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-cust-delete-428'),
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-cust-delete-ok', { 'if-match': '"1"' }),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.headers.etag).toBe('"2"');
    expect(deleted.json()).toMatchObject({ status: '停用', version: 2 });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-cust-delete-detail'),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as Customer).status).toBe('停用');
  });

  it('D15：跨公司不可见——详情 404、列表为空、创建到不可见公司 403', async () => {
    const created = await createOne('HTTP一司客户');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${created.id}`,
      headers: readHeaders(outsideCookie, 'req-cust-cross-detail'),
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ code: 'NOT_FOUND' });

    const list = await listCustomersRequest(
      outsideCookie,
      'req-cust-cross-list',
      `?keyword=${encodeURIComponent('HTTP一司客户')}`,
    );
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Customer[] }).items).toHaveLength(0);

    const createOutside = await createCustomer(outsideCookie, 'req-cust-cross-create', {
      companyId: DEMO_IDS.companyId,
      name: '越权创建客户',
    });
    expect(createOutside.statusCode).toBe(403);
    expect(createOutside.json()).toMatchObject({ code: 'FORBIDDEN' });

    // 反向：二司客户对一司普通员工（销售只绑定一司）同样不可见。
    const secondCompany = await createCustomer(outsideCookie, 'req-cust-cross-create-own', {
      companyId: SECOND_COMPANY_ID,
      name: 'HTTP二司客户',
    });
    expect(secondCompany.statusCode).toBe(201);
    const second = secondCompany.json() as Customer;

    const salesDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${second.id}`,
      headers: readHeaders(salesCookie, 'req-cust-cross-sales-detail'),
    });
    expect(salesDetail.statusCode).toBe(404);

    const salesList = await listCustomersRequest(
      salesCookie,
      'req-cust-cross-sales-list',
      `?keyword=${encodeURIComponent('HTTP二司客户')}`,
    );
    expect((salesList.json() as { items: Customer[] }).items).toHaveLength(0);
  });

  it('D52①：AI 凭证停用客户 → 403 AI_ACTION_FORBIDDEN，客户状态不变', async () => {
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-cust-ai-token'),
      payload: {
        name: 'HTTP Customer AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'customer', actions: ['read', 'delete'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const created = await createOne('HTTP AI客户');
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${created.id}`,
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 停用客户',
        'if-match': '"1"',
        'x-request-id': 'req-cust-ai-delete',
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'AI_ACTION_FORBIDDEN' });

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM customer WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.status).toBe('启用');
  });
});
