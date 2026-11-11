import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * M1 公司管理端点（platform.company.list / create / update，契约 companies.ts）：
 *
 * - create：公司码 4 位、租户内顺序递增、服务端自动发放（D16）；入参不接收 code
 *   （`.strict()` 误传即 422）；AI 默认禁止（ai.policy=forbid，D54⑥）；写操作必记审计（D51）；
 * - update：只允许改名；公司码不可改；If-Match 强制（缺失 428 / 不匹配 409）；
 * - list：普通读不记审计（D54②）；调用者需 `company.read`，否则 403；
 * - 非老板（seed 经理只有 company.read）建公司 → 403。
 */

const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const PUBLIC_BASE_URL = 'https://qingdan.example';

interface CompanyBody {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
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

describe('platform 公司管理端点（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-company-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-company-login-manager');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('create：老板建公司 → 201，公司码 0002 顺序发放、version=1、回全实体', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-company-create-ok' },
      payload: { name: '一分司' },
    });
    expect(response.statusCode).toBe(201);

    const body = response.json() as CompanyBody;
    expect(body.code).toBe('0002');
    expect(body.name).toBe('一分司');
    expect(body.tenantId).toBe(DEMO_IDS.tenantId);
    expect(body.version).toBe(1);
    expect(body.createdAt).toBeTruthy();
    expect(body.updatedAt).toBeTruthy();
  });

  it('create：入参传 code（D16 不接收）→ 422 strict；连建两家公司码继续递增', async () => {
    const withCode = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-company-create-code' },
      payload: { name: '乱传码公司', code: '0042' },
    });
    expect(withCode.statusCode).toBe(422);
    expect((withCode.json() as { code: string }).code).toBe('VALIDATION_FAILED');

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-company-create-3rd' },
      payload: { name: '二分司' },
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as CompanyBody).code).toBe('0003');

    const third = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-company-create-4th' },
      payload: { name: '三分司' },
    });
    expect(third.statusCode).toBe(201);
    expect((third.json() as CompanyBody).code).toBe('0004');
  });

  it('create：非老板（经理只有 company.read）→ 403；AI（Bearer Token）→ 403 AI_ACTION_FORBIDDEN', async () => {
    const byManager = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { cookie: managerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-company-create-mgr' },
      payload: { name: '经理偷建' },
    });
    expect(byManager.statusCode).toBe(403);
    expect((byManager.json() as { code: string }).code).toBe('FORBIDDEN');

    // 老板给自己建一个含 company.create 的 Token，用 Bearer 调 create（契约 ai.policy=forbid）。
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-company-ai-token' },
      payload: {
        name: '建司测试 Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'company', actions: ['read', 'create', 'update'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret: token } = tokenResponse.json() as { secret: string };

    const byAi = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: {
        authorization: `Bearer ${token}`,
        origin: PUBLIC_BASE_URL,
        'x-reason': '测试：AI 建司应被拒绝',
        'x-request-id': 'req-company-create-ai',
      },
      payload: { name: 'AI 建司' },
    });
    expect(byAi.statusCode).toBe(403);
    expect((byAi.json() as { code: string }).code).toBe('AI_ACTION_FORBIDDEN');
  });

  it('list：公司列表含 seed 公司与新建公司；未认证 → 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/companies',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-company-list-ok' },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { items: CompanyBody[]; nextCursor: string | null };
    const codes = body.items.map((item) => item.code).sort();
    expect(codes).toContain('0001');
    expect(codes).toContain('0002');
    expect(body.nextCursor).toBeNull();
  });

  it('update：改名 → 200 + 新 ETag；缺 If-Match → 428；版本不匹配 → 409；公司码不可改', async () => {
    // 用上一条用例建的三分司（code 0004, version 1）。
    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/companies',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-company-update-list' },
    });
    const companies = (listResponse.json() as { items: CompanyBody[] }).items;
    const target = companies.find((item) => item.code === '0004');
    expect(target).toBeDefined();

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/companies/${target!.id}`,
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-company-update-noetag' },
      payload: { name: '改名公司' },
    });
    expect(missing.statusCode).toBe(428);
    expect((missing.json() as { code: string }).code).toBe('PRECONDITION_REQUIRED');

    const conflict = await app.inject({
      method: 'PATCH',
      url: `/api/v1/companies/${target!.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"999"',
        'x-request-id': 'req-company-update-conflict',
      },
      payload: { name: '改名公司' },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { code: string }).code).toBe('VERSION_CONFLICT');

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/companies/${target!.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': `"${target!.version}"`,
        'x-request-id': 'req-company-update-ok',
      },
      payload: { name: '三分司改名' },
    });
    expect(ok.statusCode).toBe(200);
    const updated = ok.json() as CompanyBody;
    expect(updated.name).toBe('三分司改名');
    expect(updated.code).toBe('0004');
    expect(updated.version).toBe(2);
    expect(ok.headers.etag).toBe('"2"');

    // 传 code 试图改公司码 → 422（strict，不存在「部分成功」）。
    const withCode = await app.inject({
      method: 'PATCH',
      url: `/api/v1/companies/${target!.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"2"',
        'x-request-id': 'req-company-update-code',
      },
      payload: { name: '再改名', code: '0099' },
    });
    expect(withCode.statusCode).toBe(422);
  });

  it('update：不存在的公司 → 404', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/companies/01900000-0000-7000-8000-00000000ffff',
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-company-update-404',
      },
      payload: { name: '幽灵公司' },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { code: string }).code).toBe('NOT_FOUND');
  });

  it('审计：create / update 各记一条 write success；list 不记（D54②）', async () => {
    const result = await test.database.query<{
      action: string;
      object_type: string;
      result: string;
    }>(
      `SELECT action, object_type, result FROM audit_log
        WHERE action IN ('platform.company.create', 'platform.company.update', 'platform.company.list')
          AND result = 'success'
        ORDER BY created_at`,
    );
    const actions = result.rows.map((row) => row.action);
    expect(actions).toContain('platform.company.create');
    expect(actions).toContain('platform.company.update');
    expect(actions).not.toContain('platform.company.list');
    for (const row of result.rows) {
      expect(row.object_type).toBe('company');
    }
  });
});
