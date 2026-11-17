import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { SUGGEST_RATE_LIMIT, resetSuggestQuota } from './suggest-rate-limit.js';

/**
 * 建档防重 suggest（D99 / #302 块 B）HTTP 行为。
 *
 * 覆盖「必须做对的三件事」与全部回归点：
 *   - 正常：`张记建材` 命中 `张记建材经营部`，score > 0.7、reason 非空；
 *   - 完全同名：score === 1、reason === '名称完全相同'（最危险的情况必须显眼）；
 *   - 别家公司同名：提示得出来，但只回 id/name/score/reason，**不带**电话/地址等字段；
 *   - 无 `read` 权限 → 403，绝不回空数组冒充「没有相似档案」；
 *   - `companyId` 必传（缺 → 422）、不可见公司 → 403（**不是** 200 空数组）；
 *   - `name` 空 / 全空格 / 缺失 / 只有一个字 → 422；
 *   - `limit` 越界 → 422；同一 principal 连打超过配额 → 429 RATE_LIMITED；
 *   - 跨租户：租户 A 看不到租户 B 的任何档案。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';

const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';
const WAREHOUSE_PHONE = '10000000004';
/** 同时绑定两家公司的员工，用于验证「名称相同但公司不同」这条提示。 */
const DUAL_PHONE = '10000000009';

const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000003';
const DUAL_EMPLOYEE_ID = '01900000-0000-7000-8000-000000000026';
/** seed 的「老板」岗位：全部权限点。 */
const BOSS_POSITION_ID = '01900000-0000-7000-8000-000000000011';

const OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000009a1';
const OTHER_TENANT_COMPANY_ID = '01900000-0000-7000-8000-0000000009a2';
const OTHER_TENANT_CUSTOMER_ID = '01900000-0000-7000-8000-0000000009a3';
const OTHER_TENANT_CUSTOMER_NAME = '别家租户的独门客户';

/** 候选只允许这四个字段：多一个就是跨公司信息泄露口子。 */
const CANDIDATE_KEYS = ['id', 'name', 'reason', 'score'];

interface Candidate {
  id: string;
  name: string;
  score: number;
  reason: string;
}

interface ErrorBody {
  code: string;
  details?: { field?: string };
}

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

/** Cookie 认证的非安全请求需要同源 Origin（D59⑧）。 */
function writeHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId };
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

