import { AppError, ROUTES } from '@qingdan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { testConfig } from './platform/config.js';
import { assertAuditReason, auditContextFrom } from './platform/http/audit-context.js';

const TEST_VERSION = '9.9.9';

describe('HTTP 骨架（buildApp + app.inject）', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp({
      config: testConfig(),
      version: TEST_VERSION,
      requestIdFactory: () => 'req-fixed-0001',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health → 200 {status:ok,version}，并带 requestId / 安全头', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: TEST_VERSION });
    expect(response.headers['x-request-id']).toBe('req-fixed-0001');
    expect(response.headers['x-powered-by']).toBe('qingdan-api');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET /api/v1/openapi.json → buildOpenApiDocument(ROUTES) 真发射', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const document = response.json() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string; security: unknown[] }>>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };

    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toHaveLength(new Set(ROUTES.map((route) => route.path)).size);
    const operations = Object.values(document.paths).flatMap((pathItem) => Object.values(pathItem));
    expect(operations).toHaveLength(ROUTES.length);
    expect(operations.map((operation) => operation.operationId).sort()).toEqual(
      ROUTES.map((route) => route.operationId).sort(),
    );
    expect(document.components.securitySchemes).toHaveProperty('bearerAuth');
    expect(document.components.schemas).toHaveProperty('AuditLog');
  });

  it('未实现的已登记端点 → 501 NOT_IMPLEMENTED 统一错误体', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: '10000000001', code: '123456' },
    });

    expect(response.statusCode).toBe(501);
    const body = response.json() as {
      code: string;
      message: string;
      requestId: string;
      details?: Record<string, unknown>;
    };
    expect(body.code).toBe('NOT_IMPLEMENTED');
    expect(body.requestId).toBe('req-fixed-0001');
    expect(body.message).toContain('platform.auth.login');
    expect(body.details).toMatchObject({ operationId: 'platform.auth.login' });
    expect(body).not.toHaveProperty('stack');
  });

  it('带 If-Match 的 PATCH 端点同样先返 501（不因前置条件提前失败）', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/employees/00000000-0000-7000-8000-000000000001/permissions',
      headers: { 'if-match': '"1"' },
      payload: { overrides: [] },
    });
    expect(response.statusCode).toBe(501);
    expect((response.json() as { code: string }).code).toBe('NOT_IMPLEMENTED');
  });

  it('未知路由 → 404 NOT_FOUND（统一错误体，不泄露路由表）', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    const body = response.json() as { code: string; requestId: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(body.requestId).toBe('req-fixed-0001');
  });

  it('客户端 X-Request-Id 原样透传', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'client-trace-abc' },
    });
    expect(response.headers['x-request-id']).toBe('client-trace-abc');
  });

  it('缺省 request id 是 UUIDv7', async () => {
    const plain = buildApp({ config: testConfig(), version: TEST_VERSION });
    try {
      const response = await plain.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      await plain.close();
    }
  });

  it('请求体非法 JSON → 422 VALIDATION_FAILED（不落 500）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    });

    expect(response.statusCode).toBe(422);
    expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('未知异常 → 500 INTERNAL_ERROR，响应不泄露栈与内部消息', async () => {
    // 测试专用探针路由（不挂在 /api/v1，不进入契约注册表）。
    const probe = buildApp({ config: testConfig(), requestIdFactory: () => 'req-err-0001' });
    probe.get('/__probe_boom', async () => {
      throw new Error('boom: secret internal detail C:\\very\\secret\\path');
    });

    try {
      const response = await probe.inject({ method: 'GET', url: '/__probe_boom' });
      expect(response.statusCode).toBe(500);
      const body = response.json() as Record<string, unknown>;
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.requestId).toBe('req-err-0001');
      expect(body).not.toHaveProperty('stack');
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(JSON.stringify(body)).not.toContain('boom');
    } finally {
      await probe.close();
    }
  });
});

describe('审计上下文（X-Client / X-Reason，契约 D54 §9-4）', () => {
  it('X-Client 经契约映射成审计 source，未知/缺失 = api', () => {
    const withCli = { headers: { 'x-client': 'cli', 'x-reason': '  补录漏单  ' } } as unknown as FastifyRequest;
    expect(auditContextFrom(withCli)).toEqual({ source: 'cli', reason: '补录漏单' });

    const empty = { headers: {} } as unknown as FastifyRequest;
    expect(auditContextFrom(empty)).toEqual({ source: 'api', reason: null });

    const unknown = { headers: { 'x-client': 'robot' } } as unknown as FastifyRequest;
    expect(auditContextFrom(unknown)).toEqual({ source: 'api', reason: null });
  });

  it('AI 写操作缺 X-Reason → 抛 VALIDATION_FAILED；人类写操作不要求', () => {
    expect(() =>
      assertAuditReason({ kind: 'write', actorType: 'ai', reason: null, operationId: 'sales.create' }),
    ).toThrowError(AppError);

    expect(() =>
      assertAuditReason({ kind: 'write', actorType: 'employee', reason: null }),
    ).not.toThrow();

    expect(() =>
      assertAuditReason({ kind: 'none', actorType: 'ai', reason: null }),
    ).not.toThrow();

    expect(() =>
      assertAuditReason({ kind: 'write', actorType: 'ai', reason: 'AI 代跑批' }),
    ).not.toThrow();

    // M0 尚未接认证：actorType 未解析时闸门保持放行，端点仍统一 501。
    expect(() => assertAuditReason({ kind: 'write', actorType: undefined, reason: null })).not.toThrow();
  });
});
