import type { Processor, ProcessorQuote } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * masterdata 加工厂 + 报价 HTTP 层（D15 / D49 / D51 / D52① / D54 / D64）。
 *
 * 覆盖 routes.ts 的分派与 platform 统一错误映射：
 *   - 未认证 401、无 processor 权限 403、跨公司不可见 404 / 空列表；
 *   - 加工厂 create 201、detail 200，均回强 ETag `"<version>"`；update/delete 必须带 If-Match；
 *   - D49 keyword 只匹配名称/联系人，不按 processor_no 检索；
 *   - D64① 主表只存基础资料：响应里没有任何价格键；
 *   - D64③ 报价按工序 + 日期区间过滤，跨加工厂按单价升序比价；
 *   - D64④ 报价只增不改：`/processor-quotes/{id}` 没有 PATCH / DELETE 路由；
 *   - D52① 停用加工厂属危险动作：AI 凭证 403 AI_ACTION_FORBIDDEN 且状态不变。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';

const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const WAREHOUSE_PHONE = '10000000004';
const OUTSIDE_PHONE = '10000000005';

const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000003';
const OUTSIDE_EMPLOYEE_ID = '01900000-0000-7000-8000-000000000025';
/** seed 里的「老板」岗位：全权限，用于给外部员工在二司授予 processor 权限。 */
const OWNER_POSITION_ID = '01900000-0000-7000-8000-000000000011';

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

/** D64①：主表响应不得出现任何价格键（unitPrice / price / processingPrice 等）。 */
function priceKeysOf(entity: object): string[] {
  return Object.keys(entity).filter((key) => /price/i.test(key));
}

