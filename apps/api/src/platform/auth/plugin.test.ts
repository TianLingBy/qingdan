import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { loadConfig, testConfig, type AppConfig } from '../config.js';
import { DEMO_IDS, seed } from '../db/seed.js';
import { assertCookieRequestSameOrigin } from './plugin.js';
import { createSession, hashSessionToken } from './session-store.js';

/**
 * 认证插件（D59）实测：
 *   - health / openapi.json 公开；
 *   - 未认证访问业务端点 → 401 UNAUTHENTICATED 统一错误体；
 *   - Cookie 认证的非安全请求必须同源（Origin / Referer），Bearer 不受 CSRF 约束。
 */

const REQUEST_ID = 'req-auth-0001';
const PUBLIC_BASE_URL = 'https://qingdan.example';

describe('auth plugin（公开路由 / 401 / CSRF 同源）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    const session = await createSession(test.database, {
      tenantId: DEMO_IDS.tenantId,
      employeeId: DEMO_IDS.salesEmployeeId,
      ttlDays: 7,
    });
    cookie = `qingdan_session=${session.token}`;

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

  it('GET /api/v1/health 不需要认证', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /api/v1/openapi.json 不需要认证', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('openapi', '3.1.0');
  });

  it('未认证访问 /api/v1/auth/me → 401 UNAUTHENTICATED 统一错误体', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: 'UNAUTHENTICATED',
      message: '未认证',
      requestId: REQUEST_ID,
    });
  });

  it('Bearer 无效时即便带 Cookie 也返回 401（不回退）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer bad-token', cookie },
    });

    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it('Cookie 认证 + POST 缺少 Origin / Referer → 403 FORBIDDEN', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie },
      payload: { phone: '10000000003', code: '000000' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN', requestId: REQUEST_ID });
  });

  it('Cookie 认证 + 同源 Origin → 放行到 handler（登录成功 200，而非 401/403）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie, origin: PUBLIC_BASE_URL },
      payload: { phone: '10000000003', code: '000000' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ employeeId: '01900000-0000-7000-8000-000000000023' });
    expect(response.headers['set-cookie']).toContain('qingdan_session=');
  });

  it('Cookie 认证 + 同源 Referer（无 Origin）→ 放行到 handler', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie, referer: `${PUBLIC_BASE_URL}/login` },
      payload: { phone: '10000000003', code: '000000' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('qingdan_session=');
  });

  it('Cookie 认证 + 跨源 Origin → 403 FORBIDDEN', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { phone: '10000000003', code: '000000' },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('FORBIDDEN');
  });

  it('配置 PUBLIC_BASE_URL 后不再接受任意 Host：Host 与 Origin 同为 evil 也拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie, origin: 'https://evil.example', host: 'evil.example' },
      payload: { phone: '10000000003', code: '000000' },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('FORBIDDEN');
  });

  it('同源判定：配置了 PUBLIC_BASE_URL 时只认它（Host 一致也不行）', () => {
    expect(() =>
      assertCookieRequestSameOrigin({
        origin: 'https://other.example',
        referer: undefined,
        host: 'other.example',
        protocol: 'https',
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
    ).toThrow(/不同源/);

    expect(() =>
      assertCookieRequestSameOrigin({
        origin: PUBLIC_BASE_URL,
        referer: undefined,
        host: 'other.example',
        protocol: 'https',
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
    ).not.toThrow();
  });

  it('同源判定：未配置 PUBLIC_BASE_URL 时退回按请求 Host 推断', () => {
    expect(() =>
      assertCookieRequestSameOrigin({
        origin: 'http://localhost:3000',
        referer: undefined,
        host: 'localhost:3000',
        protocol: 'http',
        publicBaseUrl: '',
      }),
    ).not.toThrow();

    expect(() =>
      assertCookieRequestSameOrigin({
        origin: 'http://other.example',
        referer: undefined,
        host: 'localhost:3000',
        protocol: 'http',
        publicBaseUrl: '',
      }),
    ).toThrow(/不同源/);
  });

  it('滑动续期实际写入时重发 Set-Cookie（同令牌、属性与登录一致），窗口内不重发', async () => {
    // 新建会话 last_seen_at 为空：首个认证请求会实际续期。
    const session = await createSession(test.database, {
      tenantId: DEMO_IDS.tenantId,
      employeeId: DEMO_IDS.salesEmployeeId,
      ttlDays: 7,
    });
    const sessionCookie = `qingdan_session=${session.token}`;

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: sessionCookie, 'x-request-id': 'req-auth-renew-1' },
    });
    expect(first.statusCode).toBe(200);
    const setCookie = String(first.headers['set-cookie']);
    expect(setCookie).toContain(`qingdan_session=${session.token}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    expect(setCookie).not.toContain('Secure');

    // 5 分钟窗口内不再续期，也不应重发 Cookie。
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: sessionCookie, 'x-request-id': 'req-auth-renew-2' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['set-cookie']).toBeUndefined();
  });
});

describe('trustProxy 配置（X-Forwarded-For 不得伪造 request.ip）', () => {
  const ALLOWED_IP = '10.0.0.1';
  const REAL_IP = '203.0.113.9';

  let test: TestDatabase;
  let bearer: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    bearer = randomBytes(32).toString('hex');
    await test.database.query(
      `INSERT INTO api_token
         (id, tenant_id, employee_id, name, scope, token_hash, ip_allowlist, status, created_by)
       VALUES ($1, $2, $3, 'vitest trustProxy', $4::jsonb, $5, $6, 'active', $3)`,
      [
        uuidv7(),
        DEMO_IDS.tenantId,
        DEMO_IDS.salesEmployeeId,
        JSON.stringify([{ domain: 'sales', actions: ['read'] }]),
        hashSessionToken(bearer),
        [ALLOWED_IP],
      ],
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  async function appWith(config: AppConfig): Promise<FastifyInstance> {
    const app = buildApp({ config, database: test.database });
    // 只读探针：确认 Fastify 解析出的 request.ip。
    app.get('/__test/ip', { config: { publicAccess: true } }, async (request) => ({
      ip: request.ip,
    }));
    await app.ready();
    return app;
  }

  function meRequest(app: FastifyInstance) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${bearer}`, 'x-forwarded-for': ALLOWED_IP },
      remoteAddress: REAL_IP,
    });
  }

  it('trustProxy=false（默认）：XFF 被忽略，request.ip 是连接地址，ip_allowlist 不被绕过', async () => {
    const strict = await appWith(testConfig({ trustProxy: false }));
    try {
      const ip = await strict.inject({
        method: 'GET',
        url: '/__test/ip',
        headers: { 'x-forwarded-for': ALLOWED_IP },
        remoteAddress: REAL_IP,
      });
      expect(ip.json()).toEqual({ ip: REAL_IP });

      const response = await meRequest(strict);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    } finally {
      await strict.close();
    }
  });

  it('trustProxy=true（显式信任代理）：XFF 参与 request.ip，白名单命中放行', async () => {
    const trusted = await appWith(testConfig({ trustProxy: true }));
    try {
      const ip = await trusted.inject({
        method: 'GET',
        url: '/__test/ip',
        headers: { 'x-forwarded-for': ALLOWED_IP },
        remoteAddress: REAL_IP,
      });
      expect(ip.json()).toEqual({ ip: ALLOWED_IP });

      const response = await meRequest(trusted);
      expect(response.statusCode).toBe(200);
    } finally {
      await trusted.close();
    }
  });

  it('TRUST_PROXY 环境变量解析：默认 false，true / 逗号分隔网段原样传递', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
  });
});
