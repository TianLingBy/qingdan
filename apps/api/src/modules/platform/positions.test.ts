import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * M1 岗位（权限模板）端点（platform.position.list / create / update / delete，契约 positions.ts）：
 *
 * - 岗位归 `permission` 功能域（D44），scope = `permission.<动作>`；不新增 position 功能域；
 * - create：权限模板 = 功能域 × 动作（D4）；`view_price` 不进勾选表（422）；同一功能域
 *   重复出现 → 422；presetKey 只接受服务端预设值或 null（D60②）；AI 默认禁止（D54⑥）；
 * - update：presetKey 不可改（入参 strict 收不进来）；If-Match 强制（缺 428 / 不匹配 409）；
 * - delete = 停用（软删除，回实体 + 新 ETag）；被员工占用的岗位不允许删（先查
 *   `employee_company_position` 引用）→ 409 `STATE_CONFLICT` + `reason=POSITION_IN_USE`；
 *   删除审计的 changeSummary 带被删岗位快照（Issue #121）；
 * - 已停用再删幂等成功（与 employee.disable / token.revoke 同口径）；
 * - 写操作 100% 审计（D51）。
 */

const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const SALES_PHONE = '10000000003';
const PUBLIC_BASE_URL = 'https://qingdan.example';

/** seed：销售岗（013，预设）被王芳占用；纯仓管（016）被赵刚占用；采购（017）无人占用。 */
const SALES_POSITION_ID = '01900000-0000-7000-8000-000000000013';
const UNASSIGNED_POSITION_ID = '01900000-0000-7000-8000-000000000017';
const UNKNOWN_UUID = '01900000-0000-7000-8000-00000000ffff';