describe('masterdata 加工厂 + 报价 HTTP（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let warehouseCookie: string;
  let outsideCookie: string;

  async function createProcessor(
    cookie: string,
    requestId: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/processors',
      headers: writeHeaders(cookie, requestId),
      payload: { companyId: DEMO_IDS.companyId, ...payload },
    });
  }

  async function listProcessorsRequest(cookie: string, requestId: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/processors${query}`,
      headers: readHeaders(cookie, requestId),
    });
  }

  async function createQuote(
    cookie: string,
    requestId: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/processor-quotes',
      headers: writeHeaders(cookie, requestId),
      payload: { companyId: DEMO_IDS.companyId, ...payload },
    });
  }

  async function listQuotesRequest(cookie: string, requestId: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/processor-quotes${query}`,
      headers: readHeaders(cookie, requestId),
    });
  }

  let createSequence = 0;
  async function createOne(
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<Processor> {
    createSequence += 1;
    const response = await createProcessor(ownerCookie, `req-proc-create-${createSequence}`, {
      name,
      ...extra,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Processor;
  }

  let quoteSequence = 0;
  async function createOneQuote(
    processorId: string,
    payload: Record<string, unknown>,
  ): Promise<ProcessorQuote> {
    quoteSequence += 1;
    const response = await createQuote(ownerCookie, `req-quote-create-${quoteSequence}`, {
      processorId,
      ...payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as ProcessorQuote;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // 第二家公司 + 只绑定该公司的全权限员工，用于跨公司隔离（D15）。
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
      [DEMO_IDS.tenantId, OUTSIDE_EMPLOYEE_ID, SECOND_COMPANY_ID, OWNER_POSITION_ID],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-proc-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-proc-login-manager');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-proc-login-warehouse');
    outsideCookie = await login(app, OUTSIDE_PHONE, 'req-proc-login-outside');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 → 401 UNAUTHENTICATED', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/processors',
      headers: { 'x-request-id': 'req-proc-anonymous' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('无 processor 权限 → 403 FORBIDDEN', async () => {
    // 纯仓管岗位没有 processor.* 权限。
    const list = await listProcessorsRequest(warehouseCookie, 'req-proc-no-perm-list');
    expect(list.statusCode).toBe(403);
    expect(list.json()).toMatchObject({ code: 'FORBIDDEN' });

    const create = await createProcessor(warehouseCookie, 'req-proc-no-perm-create', {
      name: '无权创建加工厂',
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ code: 'FORBIDDEN' });

    const quotes = await listQuotesRequest(warehouseCookie, 'req-proc-no-perm-quotes');
    expect(quotes.statusCode).toBe(403);
    expect(quotes.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('创建 → 201 + 实体 + 强 ETag "<version>"；详情 → 200 + ETag', async () => {
    const response = await createProcessor(ownerCookie, 'req-proc-create-ok', {
      name: 'HTTP创建加工厂',
      processorNo: 'HTTP-PROC-CREATE-001',
      contactName: 'HTTP张师傅',
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers.etag).toMatch(/^"\d+"$/);

    const body = response.json() as Processor;
    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      name: 'HTTP创建加工厂',
      processorNo: 'HTTP-PROC-CREATE-001',
      contactName: 'HTTP张师傅',
      status: '启用',
      version: 1,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/processors/${body.id}`,
      headers: readHeaders(ownerCookie, 'req-proc-detail-ok'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect(detail.json()).toMatchObject({
      id: body.id,
      name: 'HTTP创建加工厂',
      version: 1,
    });
  });

  it('D49：keyword 命中名称/联系人，不按 processor_no 检索', async () => {
    await createOne('HTTP青禾加工厂', {
      processorNo: 'HTTP-PROC-ZZZ-777',
      contactName: 'HTTP陈师傅',
    });
    await createOne('HTTP南岸加工厂', { processorNo: 'HTTP-PROC-AAA-111' });

    const byName = await listProcessorsRequest(
      ownerCookie,
      'req-proc-search-name',
      `?keyword=${encodeURIComponent('HTTP青禾')}`,
    );
    expect(byName.statusCode).toBe(200);
    expect((byName.json() as { items: Processor[] }).items.map((item) => item.name)).toEqual([
      'HTTP青禾加工厂',
    ]);

    const byContact = await listProcessorsRequest(
      ownerCookie,
      'req-proc-search-contact',
      `?keyword=${encodeURIComponent('HTTP陈师傅')}`,
    );
    expect((byContact.json() as { items: Processor[] }).items.map((item) => item.name)).toEqual([
      'HTTP青禾加工厂',
    ]);

    const byNo = await listProcessorsRequest(
      ownerCookie,
      'req-proc-search-no',
      `?keyword=${encodeURIComponent('HTTP-PROC-ZZZ')}`,
    );
    expect(byNo.statusCode).toBe(200);
    expect((byNo.json() as { items: Processor[] }).items).toHaveLength(0);
  });

  it('update：缺 If-Match → 428；版本过期/弱 ETag → 409；成功回新 ETag', async () => {
    const created = await createOne('HTTP并发加工厂');

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processors/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-proc-update-428'),
      payload: { name: '缺少前置' },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processors/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-proc-update-409', { 'if-match': '"9"' }),
      payload: { name: '旧版本' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const weak = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processors/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-proc-update-weak', { 'if-match': '1' }),
      payload: { name: '弱 ETag' },
    });
    expect(weak.statusCode).toBe(409);
    expect(weak.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processors/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-proc-update-ok', { 'if-match': '"1"' }),
      payload: { name: 'HTTP并发加工厂改名', contactName: 'HTTP李师傅' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({
      name: 'HTTP并发加工厂改名',
      contactName: 'HTTP李师傅',
      version: 2,
    });
  });

  it('delete：缺 If-Match → 428；软停用成功回新 ETag，详情仍可读', async () => {
    const created = await createOne('HTTP软删加工厂');

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/v1/processors/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-proc-delete-428'),
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/processors/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-proc-delete-ok', { 'if-match': '"1"' }),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.headers.etag).toBe('"2"');
    expect(deleted.json()).toMatchObject({ status: '停用', version: 2 });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/processors/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-proc-delete-detail'),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as Processor).status).toBe('停用');
  });

  it('D15：跨公司不可见——详情 404、列表为空、创建到不可见公司 403', async () => {
    const created = await createOne('HTTP一司加工厂');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/processors/${created.id}`,
      headers: readHeaders(outsideCookie, 'req-proc-cross-detail'),
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ code: 'NOT_FOUND' });

    const list = await listProcessorsRequest(
      outsideCookie,
      'req-proc-cross-list',
      `?keyword=${encodeURIComponent('HTTP一司加工厂')}`,
    );
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Processor[] }).items).toHaveLength(0);

    const createOutside = await createProcessor(outsideCookie, 'req-proc-cross-create', {
      companyId: DEMO_IDS.companyId,
      name: '越权创建加工厂',
    });
    expect(createOutside.statusCode).toBe(403);
    expect(createOutside.json()).toMatchObject({ code: 'FORBIDDEN' });

    // 反向：二司加工厂对只绑定一司的经理（有 processor.read）同样不可见。
    const secondCompany = await createProcessor(outsideCookie, 'req-proc-cross-create-own', {
      companyId: SECOND_COMPANY_ID,
      name: 'HTTP二司加工厂',
    });
    expect(secondCompany.statusCode).toBe(201);
    const second = secondCompany.json() as Processor;

    const managerDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/processors/${second.id}`,
      headers: readHeaders(managerCookie, 'req-proc-cross-manager-detail'),
    });
    expect(managerDetail.statusCode).toBe(404);

    const managerList = await listProcessorsRequest(
      managerCookie,
      'req-proc-cross-manager-list',
      `?keyword=${encodeURIComponent('HTTP二司加工厂')}`,
    );
    expect((managerList.json() as { items: Processor[] }).items).toHaveLength(0);
  });

  it('D64①：主表只存基础资料——响应无价格键，表结构无价格列', async () => {
    const created = await createOne('HTTP无价加工厂', {
      processorNo: 'HTTP-PROC-NOPRICE',
      contactName: 'HTTP王师傅',
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/processors/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-proc-noprice-detail'),
    });
    expect(detail.statusCode).toBe(200);
    expect(priceKeysOf(detail.json() as object)).toEqual([]);

    const list = await listProcessorsRequest(
      ownerCookie,
      'req-proc-noprice-list',
      `?keyword=${encodeURIComponent('HTTP无价加工厂')}`,
    );
    const items = (list.json() as { items: Processor[] }).items;
    expect(items).toHaveLength(1);
    expect(priceKeysOf(items[0]!)).toEqual([]);

    const columns = await test.database.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'processor'
          AND column_name ILIKE '%price%'`,
    );
    expect(columns.rows).toHaveLength(0);
  });

  it('报价 create → 201 + 实体 + 强 ETag，单价保 decimal 字符串', async () => {
    const processor = await createOne('HTTP报价加工厂');

    const response = await createQuote(ownerCookie, 'req-quote-create-ok', {
      processorId: processor.id,
      quoteDate: '2026-01-31',
      processName: 'HTTP切割',
      unitPrice: '12.5',
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');

    const body = response.json() as ProcessorQuote;
    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      processorId: processor.id,
      quoteDate: '2026-01-31',
      processName: 'HTTP切割',
      unitPrice: '12.500000',
      remark: null,
      version: 1,
    });
  });

  it('D64③：报价列表按 processName + 日期区间过滤（两端包含），按单价升序', async () => {
    const processor = await createOne('HTTP区间加工厂');
    await createOneQuote(processor.id, {
      quoteDate: '2026-05-03',
      processName: 'HTTP区间工序',
      unitPrice: '6.5',
    });
    await createOneQuote(processor.id, {
      quoteDate: '2026-05-20',
      processName: 'HTTP区间工序',
      unitPrice: '5.5',
    });
    // 区间外 / 其他工序：都不应出现在结果里。
    await createOneQuote(processor.id, {
      quoteDate: '2026-06-01',
      processName: 'HTTP区间工序',
      unitPrice: '7.5',
    });
    await createOneQuote(processor.id, {
      quoteDate: '2026-05-10',
      processName: 'HTTP区间另一工序',
      unitPrice: '1',
    });

    const query = `?processName=${encodeURIComponent('HTTP区间工序')}&from=2026-05-01&to=2026-05-31`;
    const response = await listQuotesRequest(ownerCookie, 'req-quote-range', query);
    expect(response.statusCode).toBe(200);

    const items = (response.json() as { items: ProcessorQuote[] }).items;
    expect(items.map((item) => item.unitPrice)).toEqual(['5.500000', '6.500000']);
    expect(items.every((item) => item.processName === 'HTTP区间工序')).toBe(true);
    expect(items.every((item) => item.processorId === processor.id)).toBe(true);
  });

  it('D64③：同一工序跨加工厂比价——多家报价同列并便宜在前', async () => {
    const processorA = await createOne('HTTP比价甲加工厂');
    const processorB = await createOne('HTTP比价乙加工厂');

    await createOneQuote(processorA.id, {
      quoteDate: '2026-01-10',
      processName: 'HTTP比价工序',
      unitPrice: '12.5',
    });
    await createOneQuote(processorB.id, {
      quoteDate: '2026-01-15',
      processName: 'HTTP比价工序',
      unitPrice: '10.25',
    });
    await createOneQuote(processorB.id, {
      quoteDate: '2026-01-31',
      processName: 'HTTP比价工序',
      unitPrice: '11',
    });

    const response = await listQuotesRequest(
      ownerCookie,
      'req-quote-compare',
      `?processName=${encodeURIComponent('HTTP比价工序')}`,
    );
    expect(response.statusCode).toBe(200);

    const items = (response.json() as { items: ProcessorQuote[] }).items;
    expect(items.map((item) => item.unitPrice)).toEqual(['10.250000', '11.000000', '12.500000']);
    expect(new Set(items.map((item) => item.processorId))).toEqual(
      new Set([processorA.id, processorB.id]),
    );
  });

  it('D64④：报价没有 update / delete 路由（PATCH / DELETE → 404 或 405）', async () => {
    const processor = await createOne('HTTP只增加工厂');
    const quote = await createOneQuote(processor.id, {
      quoteDate: '2026-02-01',
      processName: 'HTTP只增工序',
      unitPrice: '3',
    });

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processor-quotes/${quote.id}`,
      headers: writeHeaders(ownerCookie, 'req-quote-patch', { 'if-match': '"1"' }),
      payload: { unitPrice: '2' },
    });
    expect([404, 405]).toContain(patch.statusCode);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/processor-quotes/${quote.id}`,
      headers: writeHeaders(ownerCookie, 'req-quote-delete', { 'if-match': '"1"' }),
    });
    expect([404, 405]).toContain(remove.statusCode);

    // 记录仍在：只增不改。
    const list = await listQuotesRequest(
      ownerCookie,
      'req-quote-after-no-route',
      `?processorId=${processor.id}`,
    );
    const items = (list.json() as { items: ProcessorQuote[] }).items;
    expect(items.map((item) => item.id)).toEqual([quote.id]);
    expect(items[0]?.unitPrice).toBe('3.000000');
  });

  it('D52①：AI 凭证停用加工厂 → 403 AI_ACTION_FORBIDDEN，加工厂状态不变', async () => {
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-proc-ai-token'),
      payload: {
        name: 'HTTP Processor AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'processor', actions: ['read', 'delete'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const created = await createOne('HTTP AI加工厂');
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/processors/${created.id}`,
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 停用加工厂',
        'if-match': '"1"',
        'x-request-id': 'req-proc-ai-delete',
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'AI_ACTION_FORBIDDEN' });

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM processor WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.status).toBe('启用');
  });
});
