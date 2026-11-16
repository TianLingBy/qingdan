import type { SettingsOverview } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 设置中心概览端点（`platform.settings.overview`，Issue #298 / D93）。
 *
 * 本块只锁三条口径：
 *   ① 无 `company.read` → 403，不返回 `companies: []` 冒充「没有公司」；
 *   ② 手机号脱敏为 `138****1234`，完整号码不出服务端；
 *   ③ 只返回 principal 有权访问的公司（经理只绑定公司 A，看不到公司 B）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const COMPANY_A = DEMO_IDS.companyId;
const COMPANY_B = '01900000-0000-7000-8000-0000000000b2';
/** seed 的占位号是 100 号段；改成 138 号段才能断言 ② 的脱敏格式。 */
const MANAGER_PHONE = '13800001234';
const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';

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

function authHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId };
}

describe('设置中心概览（#298 / D93）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let salesCookie: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);

    // ② 需要 138 号段；登录也用改后的号码。
    await test.database.query('UPDATE employee SET phone = $1 WHERE id = $2', [
      MANAGER_PHONE,
      DEMO_IDS.managerEmployeeId,
    ]);

    // ③ 第二家公司：老板可见；经理只绑定公司 A，不可见。
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')`,
      [COMPANY_B, DEMO_IDS.tenantId],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-settings-overview-fallback',
    });
    await app.ready();

    ownerCookie = await login(app, OWNER_PHONE, 'req-settings-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-settings-login-manager');
    salesCookie = await login(app, SALES_PHONE, 'req-settings-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('① 无 company.read → 403，不返回 companies: [] 冒充「没有公司」', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/overview',
      headers: authHeaders(salesCookie, 'req-settings-overview-forbidden'),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { code: string };
    expect(body.code).toBe('FORBIDDEN');
    // 关键：不能是 200 + 空数组；错误体里也不能出现 companies。
    expect(body).not.toHaveProperty('companies');
  });

  it('② 概览手机号脱敏为 138****1234，完整号码不出服务端', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/overview',
      headers: authHeaders(managerCookie, 'req-settings-overview-phone'),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as SettingsOverview;
    expect(body.me.name).toBe('李强');
    expect(body.me.phoneMasked).toBe('138****1234');
    expect(JSON.stringify(body)).not.toContain(MANAGER_PHONE);
  });

  it('③ 只返回 principal 有权访问的公司（经理只有公司 A，老板有 A + B）', async () => {
    const managerResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/overview',
      headers: authHeaders(managerCookie, 'req-settings-overview-manager-companies'),
    });
    expect(managerResponse.statusCode).toBe(200);
    const managerBody = managerResponse.json() as SettingsOverview;
    const managerIds = managerBody.companies.map((company) => company.id);
    expect(managerIds).toEqual([COMPANY_A]);
    expect(managerBody.me.companies.map((company) => company.id)).toEqual(managerIds);
    // 岗位也来自同一条 ecp 绑定，不越权带出公司 B。
    expect(managerBody.me.positions.every((position) => position.companyId === COMPANY_A)).toBe(true);

    const ownerResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/overview',
      headers: authHeaders(ownerCookie, 'req-settings-overview-owner-companies'),
    });
    expect(ownerResponse.statusCode).toBe(200);
    const ownerBody = ownerResponse.json() as SettingsOverview;
    const ownerIds = ownerBody.companies.map((company) => company.id);
    expect(ownerIds).toContain(COMPANY_A);
    expect(ownerIds).toContain(COMPANY_B);
  });
});
