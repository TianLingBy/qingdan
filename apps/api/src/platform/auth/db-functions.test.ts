import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { DEMO_IDS, seed } from '../db/seed.js';
import { createSession, hashSessionToken } from './session-store.js';

/**
 * 0002 迁移的数据库地基实测（D59①②）：
 *   - SECURITY DEFINER 函数在「普通角色 + 无 app.tenant_id」下仍能跨 RLS 取到登录/凭证行；
 *   - 但 RLS 没有被放宽：直接 SELECT employee / session 仍然是 0 行；
 *   - audit_log 基表对 qingdan_app 仍不可 SELECT，只读视图可查询且按租户过滤。
 */

const OTHER_TENANT = '01900000-0000-7000-8000-0000000009a9';

describe('0002 迁移：SECURITY DEFINER 函数 + 审计视图（普通角色实测）', () => {
  let test: TestDatabase;
  let sessionToken: string;
  let sessionHash: string;
  let apiTokenId: string;
  let apiTokenHash: string;
  let ownerPhone: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);

    const phone = await test.database.query<{ phone: string }>(
      'SELECT phone FROM employee WHERE id = $1',
      [DEMO_IDS.ownerEmployeeId],
    );
    ownerPhone = phone.rows[0]!.phone;

    const session = await createSession(test.database, {
      tenantId: DEMO_IDS.tenantId,
      employeeId: DEMO_IDS.ownerEmployeeId,
      ttlDays: 7,
    });
    sessionToken = session.token;
    sessionHash = hashSessionToken(session.token);

    apiTokenId = uuidv7();
    const apiToken = 'a'.repeat(64);
    apiTokenHash = hashSessionToken(apiToken);
    await test.database.query(
      `INSERT INTO api_token
         (id, tenant_id, employee_id, name, scope, token_hash, status, created_by)
       VALUES ($1, $2, $3, '迁移测试 token', $4::jsonb, $5, 'active', $3)`,
      [
        apiTokenId,
        DEMO_IDS.tenantId,
        DEMO_IDS.ownerEmployeeId,
        JSON.stringify([{ domain: 'sales', actions: ['read'] }]),
        apiTokenHash,
      ],
    );

    // 审计日志：本租户 + 另一租户各一条，用于验证视图的租户过滤。
    for (const [id, tenantId] of [
      [uuidv7(), DEMO_IDS.tenantId],
      [uuidv7(), OTHER_TENANT],
    ] as const) {
      await test.database.query(
        `INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, source, action, object_type, result, request_id)
         VALUES ($1, $2, 'employee', $3, 'api', 'test.view', 'test', 'success', 'req-mig')`,
        [id, tenantId, DEMO_IDS.ownerEmployeeId],
      );
    }
  });

  afterAll(async () => {
    await test.database.close();
  });

  beforeEach(async () => {
    await test.database.exec('RESET ROLE');
    await test.database.query(`SELECT set_config('app.tenant_id', '', false)`);
  });

  /** 以 qingdan_app 执行；`tenantId` 为空串 = 不设置租户上下文。 */
  async function asAppRole<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    await test.database.exec('SET ROLE qingdan_app');
    try {
      await test.database.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
      return await fn();
    } finally {
      await test.database.query(`SELECT set_config('app.tenant_id', '', false)`);
      await test.database.exec('RESET ROLE');
    }
  }

  it('auth_find_login 在无租户上下文下返回登录行；直接 SELECT employee 仍 0 行', async () => {
    const login = await asAppRole('', async () =>
      test.database.query<{
        tenant_id: string;
        employee_id: string;
        employee_name: string;
        employee_status: string;
        tenant_status: string;
      }>('SELECT * FROM auth_find_login($1)', [ownerPhone]),
    );

    expect(login.rows).toHaveLength(1);
    expect(login.rows[0]).toMatchObject({
      tenant_id: DEMO_IDS.tenantId,
      employee_id: DEMO_IDS.ownerEmployeeId,
      employee_status: '在职',
      tenant_status: '启用',
    });

    // RLS 未放宽：普通角色直接查 employee 依旧看不到任何行。
    const direct = await asAppRole('', async () =>
      test.database.query<{ id: string }>('SELECT id FROM employee'),
    );
    expect(direct.rows).toHaveLength(0);
  });

  it('auth_resolve_session 在无租户上下文下按哈希返回会话；直接 SELECT session 仍 0 行', async () => {
    const resolved = await asAppRole('', async () =>
      test.database.query<{ id: string; tenant_id: string; employee_id: string }>(
        'SELECT * FROM auth_resolve_session($1)',
        [sessionHash],
      ),
    );

    expect(resolved.rows).toHaveLength(1);
    expect(resolved.rows[0]).toMatchObject({
      tenant_id: DEMO_IDS.tenantId,
      employee_id: DEMO_IDS.ownerEmployeeId,
    });

    const direct = await asAppRole('', async () =>
      test.database.query<{ id: string }>('SELECT id FROM session'),
    );
    expect(direct.rows).toHaveLength(0);

    // 明文令牌不是查找键：按原始令牌查不到。
    const plaintext = await asAppRole('', async () =>
      test.database.query<{ id: string }>('SELECT * FROM auth_resolve_session($1)', [sessionToken]),
    );
    expect(plaintext.rows).toHaveLength(0);
  });

  it('auth_resolve_api_token 在无租户上下文下返回凭证行；直接 SELECT api_token 仍 0 行', async () => {
    const resolved = await asAppRole('', async () =>
      test.database.query<{
        id: string;
        tenant_id: string;
        employee_id: string;
        scope: unknown;
        status: string;
      }>('SELECT * FROM auth_resolve_api_token($1)', [apiTokenHash]),
    );

    expect(resolved.rows).toHaveLength(1);
    expect(resolved.rows[0]).toMatchObject({
      id: apiTokenId,
      tenant_id: DEMO_IDS.tenantId,
      employee_id: DEMO_IDS.ownerEmployeeId,
      status: 'active',
    });

    const direct = await asAppRole('', async () =>
      test.database.query<{ id: string }>('SELECT id FROM api_token'),
    );
    expect(direct.rows).toHaveLength(0);
  });

  it('audit_log 基表对 qingdan_app 仍不可 SELECT；audit_log_view 可查询且按租户过滤', async () => {
    const privileges = await test.database.query<{
      base_select: boolean;
      view_select: boolean;
    }>(
      `SELECT has_table_privilege('qingdan_app', 'audit_log', 'SELECT') AS base_select,
              has_table_privilege('qingdan_app', 'audit_log_view', 'SELECT') AS view_select`,
    );
    expect(privileges.rows[0]).toEqual({ base_select: false, view_select: true });

    // 基表直接读：权限拒绝（不只是 RLS 0 行）。
    await expect(
      asAppRole(DEMO_IDS.tenantId, async () =>
        test.database.query('SELECT id FROM audit_log'),
      ),
    ).rejects.toThrow(/permission denied/i);

    // 视图可读：只看到 app.tenant_id 对应租户的行。
    const visible = await asAppRole(DEMO_IDS.tenantId, async () =>
      test.database.query<{ tenant_id: string }>('SELECT tenant_id FROM audit_log_view'),
    );
    expect(visible.rows).toHaveLength(1);
    expect(visible.rows[0]!.tenant_id).toBe(DEMO_IDS.tenantId);

    // 未设置租户上下文时 fail-closed。
    const failClosed = await asAppRole('', async () =>
      test.database.query<{ tenant_id: string }>('SELECT tenant_id FROM audit_log_view'),
    );
    expect(failClosed.rows).toHaveLength(0);
  });
});
