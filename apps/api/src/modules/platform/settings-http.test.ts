import type {
  SettingsOverview,
  SettingsPhoneChangeRequestResult,
  SettingsPhoneChangeResult,
  SettingsProfile,
  SettingsSessionList,
} from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 设置中心第 2 块（Issue #298）：资料保存 + 换手机号 + 我的会话。
 *
 * 六条验收口径（与 issue #298 一致）：
 *   ① 无 `company.read` 请求概览 → 403，不返回 `companies: []` 冒充「没有公司」；
 *   ② 概览手机号脱敏为 `138****1234`；
 *   ③ 概览只返回 principal 有权访问的公司；
 *   ④ 资料保存 / 换号 / 踢会话**只作用于本人**（路径写死 `/me`，塞别人 id 一律拒绝）；
 *   ⑤ 换号成功后本人全部会话 `revoked_at` 非空，旧 cookie 立刻 401；
 *   ⑥ `tax_no` 非法值 422、`If-Match` 冲突 409。
 *
 * ①–③ 是第 1 块（settings-overview）回归的护栏：本块新增了 company 列的写入路径，
 * 一旦有人顺手改了概览的过滤条件，这三条会立刻红。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const COMPANY_A = DEMO_IDS.companyId;
const COMPANY_B = '01900000-0000-7000-8000-0000000000b2';
/** seed 的占位号是 100 号段；改成 138 号段才能断言 ② 的脱敏格式。 */
const MANAGER_PHONE = '13800001234';
const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';
/** 换号目标：seed 里不存在的号段，保证占用检查放行。 */
const SALES_NEW_PHONE = '13900002222';
/** 合法税号（18 位大写字母数字）。 */
const VALID_TAX_NO = '91350211MA2Y5K7X8Q';
const INVALID_TAX_NO = 'abc-123';

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

function etagOf(version: number): string {
  return `"${version}"`;
}

