import type { Product } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * masterdata 商品 HTTP 层（D15 / D27 / D49 / D51 / D52① / D54）。
 *
 * 覆盖 routes.ts 的分派与 platform 统一错误映射：
 *   - 未认证 401、无 product 权限 403、找不到/跨公司 404、版本冲突 409、参数非法 422；
 *   - detail/create 回强 ETag `"<version>"`；update/delete 必须带 If-Match；
 *   - D49 keyword 只匹配名称/别名，不按 product_no 检索；
 *   - D27 无看价权限时 defaultSalePrice 为 null；
 *   - 软删除：status 置停用、详情仍可读；列表需显式 `status=启用` 才排除停用商品。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';

const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';
const WAREHOUSE_PHONE = '10000000004';
const OUTSIDE_PHONE = '10000000005';

const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000003';
const OUTSIDE_EMPLOYEE_ID = '01900000-0000-7000-8000-000000000025';
/** seed 里的「销售」岗位：有 product.read，无 product.create/update/delete/view_price。 */
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

describe('masterdata 商品 HTTP（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  let warehouseCookie: string;
  let outsideCookie: string;

  async function createProduct(
    cookie: string,
    requestId: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: writeHeaders(cookie, requestId),
      payload: { companyId: DEMO_IDS.companyId, unit: '件', ...payload },
    });
  }

  async function listProductsRequest(cookie: string, requestId: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/products${query}`,
      headers: readHeaders(cookie, requestId),
    });
  }

  let createSequence = 0;
  async function createOne(name: string, extra: Record<string, unknown> = {}): Promise<Product> {
    // request id 保持 ASCII：测试里用它聚合审计行，不把中文商品名塞进头部。
    createSequence += 1;
    const response = await createProduct(ownerCookie, `req-http-create-${createSequence}`, {
      name,
      ...extra,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Product;
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
    ownerCookie = await login(app, OWNER_PHONE, 'req-http-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-http-login-sales');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-http-login-warehouse');
    outsideCookie = await login(app, OUTSIDE_PHONE, 'req-http-login-outside');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 → 401 UNAUTHENTICATED', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { 'x-request-id': 'req-http-anonymous' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('无 product 权限 → 403；只读岗位写商品 → 403', async () => {
    const noProduct = await listProductsRequest(warehouseCookie, 'req-http-no-product');
    expect(noProduct.statusCode).toBe(403);
    expect(noProduct.json()).toMatchObject({ code: 'FORBIDDEN' });

    const readOnlyWrite = await createProduct(salesCookie, 'req-http-readonly-write', {
      name: '只读岗位越权创建',
    });
    expect(readOnlyWrite.statusCode).toBe(403);
    expect(readOnlyWrite.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('创建 → 201 + 实体 + 强 ETag "<version>"', async () => {
    const response = await createProduct(ownerCookie, 'req-http-create-ok', {
      name: 'HTTP创建商品',
      productNo: 'HTTP-CREATE-001',
      aliases: ['创建别名'],
      specification: '500g/袋',
      defaultSalePrice: '12.50',
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers.etag).toMatch(/^"\d+"$/);

    const body = response.json() as Product;
    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      name: 'HTTP创建商品',
      productNo: 'HTTP-CREATE-001',
      aliases: ['创建别名'],
      specification: '500g/袋',
      unit: '件',
      status: '启用',
      version: 1,
    });
    expect(typeof body.defaultSalePrice).toBe('string');
    expect(Number(body.defaultSalePrice)).toBe(12.5);
    expect(body).not.toHaveProperty('cost');
  });

  it('D49：keyword 命中名称/别名，不按 product_no 检索', async () => {
    await createOne('HTTP香蕉', { productNo: 'HTTP-BANANA-001' });
    await createOne('HTTP翠玉梨', { productNo: 'HTTP-PEAR-001', aliases: ['HTTP梨子'] });

    const byName = await listProductsRequest(
      ownerCookie,
      'req-http-search-name',
      `?keyword=${encodeURIComponent('HTTP翠玉')}`,
    );
    expect(byName.statusCode).toBe(200);
    expect((byName.json() as { items: Product[] }).items.map((item) => item.name)).toEqual([
      'HTTP翠玉梨',
    ]);

    const byAlias = await listProductsRequest(
      ownerCookie,
      'req-http-search-alias',
      `?keyword=${encodeURIComponent('HTTP梨子')}`,
    );
    expect((byAlias.json() as { items: Product[] }).items.map((item) => item.name)).toEqual([
      'HTTP翠玉梨',
    ]);

    const byNo = await listProductsRequest(
      ownerCookie,
      'req-http-search-no',
      `?keyword=${encodeURIComponent('HTTP-BANANA')}`,
    );
    expect((byNo.json() as { items: Product[] }).items).toHaveLength(0);
  });

  it('D27：无看价权限时详情/列表的 defaultSalePrice 为 null', async () => {
    const created = await createOne('HTTP看价商品', { defaultSalePrice: '9.90' });

    const masked = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${created.id}`,
      headers: readHeaders(salesCookie, 'req-http-price-masked'),
    });
    expect(masked.statusCode).toBe(200);
    expect(masked.headers.etag).toBe('"1"');
    const maskedBody = masked.json() as Product;
    expect(maskedBody).toHaveProperty('defaultSalePrice');
    expect(maskedBody.defaultSalePrice).toBeNull();
    expect(maskedBody.name).toBe('HTTP看价商品');

    const ownerView = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-http-price-owner'),
    });
    expect(ownerView.statusCode).toBe(200);
    expect(ownerView.headers.etag).toBe('"1"');
    expect(Number((ownerView.json() as Product).defaultSalePrice)).toBe(9.9);

    const list = await listProductsRequest(
      salesCookie,
      'req-http-price-list',
      `?keyword=${encodeURIComponent('HTTP看价商品')}`,
    );
    const item = (list.json() as { items: Product[] }).items.find((entry) => entry.id === created.id);
    expect(item?.defaultSalePrice).toBeNull();
  });

  it('update：缺 If-Match → 428；版本过期/弱 ETag → 409；成功回新 ETag', async () => {
    const created = await createOne('HTTP并发商品');

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-http-update-428'),
      payload: { name: '缺少前置' },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-http-update-409', { 'if-match': '"9"' }),
      payload: { name: '旧版本' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const weak = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-http-update-weak', { 'if-match': '1' }),
      payload: { name: '弱 ETag' },
    });
    expect(weak.statusCode).toBe(409);
    expect(weak.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-http-update-ok', { 'if-match': '"1"' }),
      payload: { name: 'HTTP并发商品改名', aliases: ['并发别名'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({
      name: 'HTTP并发商品改名',
      aliases: ['并发别名'],
      version: 2,
    });

    const replay = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-http-update-replay', { 'if-match': '"1"' }),
      payload: { name: '重复旧版本' },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('delete：软停用（status=停用、详情仍可读、启用列表排除），成功后回新 ETag', async () => {
    const created = await createOne('HTTP软删商品');

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-http-delete-428'),
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-http-delete-ok', { 'if-match': '"1"' }),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.headers.etag).toBe('"2"');
    expect(deleted.json()).toMatchObject({ status: '停用', version: 2 });

    // 软删除：行还在，详情按 id 仍可读（调用方用 status 决定是否展示）。
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-http-delete-detail'),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as Product).status).toBe('停用');

    // 单据选对象场景显式带 status=启用：停用商品不再出现。
    const enabled = await listProductsRequest(
      ownerCookie,
      'req-http-delete-enabled-list',
      `?keyword=${encodeURIComponent('HTTP软删商品')}&status=${encodeURIComponent('启用')}`,
    );
    expect((enabled.json() as { items: Product[] }).items).toHaveLength(0);

    // 不带 status 时列表仍返回该行（仓库层只按显式过滤条件筛选，不隐式排除停用）。
    const all = await listProductsRequest(
      ownerCookie,
      'req-http-delete-all-list',
      `?keyword=${encodeURIComponent('HTTP软删商品')}`,
    );
    expect((all.json() as { items: Product[] }).items.map((item) => item.id)).toEqual([created.id]);
  });

  it('D15：跨公司不可见——详情 404、列表为空、创建到不可见公司 403', async () => {
    const created = await createOne('HTTP一司商品');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${created.id}`,
      headers: readHeaders(outsideCookie, 'req-http-cross-detail'),
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ code: 'NOT_FOUND' });

    const list = await listProductsRequest(
      outsideCookie,
      'req-http-cross-list',
      `?keyword=${encodeURIComponent('HTTP一司商品')}`,
    );
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Product[] }).items).toHaveLength(0);

    const createOutside = await createProduct(outsideCookie, 'req-http-cross-create', {
      companyId: DEMO_IDS.companyId,
      name: '越权创建商品',
    });
    expect(createOutside.statusCode).toBe(403);
    expect(createOutside.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('D52①：AI 凭证停用商品 → 403 AI_ACTION_FORBIDDEN，商品状态不变', async () => {
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-http-ai-token'),
      payload: {
        name: 'HTTP AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'product', actions: ['read', 'delete'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const created = await createOne('HTTP AI商品');
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${created.id}`,
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 停用',
        'if-match': '"1"',
        'x-request-id': 'req-http-ai-delete',
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'AI_ACTION_FORBIDDEN' });

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM product WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.status).toBe('启用');
  });
});
