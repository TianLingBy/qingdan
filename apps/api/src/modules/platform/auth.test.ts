import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { serializeClearedSessionCookie, serializeSessionCookie } from '../../platform/auth/cookie.js';
import { recordAudit } from '../../platform/audit/writer.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * M1-B 登录闭环（D54④ / D59③⑦）：
 *   - login：成功下发会话 Cookie；错误验证码 / 未知手机号统一 401；production → 501；
 *   - logout：撤销当前会话并清 Cookie，幂等；
 *   - me：返回身份、公司集合与实时权限；
 *   - 审计：成功 / 失败 / 登出各一条，未知手机号失败日志在 qingdan_app 下也能落库。
 */

const OWNER_PHONE = '10000000001';
const UNKNOWN_PHONE = '19999999999';
const REQUEST_ID = 'req-platform-0001';
const PUBLIC_BASE_URL = 'https://qingdan.example';
const DAY_SECONDS = 24 * 60 * 60;

interface AuditRow {
  request_id: string;
  action: string;
  result: string;
  actor_type: string;
  actor_id: string;
  credential_id: string | null;
  tenant_id: string | null;
  object_type: string;
  error_code: string | null;
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  expect(typeof header).toBe('string');
  return String(header).split(';')[0]!;
}

describe('platform 登录闭环（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;

  const loginRequest = (
    phone: string,
    code: string,
    requestId: string,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': requestId, ...headers },
      payload: { phone, code },
    });

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => REQUEST_ID,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('登录成功：200 + Set-Cookie 属性齐全（非 production 不带 Secure）', async () => {
    const response = await loginRequest(OWNER_PHONE, '000000', 'req-login-ok');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      employeeId: DEMO_IDS.ownerEmployeeId,
      tenantId: DEMO_IDS.tenantId,
      displayName: '张明',
    });

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('qingdan_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${7 * DAY_SECONDS}`);
    expect(setCookie).not.toContain('Secure');
  });

  it('验证码错误 → 401 UNAUTHENTICATED', async () => {
    const response = await loginRequest(OWNER_PHONE, '123456', 'req-login-wrong-code');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('未知手机号 → 401（与验证码错误同一错误体，不泄露原因）', async () => {
    const response = await loginRequest(UNKNOWN_PHONE, '000000', 'req-login-unknown');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('登录请求体不合法 → 422，统一失败钩子落一条 result=fail 审计', async () => {
    const response = await loginRequest('123', '000000', 'req-audit-login-invalid');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const rows = await test.database.query<AuditRow>(
      `SELECT request_id, action, result, actor_type, actor_id, credential_id, tenant_id,
              object_type, error_code
         FROM audit_log WHERE request_id = $1`,
      ['req-audit-login-invalid'],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      action: 'platform.auth.login',
      result: 'fail',
      tenant_id: null,
      object_type: 'session',
      error_code: 'VALIDATION_FAILED',
    });
  });

  it('production 未接短信服务商 → 501 NOT_IMPLEMENTED（不静默放行固定验证码）', async () => {
    const prodApp = buildApp({
      config: testConfig({ nodeEnv: 'production' }),
      database: test.database,
    });
    try {
      const response = await prodApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { phone: OWNER_PHONE, code: '000000' },
      });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({ code: 'NOT_IMPLEMENTED' });
      expect(response.headers['set-cookie']).toBeUndefined();
    } finally {
      await prodApp.close();
    }
  });

  it('登录成功 / 登录失败 / 登出各写一条审计（action / actor / result / 会话 id）', async () => {
    const success = await loginRequest(OWNER_PHONE, '000000', 'req-audit-login-ok');
    expect(success.statusCode).toBe(200);
    const cookie = cookieOf(success);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-audit-logout' },
    });
    expect(logout.statusCode).toBe(204);

    const failure = await loginRequest(OWNER_PHONE, '999999', 'req-audit-login-fail');
    expect(failure.statusCode).toBe(401);

    const rows = await test.database.query<AuditRow>(
      `SELECT request_id, action, result, actor_type, actor_id, credential_id, tenant_id, object_type
         FROM audit_log
        WHERE request_id IN ($1, $2, $3)`,
      ['req-audit-login-ok', 'req-audit-logout', 'req-audit-login-fail'],
    );
    expect(rows.rows).toHaveLength(3);

    const byRequest = new Map(rows.rows.map((row) => [row.request_id, row]));
    const loginOk = byRequest.get('req-audit-login-ok')!;
    const logoutRow = byRequest.get('req-audit-logout')!;
    const loginFail = byRequest.get('req-audit-login-fail')!;

    expect(loginOk).toMatchObject({
      action: 'platform.auth.login',
      result: 'success',
      actor_type: 'employee',
      actor_id: DEMO_IDS.ownerEmployeeId,
      tenant_id: DEMO_IDS.tenantId,
      object_type: 'session',
    });
    expect(loginOk.credential_id).not.toBeNull();

    expect(loginFail).toMatchObject({
      action: 'platform.auth.login',
      result: 'fail',
      actor_type: 'employee',
      actor_id: OWNER_PHONE,
      credential_id: null,
      tenant_id: null,
      object_type: 'session',
    });

    expect(logoutRow).toMatchObject({
      action: 'platform.auth.logout',
      result: 'success',
      actor_type: 'employee',
      actor_id: DEMO_IDS.ownerEmployeeId,
      credential_id: loginOk.credential_id,
      tenant_id: DEMO_IDS.tenantId,
      object_type: 'session',
    });

    // 计数口径：每个动作在本请求 id 下只有一条。
    for (const action of ['platform.auth.login', 'platform.auth.logout'] as const) {
      const count = await test.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE action = $1
            AND request_id IN ($2, $3, $4)`,
        [action, 'req-audit-login-ok', 'req-audit-logout', 'req-audit-login-fail'],
      );
      expect(count.rows[0]!.n).toBe(action === 'platform.auth.login' ? 2 : 1);
    }
  });

  it('登出后原 Cookie 再请求 /auth/me → 401；登出响应清 Cookie 且幂等', async () => {
    const login = await loginRequest(OWNER_PHONE, '000000', 'req-logout-flow-login');
    const cookie = cookieOf(login);

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie, 'x-request-id': 'req-logout-flow-me-before' },
    });
    expect(before.statusCode).toBe(200);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-logout-flow-logout' },
    });
    expect(logout.statusCode).toBe(204);
    const cleared = String(logout.headers['set-cookie']);
    expect(cleared).toContain('qingdan_session=');
    expect(cleared).toContain('Max-Age=0');

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie, 'x-request-id': 'req-logout-flow-me-after' },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    // 幂等：同一 Cookie 再登出仍 204（会话已撤销，不再记审计）。
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, 'x-request-id': 'req-logout-flow-logout-again' },
    });
    expect(again.statusCode).toBe(204);

    // 无会话直接登出也成功（可选认证路径）。
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { 'x-request-id': 'req-logout-flow-anonymous' },
    });
    expect(anonymous.statusCode).toBe(204);
  });

  it('/auth/me 返回 displayName / companyIds / 实时 scope', async () => {
    const login = await loginRequest(OWNER_PHONE, '000000', 'req-me-login');
    const cookie = cookieOf(login);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie, 'x-request-id': 'req-me-read' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      employeeId: string;
      tenantId: string;
      displayName: string;
      companyIds: string[];
      scope: Array<{ domain: string; actions: string[] }>;
    };
    expect(body).toMatchObject({
      employeeId: DEMO_IDS.ownerEmployeeId,
      tenantId: DEMO_IDS.tenantId,
      displayName: '张明',
      companyIds: [DEMO_IDS.companyId],
    });
    // 老板 = 全功能域 × 全动作（D15 / D59⑥）。
    expect(body.scope.length).toBe(23);
    expect(body.scope.find((entry) => entry.domain === 'sales')?.actions).toEqual(
      expect.arrayContaining(['read', 'create', 'update', 'approve', 'ship', 'delete', 'view_price', 'export']),
    );
  });

  it('Cookie 序列化：production 才带 Secure，清除指令 Max-Age=0', () => {
    const insecure = serializeSessionCookie('tok', { maxAgeSeconds: 60, secure: false });
    expect(insecure).toContain('HttpOnly');
    expect(insecure).toContain('SameSite=Lax');
    expect(insecure).not.toContain('Secure');

    const secure = serializeSessionCookie('tok', { maxAgeSeconds: 60, secure: true });
    expect(secure).toContain('; Secure');

    const cleared = serializeClearedSessionCookie({ secure: false });
    expect(cleared).toContain('qingdan_session=;');
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
  });

  it('未知手机号的失败审计在 qingdan_app（FORCE RLS）下仍可落库', async () => {
    await test.database.exec('SET ROLE qingdan_app');
    try {
      await recordAudit(test.database, {
        tenantId: null,
        actorType: 'employee',
        actorId: UNKNOWN_PHONE,
        source: 'api',
        action: 'platform.auth.login',
        objectType: 'session',
        result: 'fail',
        errorCode: 'UNAUTHENTICATED',
        requestId: 'req-audit-rls-unscoped',
      });
    } finally {
      await test.database.exec('RESET ROLE');
    }

    const rows = await test.database.query<AuditRow>(
      `SELECT request_id, action, result, actor_type, actor_id, credential_id, tenant_id, object_type
         FROM audit_log WHERE request_id = $1`,
      ['req-audit-rls-unscoped'],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      tenant_id: null,
      actor_id: UNKNOWN_PHONE,
      result: 'fail',
    });
  });
});