describe('设置中心第 2 块（#298 / D97）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let salesCookie: string;

  async function employeeVersion(employeeId: string): Promise<number> {
    const result = await test.database.query<{ version: number }>(
      'SELECT version FROM employee WHERE id = $1',
      [employeeId],
    );
    return result.rows[0]!.version;
  }

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
      requestIdFactory: () => 'req-settings-fallback',
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

  it('① 无 company.read 请求概览 → 403，不返回 companies: [] 冒充「没有公司」', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/overview',
      headers: authHeaders(salesCookie, 'req-settings-overview-forbidden'),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { code: string };
    expect(body.code).toBe('FORBIDDEN');
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
    expect(body.me.phoneMasked).toBe('138****1234');
    expect(JSON.stringify(body)).not.toContain(MANAGER_PHONE);
  });

  it('③ 概览只返回 principal 有权访问的公司（经理只有 A，老板有 A + B）', async () => {
    const managerResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/overview',
      headers: authHeaders(managerCookie, 'req-settings-overview-manager-companies'),
    });
    expect(managerResponse.statusCode).toBe(200);
    const managerIds = (managerResponse.json() as SettingsOverview).companies.map((c) => c.id);
    expect(managerIds).toEqual([COMPANY_A]);

    const ownerResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/overview',
      headers: authHeaders(ownerCookie, 'req-settings-overview-owner-companies'),
    });
    expect(ownerResponse.statusCode).toBe(200);
    const ownerIds = (ownerResponse.json() as SettingsOverview).companies.map((c) => c.id);
    expect(ownerIds).toContain(COMPANY_A);
    expect(ownerIds).toContain(COMPANY_B);
  });

  it('④ 资料保存 / 踢会话只作用于本人：塞别人 id 一律拒绝', async () => {
    const version = await employeeVersion(DEMO_IDS.managerEmployeeId);

    // ④-1 请求体里塞员工 id：契约是 strict，多一个字段就 422，不会被静默忽略。
    const smuggled = await app.inject({
      method: 'PATCH',
      url: '/api/v1/employees/me',
      headers: { ...authHeaders(managerCookie, 'req-settings-profile-smuggle'), 'if-match': etagOf(version) },
      payload: { name: '被改的名字', id: DEMO_IDS.ownerEmployeeId },
    });
    expect(smuggled.statusCode).toBe(422);
    expect((smuggled.json() as { code: string }).code).toBe('VALIDATION_FAILED');

    const ownerBefore = await test.database.query<{ name: string }>(
      'SELECT name FROM employee WHERE id = $1',
      [DEMO_IDS.ownerEmployeeId],
    );
    expect(ownerBefore.rows[0]!.name).toBe('张明');

    // ④-2 正常改自己的名字：回包 id 就是 principal 本人，老板的名字一个字没动。
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/v1/employees/me',
      headers: { ...authHeaders(managerCookie, 'req-settings-profile-self'), 'if-match': etagOf(version) },
      payload: { name: '李强强' },
    });
    expect(saved.statusCode).toBe(200);
    const savedBody = saved.json() as SettingsProfile;
    expect(savedBody.id).toBe(DEMO_IDS.managerEmployeeId);
    expect(savedBody.name).toBe('李强强');
    expect(savedBody.company).toBeNull();
    expect(String(saved.headers['etag'])).toBe(etagOf(savedBody.version));

    const ownerAfter = await test.database.query<{ name: string }>(
      'SELECT name FROM employee WHERE id = $1',
      [DEMO_IDS.ownerEmployeeId],
    );
    expect(ownerAfter.rows[0]!.name).toBe('张明');

    // ④-3 踢别人的会话：403（不是 404，也不静默成功），且那条会话仍然有效。
    const salesSession = await test.database.query<{ id: string }>(
      `SELECT id FROM session
        WHERE employee_id = $1 AND revoked_at IS NULL
        ORDER BY issued_at DESC LIMIT 1`,
      [DEMO_IDS.salesEmployeeId],
    );
    const salesSessionId = salesSession.rows[0]!.id;

    const revokeOther = await app.inject({
      method: 'DELETE',
      url: `/api/v1/employees/me/sessions/${salesSessionId}`,
      headers: authHeaders(managerCookie, 'req-settings-revoke-other'),
    });
    expect(revokeOther.statusCode).toBe(403);
    expect((revokeOther.json() as { code: string }).code).toBe('FORBIDDEN');

    const stillActive = await test.database.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM session WHERE id = $1',
      [salesSessionId],
    );
    expect(stillActive.rows[0]!.revoked_at).toBeNull();
  });

  it('⑤ 换号成功后本人全部会话 revoked_at 非空，旧 cookie 立刻 401', async () => {
    // 先制造第二条会话（旧设备），验证「全吊销」而不是「只吊销当前这条」。
    const secondCookie = await login(app, SALES_PHONE, 'req-settings-login-sales-second');

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/employees/me/phone/request',
      headers: authHeaders(salesCookie, 'req-settings-phone-request'),
      payload: { phone: SALES_NEW_PHONE },
    });
    expect(requested.statusCode).toBe(200);
    const requestedBody = requested.json() as SettingsPhoneChangeRequestResult;
    expect(requestedBody.phoneMasked).toBe('139****2222');
    expect(requestedBody.resendAfterSeconds).toBe(60);

    // 暂存列已写入，且 employee.phone 还没变——双确认完成前旧号照常可用。
    const pending = await test.database.query<{ phone: string; pending_phone: string | null }>(
      'SELECT phone, pending_phone FROM employee WHERE id = $1',
      [DEMO_IDS.salesEmployeeId],
    );
    expect(pending.rows[0]!.phone).toBe(SALES_PHONE);
    expect(pending.rows[0]!.pending_phone).toBe(SALES_NEW_PHONE);

    // 频控：同号 60 秒内第二次申请 → 429，不吞成 200。
    const tooFast = await app.inject({
      method: 'POST',
      url: '/api/v1/employees/me/phone/request',
      headers: authHeaders(salesCookie, 'req-settings-phone-request-again'),
      payload: { phone: SALES_NEW_PHONE },
    });
    expect(tooFast.statusCode).toBe(429);
    expect((tooFast.json() as { code: string }).code).toBe('RATE_LIMITED');

    // 错码 → 422，且不改号。
    const wrongCode = await app.inject({
      method: 'POST',
      url: '/api/v1/employees/me/phone/confirm',
      headers: authHeaders(salesCookie, 'req-settings-phone-confirm-wrong'),
      payload: { code: '123456' },
    });
    expect(wrongCode.statusCode).toBe(422);

    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/v1/employees/me/phone/confirm',
      headers: authHeaders(salesCookie, 'req-settings-phone-confirm'),
      payload: { code: '000000' },
    });
    expect(confirmed.statusCode).toBe(200);
    const confirmedBody = confirmed.json() as SettingsPhoneChangeResult;
    expect(confirmedBody.phoneMasked).toBe('139****2222');
    expect(confirmedBody.sessionsRevoked).toBeGreaterThanOrEqual(2);

    const after = await test.database.query<{
      phone: string;
      pending_phone: string | null;
      pending_phone_code_hash: string | null;
    }>(
      `SELECT phone, pending_phone, pending_phone_code_hash
         FROM employee WHERE id = $1`,
      [DEMO_IDS.salesEmployeeId],
    );
    expect(after.rows[0]!.phone).toBe(SALES_NEW_PHONE);
    expect(after.rows[0]!.pending_phone).toBeNull();
    expect(after.rows[0]!.pending_phone_code_hash).toBeNull();

    const sessions = await test.database.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM session WHERE employee_id = $1',
      [DEMO_IDS.salesEmployeeId],
    );
    expect(sessions.rows.length).toBeGreaterThanOrEqual(2);
    expect(sessions.rows.every((row) => row.revoked_at !== null)).toBe(true);

    // 旧 cookie（两条都）立刻失效：改号等于换钥匙，旧设备不能继续用。
    for (const [index, cookie] of [salesCookie, secondCookie].entries()) {
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeaders(cookie, `req-settings-phone-old-token-${index}`),
      });
      expect(me.statusCode).toBe(401);
      expect((me.json() as { code: string }).code).toBe('UNAUTHENTICATED');
    }
  });

  it('⑥ tax_no 非法值 422、If-Match 冲突 409、缺 company.update 403', async () => {
    const ownerVersion = await employeeVersion(DEMO_IDS.ownerEmployeeId);

    const badTaxNo = await app.inject({
      method: 'PATCH',
      url: '/api/v1/employees/me',
      headers: { ...authHeaders(ownerCookie, 'req-settings-tax-invalid'), 'if-match': etagOf(ownerVersion) },
      payload: { company: { taxNo: INVALID_TAX_NO } },
    });
    expect(badTaxNo.statusCode).toBe(422);
    expect((badTaxNo.json() as { code: string }).code).toBe('VALIDATION_FAILED');

    const staleVersion = await app.inject({
      method: 'PATCH',
      url: '/api/v1/employees/me',
      headers: { ...authHeaders(ownerCookie, 'req-settings-if-match-stale'), 'if-match': etagOf(ownerVersion + 99) },
      payload: { name: '张明明' },
    });
    expect(staleVersion.statusCode).toBe(409);
    expect((staleVersion.json() as { code: string }).code).toBe('VERSION_CONFLICT');

    // 经理有 employee.update 但**没有** company.update：改公司字段必须 403。
    const managerVersion = await employeeVersion(DEMO_IDS.managerEmployeeId);
    const noCompanyScope = await app.inject({
      method: 'PATCH',
      url: '/api/v1/employees/me',
      headers: { ...authHeaders(managerCookie, 'req-settings-no-company-update'), 'if-match': etagOf(managerVersion) },
      payload: { company: { address: '厦门市思明区' } },
    });
    expect(noCompanyScope.statusCode).toBe(403);
    expect((noCompanyScope.json() as { code: string }).code).toBe('FORBIDDEN');

    // 合法税号 → 200，回包带公司实体（含新值）与公司版本。
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/v1/employees/me',
      headers: { ...authHeaders(ownerCookie, 'req-settings-tax-valid'), 'if-match': etagOf(ownerVersion) },
      payload: { company: { taxNo: VALID_TAX_NO, address: '厦门市思明区' } },
    });
    expect(saved.statusCode).toBe(200);
    const savedBody = saved.json() as SettingsProfile;
    expect(savedBody.company?.id).toBe(COMPANY_A);
    expect(savedBody.company?.taxNo).toBe(VALID_TAX_NO);
    expect(savedBody.company?.address).toBe('厦门市思明区');
  });

  it('⑦ 我的会话列表只回设备标识与时间，不回 token / UA 原文', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/employees/me/sessions',
      headers: authHeaders(ownerCookie, 'req-settings-sessions'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SettingsSessionList;
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.filter((item) => item.current)).toHaveLength(1);

    const tokenRows = await test.database.query<{ token_hash: string }>(
      'SELECT token_hash FROM session WHERE employee_id = $1',
      [DEMO_IDS.ownerEmployeeId],
    );
    const raw = JSON.stringify(body);
    for (const row of tokenRows.rows) expect(raw).not.toContain(row.token_hash);
    expect(raw).not.toContain('qingdan_session');
  });
});
