import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * M1-C API Token（D52 / D52.1 / D54）：
 *   - scope 超出创建人授权 → 403，不静默裁剪；
 *   - 创建只返回一次明文，库里只存 sha256 + 8 位前缀；
 *   - 列表不返回 hash / 明文，游标分页、按 id 倒序；
 *   - revoke 的 428 / 409 / 成功 / 幂等；
 *   - 每个成功写操作都有审计。
 */

const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';
const PUBLIC_BASE_URL = 'https://qingdan.example';

interface ApiTokenRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  name: string;
  scope: unknown;
  token_hash: string;
  token_prefix: string | null;
  status: string;
  version: number;
  created_by: string;
  revoked_at: Date | string | null;
}

interface AuditRow {
  action: string;
  object_type: string;
  object_id: string | null;
  result: string;
  actor_id: string;
  tenant_id: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function login(
  app: FastifyInstance,
  phone: string,
  requestId: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

describe('platform API Token（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;

  async function createToken(
    cookie: string,
    requestId: string,
    body: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId },
      payload: body,
    });
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-token-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-token-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('scope 超出创建人授权 → 403 FORBIDDEN（不静默裁剪）', async () => {
    const response = await createToken(salesCookie, 'req-token-scope-overreach', {
      name: '越权 Token',
      employeeId: DEMO_IDS.salesEmployeeId,
      scope: [{ domain: 'settlement', actions: ['create'] }],
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });

    const rows = await test.database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM api_token WHERE name = $1',
      ['越权 Token'],
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('非本人代建且无 api_integration.create → 403', async () => {
    const response = await createToken(salesCookie, 'req-token-create-other', {
      name: '代建 Token',
      employeeId: DEMO_IDS.ownerEmployeeId,
      scope: [{ domain: 'sales', actions: ['read'] }],
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('创建成功：201 + 明文只返回一次，库里只有 sha256 与前缀', async () => {
    const response = await createToken(ownerCookie, 'req-token-create-ok', {
      name: 'CI Token',
      employeeId: DEMO_IDS.ownerEmployeeId,
      scope: [{ domain: 'sales', actions: ['read', 'create'] }],
      ipAllowlist: ['127.0.0.1'],
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      id: string;
      tenantId: string;
      employeeId: string;
      name: string;
      scope: Array<{ domain: string; actions: string[] }>;
      expiresAt: string | null;
      ipAllowlist: string[];
      lastUsedAt: string | null;
      status: string;
      createdBy: string;
      revokedAt: string | null;
      createdAt: string;
      secret: string;
    };

    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      employeeId: DEMO_IDS.ownerEmployeeId,
      name: 'CI Token',
      scope: [{ domain: 'sales', actions: ['read', 'create'] }],
      expiresAt: null,
      ipAllowlist: ['127.0.0.1'],
      lastUsedAt: null,
      status: 'active',
      createdBy: DEMO_IDS.ownerEmployeeId,
      revokedAt: null,
    });
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    // 契约里没有的敏感字段一律不返回。
    expect(body).not.toHaveProperty('tokenHash');
    expect(body).not.toHaveProperty('token_hash');
    expect(body).not.toHaveProperty('tokenPrefix');

    const rows = await test.database.query<ApiTokenRow>(
      'SELECT * FROM api_token WHERE id = $1',
      [body.id],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.token_hash).toBe(sha256(body.secret));
    expect(row.token_prefix).toBe(body.secret.slice(0, 8));
    expect(row.status).toBe('active');
    expect(row.version).toBe(1);
    expect(row.created_by).toBe(DEMO_IDS.ownerEmployeeId);

    const audits = await test.database.query<AuditRow>(
      `SELECT action, object_type, object_id, result, actor_id, tenant_id
         FROM audit_log WHERE request_id = $1`,
      ['req-token-create-ok'],
    );
    expect(audits.rows).toEqual([
      {
        action: 'platform.token.create',
        object_type: 'api_token',
        object_id: body.id,
        result: 'success',
        actor_id: DEMO_IDS.ownerEmployeeId,
        tenant_id: DEMO_IDS.tenantId,
      },
    ]);
  });

  it('列表：不返回 hash / 明文；游标分页按 id 倒序', async () => {
    for (const index of [1, 2, 3]) {
      const created = await createToken(ownerCookie, `req-token-page-create-${index}`, {
        name: `分页 Token ${index}`,
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'sales', actions: ['read'] }],
      });
      expect(created.statusCode).toBe(201);
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/api-tokens?limit=2',
      headers: { cookie: ownerCookie, 'x-request-id': 'req-token-list-page1' },
    });
    expect(response.statusCode).toBe(200);
    const first = response.json() as {
      items: Array<Record<string, unknown> & { id: string }>;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const serialized = JSON.stringify(first.items);
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('tokenPrefix');
    expect(serialized).not.toContain('secret');
    for (const item of first.items) {
      expect(item).not.toHaveProperty('secret');
      expect(item).not.toHaveProperty('tokenHash');
      expect(item).not.toHaveProperty('token_hash');
    }

    // 与库里的 id 倒序一致。
    const expected = await test.database.query<{ id: string }>(
      'SELECT id FROM api_token WHERE tenant_id = $1 ORDER BY id DESC LIMIT 2',
      [DEMO_IDS.tenantId],
    );
    expect(first.items.map((item) => item.id)).toEqual(expected.rows.map((row) => row.id));

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/api-tokens?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
      headers: { cookie: ownerCookie, 'x-request-id': 'req-token-list-page2' },
    });
    expect(second.statusCode).toBe(200);
    const next = second.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(next.items.length).toBeGreaterThan(0);
    const seen = new Set(first.items.map((item) => item.id));
    for (const item of next.items) expect(seen.has(item.id)).toBe(false);

    const audit = await test.database.query<AuditRow>(
      `SELECT action, object_type, object_id, result, actor_id, tenant_id
         FROM audit_log WHERE request_id = $1`,
      ['req-token-list-page1'],
    );
    expect(audit.rows).toEqual([
      {
        action: 'platform.token.read',
        object_type: 'api_token',
        object_id: null,
        result: 'success',
        actor_id: DEMO_IDS.ownerEmployeeId,
        tenant_id: DEMO_IDS.tenantId,
      },
    ]);
  });

  it('撤销：缺 If-Match → 428，版本不符 → 409，成功后 version+1 / status=revoked，重复撤销幂等', async () => {
    const created = await createToken(ownerCookie, 'req-token-revoke-create', {
      name: '待撤销 Token',
      employeeId: DEMO_IDS.ownerEmployeeId,
      scope: [{ domain: 'sales', actions: ['read'] }],
    });
    expect(created.statusCode).toBe(201);
    const tokenId = (created.json() as { id: string }).id;

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-tokens/${tokenId}`,
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-token-revoke-428' },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const conflict = await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-tokens/${tokenId}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"99"',
        'x-request-id': 'req-token-revoke-409',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    // 失败请求不改状态。
    const before = await test.database.query<ApiTokenRow>(
      'SELECT status, version FROM api_token WHERE id = $1',
      [tokenId],
    );
    expect(before.rows[0]).toMatchObject({ status: 'active', version: 1 });

    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-tokens/${tokenId}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-token-revoke-ok',
      },
    });
    expect(ok.statusCode).toBe(204);

    const revoked = await test.database.query<ApiTokenRow>(
      'SELECT status, version, revoked_at FROM api_token WHERE id = $1',
      [tokenId],
    );
    expect(revoked.rows[0]!.status).toBe('revoked');
    expect(revoked.rows[0]!.version).toBe(2);
    expect(revoked.rows[0]!.revoked_at).not.toBeNull();

    // 幂等：同一 If-Match 重试仍成功，版本不再变化。
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-tokens/${tokenId}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-token-revoke-again',
      },
    });
    expect(again.statusCode).toBe(204);

    const after = await test.database.query<ApiTokenRow>(
      'SELECT status, version FROM api_token WHERE id = $1',
      [tokenId],
    );
    expect(after.rows[0]).toMatchObject({ status: 'revoked', version: 2 });

    const audits = await test.database.query<AuditRow>(
      `SELECT action, object_type, object_id, result, actor_id, tenant_id
         FROM audit_log
        WHERE request_id IN ($1, $2)`,
      ['req-token-revoke-ok', 'req-token-revoke-again'],
    );
    expect(audits.rows).toHaveLength(2);
    for (const row of audits.rows) {
      expect(row).toMatchObject({
        action: 'platform.token.revoke',
        object_type: 'api_token',
        object_id: tokenId,
        result: 'success',
        actor_id: DEMO_IDS.ownerEmployeeId,
        tenant_id: DEMO_IDS.tenantId,
      });
    }
  });

  it('撤销不存在的 Token → 404', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/api-tokens/01900000-0000-7000-8000-00000000ffff',
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-token-revoke-404',
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
