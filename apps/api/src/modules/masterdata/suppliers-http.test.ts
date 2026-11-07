import type { Supplier } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * masterdata 供应商 HTTP 层（D15 / D49 / D51 / D52① / D54）。
 *
 * 覆盖 routes.ts 的分派与 platform 统一错误映射：
 *   - 未认证 401、无 supplier 权限 403、跨公司不可见 404 / 空列表；
 *   - create 201、detail 200，均回强 ETag `"<version>"`；update/delete 必须带 If-Match；
 *   - D49 keyword 只匹配名称/联系人/联系电话，不按 supplier_no 检索；
 *   - 供货物料条目上限 20、单项 1-64 字：21 项 / 65 字 → 422；
 *   - D52① 停用属危险动作：AI 凭证 403 AI_ACTION_FORBIDDEN 且状态不变。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';

const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const WAREHOUSE_PHONE = '10000000004';
const OUTSIDE_PHONE = '10000000005';

const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000003';
const OUTSIDE_EMPLOYEE_ID = '01900000-0000-7000-8000-000000000025';
/** seed 里的「采购」岗位：有 supplier.read/create/update，无 supplier.delete。 */
const PURCHASE_POSITION_ID = '01900000-0000-7000-8000-000000000017';

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

describe('masterdata 供应商 HTTP（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let warehouseCookie: string;
  let outsideCookie: string;

  async function createSupplier(
    cookie: string,
    requestId: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: writeHeaders(cookie, requestId),
      payload: { companyId: DEMO_IDS.companyId, ...payload },
    });
  }

  async function listSuppliersRequest(cookie: string, requestId: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/suppliers${query}`,
      headers: readHeaders(cookie, requestId),
    });
  }

  let createSequence = 0;
  async function createOne(name: string, extra: Record<string, unknown> = {}): Promise<Supplier> {
    createSequence += 1;
    const response = await createSupplier(ownerCookie, `req-sup-create-${createSequence}`, {
      name,
      ...extra,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Supplier;
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

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-sup-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-sup-login-manager');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-sup-login-warehouse');
    outsideCookie = await login(app, OUTSIDE_PHONE, 'req-sup-login-outside');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 → 401 UNAUTHENTICATED', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/suppliers',
      headers: { 'x-request-id': 'req-sup-anonymous' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('无 supplier 权限 → 403 FORBIDDEN', async () => {
    // 纯仓管岗位没有 supplier.* 权限。
    const list = await listSuppliersRequest(warehouseCookie, 'req-sup-no-perm-list');
    expect(list.statusCode).toBe(403);
    expect(list.json()).toMatchObject({ code: 'FORBIDDEN' });

    const create = await createSupplier(warehouseCookie, 'req-sup-no-perm-create', {
      name: '无权创建供应商',
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('创建 → 201 + 实体 + 强 ETag "<version>"；详情 → 200 + ETag', async () => {
    const response = await createSupplier(ownerCookie, 'req-sup-create-ok', {
      name: 'HTTP创建供应商',
      supplierNo: 'HTTP-CREATE-001',
      contactName: 'HTTP联系人',
      contactPhone: '13500002222',
      suppliedMaterials: ['面粉', '白糖'],
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers.etag).toMatch(/^"\d+"$/);

    const body = response.json() as Supplier;
    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      name: 'HTTP创建供应商',
      supplierNo: 'HTTP-CREATE-001',
      contactName: 'HTTP联系人',
      contactPhone: '13500002222',
      suppliedMaterials: ['面粉', '白糖'],
      status: '启用',
      version: 1,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/suppliers/${body.id}`,
      headers: readHeaders(ownerCookie, 'req-sup-detail-ok'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect(detail.json()).toMatchObject({ id: body.id, name: 'HTTP创建供应商', version: 1 });
  });

  it('D49：keyword 命中名称/联系人/电话，不按 supplier_no 检索', async () => {
    await createOne('HTTP青禾供应商', {
      supplierNo: 'HTTP-SUP-ZZZ-777',
      contactName: 'HTTP陈经理',
      contactPhone: '13922223333',
    });
    await createOne('HTTP南岸商行', { supplierNo: 'HTTP-SUP-AAA-111' });

    const byName = await listSuppliersRequest(
      ownerCookie,
      'req-sup-search-name',
      `?keyword=${encodeURIComponent('HTTP青禾')}`,
    );
    expect(byName.statusCode).toBe(200);
    expect((byName.json() as { items: Supplier[] }).items.map((item) => item.name)).toEqual([
      'HTTP青禾供应商',
    ]);

    const byContact = await listSuppliersRequest(
      ownerCookie,
      'req-sup-search-contact',
      `?keyword=${encodeURIComponent('HTTP陈经理')}`,
    );
    expect((byContact.json() as { items: Supplier[] }).items.map((item) => item.name)).toEqual([
      'HTTP青禾供应商',
    ]);

    const byPhone = await listSuppliersRequest(
      ownerCookie,
      'req-sup-search-phone',
      `?keyword=${encodeURIComponent('13922223333')}`,
    );
    expect((byPhone.json() as { items: Supplier[] }).items.map((item) => item.name)).toEqual([
      'HTTP青禾供应商',
    ]);

    const byNo = await listSuppliersRequest(
      ownerCookie,
      'req-sup-search-no',
      `?keyword=${encodeURIComponent('HTTP-SUP-ZZZ')}`,
    );
    expect(byNo.statusCode).toBe(200);
    expect((byNo.json() as { items: Supplier[] }).items).toHaveLength(0);
  });

  it('供货物料：21 项 → 422；单项 65 字 → 422', async () => {
    const tooMany = await createSupplier(ownerCookie, 'req-sup-materials-many', {
      name: 'HTTP超量物料供应商',
      suppliedMaterials: Array.from({ length: 21 }, (_, index) => `物料${index + 1}`),
    });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const tooLong = await createSupplier(ownerCookie, 'req-sup-materials-long', {
      name: 'HTTP超长物料供应商',
      suppliedMaterials: ['x'.repeat(65)],
    });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('update：缺 If-Match → 428；版本过期/弱 ETag → 409；成功回新 ETag', async () => {
    const created = await createOne('HTTP并发供应商');

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/suppliers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sup-update-428'),
      payload: { name: '缺少前置' },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/suppliers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sup-update-409', { 'if-match': '"9"' }),
      payload: { name: '旧版本' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const weak = await app.inject({
      method: 'PATCH',
      url: `/api/v1/suppliers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sup-update-weak', { 'if-match': '1' }),
      payload: { name: '弱 ETag' },
    });
    expect(weak.statusCode).toBe(409);
    expect(weak.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/suppliers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sup-update-ok', { 'if-match': '"1"' }),
      payload: { name: 'HTTP并发供应商改名', suppliedMaterials: ['牛肉'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({
      name: 'HTTP并发供应商改名',
      suppliedMaterials: ['牛肉'],
      version: 2,
    });

    const replay = await app.inject({
      method: 'PATCH',
      url: `/api/v1/suppliers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sup-update-replay', { 'if-match': '"1"' }),
      payload: { name: '重复旧版本' },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('delete：缺 If-Match → 428；软停用成功回新 ETag，详情仍可读', async () => {
    const created = await createOne('HTTP软删供应商');

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/v1/suppliers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sup-delete-428'),
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/suppliers/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-sup-delete-ok', { 'if-match': '"1"' }),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.headers.etag).toBe('"2"');
    expect(deleted.json()).toMatchObject({ status: '停用', version: 2 });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/suppliers/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-sup-delete-detail'),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as Supplier).status).toBe('停用');
  });

  it('D15：跨公司不可见——详情 404、列表为空、创建到不可见公司 403', async () => {
    const created = await createOne('HTTP一司供应商');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/suppliers/${created.id}`,
      headers: readHeaders(outsideCookie, 'req-sup-cross-detail'),
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ code: 'NOT_FOUND' });

    const list = await listSuppliersRequest(
      outsideCookie,
      'req-sup-cross-list',
      `?keyword=${encodeURIComponent('HTTP一司供应商')}`,
    );
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Supplier[] }).items).toHaveLength(0);

    const createOutside = await createSupplier(outsideCookie, 'req-sup-cross-create', {
      companyId: DEMO_IDS.companyId,
      name: '越权创建供应商',
    });
    expect(createOutside.statusCode).toBe(403);
    expect(createOutside.json()).toMatchObject({ code: 'FORBIDDEN' });

    // 反向：二司供应商对只绑定一司的经理（有 supplier.read）同样不可见。
    const secondCompany = await createSupplier(outsideCookie, 'req-sup-cross-create-own', {
      companyId: SECOND_COMPANY_ID,
      name: 'HTTP二司供应商',
    });
    expect(secondCompany.statusCode).toBe(201);
    const second = secondCompany.json() as Supplier;

    const managerDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/suppliers/${second.id}`,
      headers: readHeaders(managerCookie, 'req-sup-cross-manager-detail'),
    });
    expect(managerDetail.statusCode).toBe(404);

    const managerList = await listSuppliersRequest(
      managerCookie,
      'req-sup-cross-manager-list',
      `?keyword=${encodeURIComponent('HTTP二司供应商')}`,
    );
    expect((managerList.json() as { items: Supplier[] }).items).toHaveLength(0);
  });

  it('D52①：AI 凭证停用供应商 → 403 AI_ACTION_FORBIDDEN，供应商状态不变', async () => {
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-sup-ai-token'),
      payload: {
        name: 'HTTP Supplier AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'supplier', actions: ['read', 'delete'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const created = await createOne('HTTP AI供应商');
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/suppliers/${created.id}`,
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 停用供应商',
        'if-match': '"1"',
        'x-request-id': 'req-sup-ai-delete',
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'AI_ACTION_FORBIDDEN' });

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM supplier WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.status).toBe('启用');
  });
});
