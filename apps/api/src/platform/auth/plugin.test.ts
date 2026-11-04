import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { testConfig } from '../config.js';
import { DEMO_IDS, seed } from '../db/seed.js';
import { createSession } from './session-store.js';

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
});