describe('masterdata suggest（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  let warehouseCookie: string;
  let dualCookie: string;

  let sequence = 0;
  async function createCustomer(
    cookie: string,
    companyId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    sequence += 1;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: writeHeaders(cookie, `req-suggest-create-${sequence}`),
      payload: { companyId, ...payload },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { id: string }).id;
  }

  async function suggest(
    cookie: string,
    query: string,
    requestId: string,
    kind = 'customers',
  ): Promise<Candidate[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/${kind}/suggest?${query}`,
      headers: readHeaders(cookie, requestId),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { candidates: Candidate[] }).candidates;
  }

  /** 同名客户在两家公司各一条，用于「名称相同但公司不同」。 */
  let sameNameCompanyOneId: string;
  let sameNameCompanyTwoId: string;
  let suffixCustomerId: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);

    // 第二家公司 + 同时绑两家公司的员工（老板岗位）：跨公司同名提示必须由「都看得见的人」触发。
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [SECOND_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1, $2, '000009', $3, '双公司员工', '在职', false)
       ON CONFLICT (id) DO NOTHING`,
      [DUAL_EMPLOYEE_ID, DEMO_IDS.tenantId, DUAL_PHONE],
    );
    for (const companyId of [DEMO_IDS.companyId, SECOND_COMPANY_ID]) {
      await test.database.query(
        `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [DEMO_IDS.tenantId, DUAL_EMPLOYEE_ID, companyId, BOSS_POSITION_ID],
      );
    }

    // 另一个租户：只用来证明跨租户数据绝不出现（RLS + 显式 tenant_id 过滤双保险）。
    await test.database.query(
      `INSERT INTO tenant (id, name) VALUES ($1, '别家租户') ON CONFLICT (id) DO NOTHING`,
      [OTHER_TENANT_ID],
    );
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '别家公司', '0001', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_TENANT_COMPANY_ID, OTHER_TENANT_ID],
    );
    await test.database.query(
      `INSERT INTO customer (id, tenant_id, company_id, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        OTHER_TENANT_CUSTOMER_ID,
        OTHER_TENANT_ID,
        OTHER_TENANT_COMPANY_ID,
        OTHER_TENANT_CUSTOMER_NAME,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();

    ownerCookie = await login(app, OWNER_PHONE, 'req-suggest-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-suggest-login-sales');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-suggest-login-warehouse');
    dualCookie = await login(app, DUAL_PHONE, 'req-suggest-login-dual');

    // 本公司：一条完全同名、一条只差组织后缀（带联系电话，用来验证候选不回敏感字段）。
    sameNameCompanyOneId = await createCustomer(ownerCookie, DEMO_IDS.companyId, {
      name: '张记建材',
      contactPhone: '13900001111',
      contactName: '张记',
      address: '不属于契约字段，故意多传也无害',
    });
    suffixCustomerId = await createCustomer(ownerCookie, DEMO_IDS.companyId, {
      name: '张记建材经营部',
      contactPhone: '13900002222',
    });
    // 另一家公司：与本公司那条完全同名。
    sameNameCompanyTwoId = await createCustomer(dualCookie, SECOND_COMPANY_ID, {
      name: '张记建材',
      contactPhone: '13900003333',
    });
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  // 限流是进程内状态，逐个用例重置，免得一条用例的请求数影响下一条。
  beforeEach(() => {
    resetSuggestQuota();
  });

  it('未登录 → 401 UNAUTHENTICATED', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/suggest?name=张记&companyId=${DEMO_IDS.companyId}`,
      headers: { 'x-request-id': 'req-suggest-anonymous' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('无 customer.read → 403，不是空数组（否则前端会显示「未发现相似档案」）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/suggest?name=${encodeURIComponent('张记建材')}&companyId=${DEMO_IDS.companyId}`,
      headers: readHeaders(warehouseCookie, 'req-suggest-no-perm'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    // 关键点：403 时响应体里不能出现 candidates 字段，避免被当成「查过了，没有」。
    expect(response.json()).not.toHaveProperty('candidates');
  });

  it('正常：张记建材 → 命中张记建材经营部，score > 0.7 且 reason 非空', async () => {
    const candidates = await suggest(
      ownerCookie,
      `name=${encodeURIComponent('张记建材')}&companyId=${DEMO_IDS.companyId}`,
      'req-suggest-normal',
    );
    const hit = candidates.find((item) => item.id === suffixCustomerId);
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0.7);
    expect(hit!.reason.length).toBeGreaterThan(0);
    expect(hit!.name).toBe('张记建材经营部');
  });

  it('完全同名：score === 1 且 reason === 名称完全相同，排在第一位', async () => {
    const candidates = await suggest(
      ownerCookie,
      `name=${encodeURIComponent('张记建材')}&companyId=${DEMO_IDS.companyId}`,
      'req-suggest-identical',
    );
    const hit = candidates[0]!;
    expect(hit.id).toBe(sameNameCompanyOneId);
    expect(hit.score).toBe(1);
    expect(hit.reason).toBe('名称完全相同');
  });

  it('候选只有 id/name/score/reason：不泄露电话、地址等档案字段', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/suggest?name=${encodeURIComponent('张记建材')}&companyId=${DEMO_IDS.companyId}`,
      headers: readHeaders(ownerCookie, 'req-suggest-no-leak'),
    });
    expect(response.statusCode).toBe(200);
    const candidates = (response.json() as { candidates: Candidate[] }).candidates;
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(Object.keys(candidate).sort()).toEqual(CANDIDATE_KEYS);
    }
    // 连字符串里都不该出现建档时填的联系电话。
    expect(response.body).not.toContain('13900001111');
    expect(response.body).not.toContain('13900002222');
  });

  it('不同公司同名：提示「名称相同但公司不同」，字段同样只有四个', async () => {
    const candidates = await suggest(
      dualCookie,
      `name=${encodeURIComponent('张记建材')}&companyId=${DEMO_IDS.companyId}`,
      'req-suggest-cross-company',
    );
    const otherCompany = candidates.find((item) => item.id === sameNameCompanyTwoId);
    expect(otherCompany).toBeDefined();
    expect(otherCompany!.score).toBe(1);
    expect(otherCompany!.reason).toBe('名称相同但公司不同');
    expect(Object.keys(otherCompany!).sort()).toEqual(CANDIDATE_KEYS);
  });

  it('看不见的公司不参与：只绑本公司的销售收不到第二家公司的同名客户', async () => {
    const candidates = await suggest(
      salesCookie,
      `name=${encodeURIComponent('张记建材')}&companyId=${DEMO_IDS.companyId}`,
      'req-suggest-other-company-hidden',
    );
    expect(candidates.map((item) => item.id)).not.toContain(sameNameCompanyTwoId);
  });

  it('传不可见公司的 companyId → 403（不是 200 空数组）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/suggest?name=${encodeURIComponent('张记')}&companyId=${SECOND_COMPANY_ID}`,
      headers: readHeaders(salesCookie, 'req-suggest-foreign-company'),
    });
    expect(response.statusCode).toBe(403);
    const body = response.json() as ErrorBody;
    expect(body.code).toBe('FORBIDDEN');
    expect(response.json()).not.toHaveProperty('candidates');
  });

  it('不传 companyId → 422，details.field === companyId（服务端不再猜默认公司）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/suggest?name=${encodeURIComponent('张记建材')}`,
      headers: readHeaders(ownerCookie, 'req-suggest-no-company'),
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as ErrorBody;
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details?.field).toBe('companyId');
  });

  it('name 空串 / 全空格 / 缺失 / 只有一个字 → 422，单字问题挂在 name 上', async () => {
    const queries = [
      'name=&companyId=' + DEMO_IDS.companyId,
      'name=%20%20%20&companyId=' + DEMO_IDS.companyId,
      'companyId=' + DEMO_IDS.companyId,
      `name=${encodeURIComponent('张')}&companyId=${DEMO_IDS.companyId}`,
    ];
    for (const [index, query] of queries.entries()) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/suggest?${query}`,
        headers: readHeaders(ownerCookie, `req-suggest-bad-name-${index}`),
      });
      expect(response.statusCode).toBe(422);
      const body = response.json() as ErrorBody;
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details?.field).toBe('name');
    }
  });

  it('limit 越界 → 422；limit=1 只回一条', async () => {
    for (const [index, limit] of ['21', '0'].entries()) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/suggest?name=${encodeURIComponent('张记')}&companyId=${DEMO_IDS.companyId}&limit=${limit}`,
        headers: readHeaders(ownerCookie, `req-suggest-bad-limit-${index}`),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }

    const single = await suggest(
      ownerCookie,
      `name=${encodeURIComponent('张记')}&companyId=${DEMO_IDS.companyId}&limit=1`,
      'req-suggest-limit-one',
    );
    expect(single).toHaveLength(1);
  });

  it('同一 principal 超过 30 次/分钟 → 429 RATE_LIMITED（按人限流，不按 IP）', async () => {
    const url = `/api/v1/customers/suggest?name=${encodeURIComponent('张记建材')}&companyId=${DEMO_IDS.companyId}`;
    for (let index = 0; index < SUGGEST_RATE_LIMIT; index += 1) {
      const allowed = await app.inject({
        method: 'GET',
        url,
        headers: readHeaders(salesCookie, `req-suggest-quota-${index}`),
      });
      expect(allowed.statusCode).toBe(200);
    }
    // 第 31 次：配额用尽。换个人仍然是 200，证明桶挂的是 principal 而不是全局。
    const limited = await app.inject({
      method: 'GET',
      url,
      headers: readHeaders(salesCookie, 'req-suggest-quota-overflow'),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });

    const otherPerson = await app.inject({
      method: 'GET',
      url,
      headers: readHeaders(ownerCookie, 'req-suggest-quota-other'),
    });
    expect(otherPerson.statusCode).toBe(200);
  });

  it('跨租户：租户 A 的请求收不到租户 B 的同名档案', async () => {
    const candidates = await suggest(
      ownerCookie,
      `name=${encodeURIComponent(OTHER_TENANT_CUSTOMER_NAME)}&companyId=${DEMO_IDS.companyId}`,
      'req-suggest-cross-tenant',
    );
    expect(candidates).toEqual([]);
  });

  it('四个域都挂了 suggest（supplier / processor / product 不 501）', async () => {
    for (const [index, kind] of ['suppliers', 'processors', 'products'].entries()) {
      const candidates = await suggest(
        ownerCookie,
        `name=${encodeURIComponent('张记')}&companyId=${DEMO_IDS.companyId}`,
        `req-suggest-kind-${index}`,
        kind,
      );
      expect(Array.isArray(candidates)).toBe(true);
    }
  });
});