interface PositionBody {
  id: string;
  tenantId: string;
  name: string;
  presetKey: string | null;
  status: string;
  version: number;
  actions: Array<{ domain: string; actions: string[] }>;
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

describe('platform 岗位（权限模板）端点（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let salesCookie: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-position-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-position-login-manager');
    salesCookie = await login(app, SALES_PHONE, 'req-position-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('create：老板建自定义岗位 → 201，模板回读、presetKey=null、version=1', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-create-ok' },
      payload: {
        name: '开单员',
        actions: [
          { domain: 'sales', actions: ['read', 'create'] },
          { domain: 'customer', actions: ['read'] },
        ],
      },
    });
    expect(response.statusCode).toBe(201);

    const body = response.json() as PositionBody;
    expect(body.name).toBe('开单员');
    expect(body.presetKey).toBeNull();
    expect(body.status).toBe('启用');
    expect(body.version).toBe(1);
    expect(body.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: 'sales', actions: ['create', 'read'] }),
        expect.objectContaining({ domain: 'customer', actions: ['read'] }),
      ]),
    );
  });

  it('create：勾选表带 view_price（D4 不进动作表）→ 422；同一功能域重复 → 422；非法 presetKey → 422', async () => {
    const viewPrice = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-create-vp' },
      payload: {
        name: '看价岗',
        actions: [{ domain: 'sales', actions: ['read', 'view_price'] }],
      },
    });
    expect(viewPrice.statusCode).toBe(422);

    const duplicated = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-create-dup' },
      payload: {
        name: '重复域岗',
        actions: [
          { domain: 'sales', actions: ['read'] },
          { domain: 'sales', actions: ['create'] },
        ],
      },
    });
    expect(duplicated.statusCode).toBe(422);

    const badPreset = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-create-pk' },
      payload: {
        name: '野预设岗',
        actions: [{ domain: 'sales', actions: ['read'] }],
        presetKey: 'boss',
      },
    });
    expect(badPreset.statusCode).toBe(422);
  });

  it('create：非老板（销售无 permission.create）→ 403；AI（Bearer Token）→ 403 AI_ACTION_FORBIDDEN', async () => {
    const bySales = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: { cookie: salesCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-create-sales' },
      payload: {
        name: '销售偷建岗',
        actions: [{ domain: 'sales', actions: ['read'] }],
      },
    });
    expect(bySales.statusCode).toBe(403);
    expect((bySales.json() as { code: string }).code).toBe('FORBIDDEN');

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-ai-token' },
      payload: {
        name: '建岗测试 Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'permission', actions: ['read', 'create', 'update', 'delete'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret: token } = tokenResponse.json() as { secret: string };

    const byAi = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: {
        authorization: `Bearer ${token}`,
        origin: PUBLIC_BASE_URL,
        'x-reason': '测试：AI 建岗应被拒绝',
        'x-request-id': 'req-position-create-ai',
      },
      payload: {
        name: 'AI 岗',
        actions: [{ domain: 'sales', actions: ['read'] }],
      },
    });
    expect(byAi.statusCode).toBe(403);
    expect((byAi.json() as { code: string }).code).toBe('AI_ACTION_FORBIDDEN');
  });

  it('list：岗位列表 + presetKey 过滤；未认证 → 401', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-list-all' },
    });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as { items: PositionBody[]; nextCursor: string | null };
    expect(allBody.items.length).toBeGreaterThanOrEqual(8);
    expect(allBody.nextCursor).toBeNull();

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/positions?presetKey=purchase',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-list-filter' },
    });
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json() as { items: PositionBody[] };
    expect(filteredBody.items.length).toBe(1);
    expect(filteredBody.items[0]!.id).toBe(UNASSIGNED_POSITION_ID);
    expect(filteredBody.items[0]!.presetKey).toBe('purchase');
  });

  it('update：改模板 → 200 + 新 ETag；缺 If-Match → 428；版本不匹配 → 409；改名撞车 → 422', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-update-seed' },
      payload: {
        name: '跟单员',
        actions: [{ domain: 'sales', actions: ['read'] }],
      },
    });
    const position = created.json() as PositionBody;

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/positions/${position.id}`,
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-update-noetag' },
      payload: { name: '跟单员改' },
    });
    expect(missing.statusCode).toBe(428);
    expect((missing.json() as { code: string }).code).toBe('PRECONDITION_REQUIRED');

    const conflict = await app.inject({
      method: 'PATCH',
      url: `/api/v1/positions/${position.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"999"',
        'x-request-id': 'req-position-update-conflict',
      },
      payload: { name: '跟单员改' },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { code: string }).code).toBe('VERSION_CONFLICT');

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/positions/${position.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': `"${position.version}"`,
        'x-request-id': 'req-position-update-ok',
      },
      payload: {
        name: '跟单主管',
        actions: [
          { domain: 'sales', actions: ['read', 'update'] },
          { domain: 'customer', actions: ['read', 'update'] },
        ],
      },
    });
    expect(ok.statusCode).toBe(200);
    const updated = ok.json() as PositionBody;
    expect(updated.name).toBe('跟单主管');
    expect(updated.version).toBe(2);
    expect(ok.headers.etag).toBe('"2"');
    expect(updated.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: 'sales', actions: ['read', 'update'] }),
        expect.objectContaining({ domain: 'customer', actions: ['read', 'update'] }),
      ]),
    );

    // 改名撞上已有岗位名（tenant 内唯一）→ 422。
    const nameTaken = await app.inject({
      method: 'PATCH',
      url: `/api/v1/positions/${position.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"2"',
        'x-request-id': 'req-position-update-taken',
      },
      payload: { name: '老板' },
    });
    expect(nameTaken.statusCode).toBe(422);
  });

  it('delete：未占用岗位停用 → 200 + 新 ETag + 审计带快照；已停用再删幂等', async () => {
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/positions/${UNASSIGNED_POSITION_ID}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-position-delete-ok',
      },
    });
    expect(deleteResponse.statusCode).toBe(200);
    const disabled = deleteResponse.json() as PositionBody;
    expect(disabled.status).toBe('停用');
    expect(disabled.version).toBe(2);
    expect(deleteResponse.headers.etag).toBe('"2"');

    // 幂等：已停用再删直接成功（不再校验版本、不自增）。
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/positions/${UNASSIGNED_POSITION_ID}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-position-delete-again',
      },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as PositionBody).version).toBe(2);

    // 删除审计的 changeSummary 必须带被删岗位快照（Issue #121 验收）。
    const auditRows = await test.database.query<{ changes: string | Record<string, unknown> }>(
      `SELECT changes FROM audit_log
        WHERE action = 'platform.position.delete' AND result = 'success'
        ORDER BY created_at LIMIT 1`,
    );
    const summaryRaw = auditRows.rows[0]?.changes;
    const summary =
      typeof summaryRaw === 'string' ? (JSON.parse(summaryRaw) as Record<string, unknown>) : summaryRaw;
    const snapshot = summary?.snapshot as Record<string, unknown> | undefined;
    expect(snapshot).toBeDefined();
    expect(snapshot?.id).toBe(UNASSIGNED_POSITION_ID);
    expect(snapshot?.name).toBe('采购');
    expect(snapshot?.presetKey).toBe('purchase');
    expect(Array.isArray(snapshot?.actions)).toBe(true);
  });

  it('delete：被员工占用的岗位 → 拒绝且岗位保持启用；不存在 → 404', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/positions/${SALES_POSITION_ID}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-position-delete-inuse',
      },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { code: string; details?: { reason?: string } };
    expect(body.code).toBe('STATE_CONFLICT');
    expect(body.details?.reason).toBe('POSITION_IN_USE');

    // 拒绝后岗位仍是启用（软删除未发生）。
    const check = await test.database.query<{ status: string }>(
      'SELECT status FROM position WHERE id = $1',
      [SALES_POSITION_ID],
    );
    expect(check.rows[0]?.status).toBe('启用');

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/v1/positions/${UNKNOWN_UUID}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-position-delete-404',
      },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('权限：非老板（销售无 permission.*）列表 403、停用 403；经理（permission.read）可列表不可改', async () => {
    const salesList = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: { cookie: salesCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-list-sales' },
    });
    expect(salesList.statusCode).toBe(403);

    const salesDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/positions/${SALES_POSITION_ID}`,
      headers: {
        cookie: salesCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-position-delete-sales',
      },
    });
    expect(salesDelete.statusCode).toBe(403);

    const managerList = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: { cookie: managerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-position-list-mgr' },
    });
    expect(managerList.statusCode).toBe(200);

    const managerDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/positions/${SALES_POSITION_ID}`,
      headers: {
        cookie: managerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-position-delete-mgr',
      },
    });
    expect(managerDelete.statusCode).toBe(403);
  });
});
