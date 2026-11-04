import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { computeAuthz } from '../../platform/authz/service.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * M1-E 员工个人级权限覆盖（D50 / D54③ / D59）：
 *   - 老板可增可减，生效权限立刻反映在 computeAuthz；
 *   - 经理边界：老板 / 经理 / 财务一律 403；普通员工可改；
 *   - 经理边界按 preset_key 判定：岗位改名成「店长」仍被拦；preset_key IS NULL 的旧岗位按名称兜底；
 *   - 非老板不可改自己；授予项必须 ⊆ 调用者自身权限（减权不受限）；
 *   - 无 permission.update → 403；
 *   - If-Match 选填：缺省跳过版本校验并审计 versionChecked=false；非法 / 不匹配仍 409；
 *   - dryRun 不落库但记 dry_run=true 审计（成功与失败都记）；
 *   - 与岗位基线一致的覆盖项会被删除，不留冗余。
 */

const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const SALES_PHONE = '10000000003';
const PUBLIC_BASE_URL = 'https://qingdan.example';

const FINANCE_POSITION_ID = '01900000-0000-7000-8000-000000000018';
const FINANCE_EMPLOYEE_ID = '01900000-0000-7000-8000-000000000025';
/** 预设经理岗，但展示名改成了「店长」：验证边界不再靠名称子串。 */
const RENAMED_MANAGER_POSITION_ID = '01900000-0000-7000-8000-000000000019';
const RENAMED_MANAGER_EMPLOYEE_ID = '01900000-0000-7000-8000-000000000026';

interface OverrideRow {
  domain: string;
  action: string;
  granted: boolean;
  operator_id: string;
}

interface AuditRow {
  action: string;
  object_type: string;
  object_id: string | null;
  result: string;
  actor_id: string;
  tenant_id: string | null;
  dry_run: boolean;
  error_code: string | null;
  changes: Record<string, unknown> | null;
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

describe('platform 员工个人级权限覆盖（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let salesCookie: string;

  async function versionOf(employeeId: string): Promise<number> {
    const result = await test.database.query<{ version: number }>(
      'SELECT version FROM employee WHERE id = $1',
      [employeeId],
    );
    return result.rows[0]!.version;
  }

  function patch(
    cookie: string,
    employeeId: string,
    overrides: ReadonlyArray<{ domain: string; action: string; granted: boolean }>,
    options: { requestId: string; ifMatch?: string; dryRun?: boolean },
  ) {
    const headers: Record<string, string> = {
      cookie,
      origin: PUBLIC_BASE_URL,
      'x-request-id': options.requestId,
    };
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/employees/${employeeId}/permissions${options.dryRun ? '?dryRun=true' : ''}`,
      headers,
      payload: { overrides },
    });
  }

  async function overridesOf(employeeId: string): Promise<OverrideRow[]> {
    const result = await test.database.query<OverrideRow>(
      `SELECT domain, action, granted, operator_id
         FROM employee_permission_override
        WHERE employee_id = $1
        ORDER BY domain, action`,
      [employeeId],
    );
    return result.rows;
  }

  async function auditsOf(requestId: string): Promise<AuditRow[]> {
    const result = await test.database.query<AuditRow>(
      `SELECT action, object_type, object_id, result, actor_id, tenant_id,
              dry_run, error_code, changes
         FROM audit_log
        WHERE request_id = $1`,
      [requestId],
    );
    return result.rows;
  }

  async function scopeHas(
    employeeId: string,
    domain: string,
    action: string,
  ): Promise<boolean> {
    const authz = await computeAuthz(test.database, {
      employeeId,
      tenantId: DEMO_IDS.tenantId,
    });
    expect(authz).not.toBeNull();
    return (authz?.scope ?? []).some(
      (entry) => entry.domain === domain && entry.actions.includes(action as never),
    );
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // seed 只有 老板/经理/销售/纯仓管；补一个「财务」岗位与员工来验经理边界。
    await test.database.query(
      `INSERT INTO position (id, tenant_id, name, kind, is_system, scope, status)
       VALUES ($1, $2, '财务', '预设', true, '租户级', '启用')`,
      [FINANCE_POSITION_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
       VALUES ($1, $2, 'settlement', 'read', true)`,
      [DEMO_IDS.tenantId, FINANCE_POSITION_ID],
    );
    await test.database.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1, $2, '000005', '10000000005', '周财', '在职', false)`,
      [FINANCE_EMPLOYEE_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2, $3, $4)`,
      [DEMO_IDS.tenantId, FINANCE_EMPLOYEE_ID, DEMO_IDS.companyId, FINANCE_POSITION_ID],
    );

    // 预设经理岗改名成「店长」：preset_key 仍为 manager，边界必须照拦。
    await test.database.query(
      `INSERT INTO position (id, tenant_id, name, kind, is_system, scope, status, preset_key)
       VALUES ($1, $2, '店长', '预设', true, '租户级', '启用', 'manager')`,
      [RENAMED_MANAGER_POSITION_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
       VALUES ($1, $2, 'sales', 'read', true)`,
      [DEMO_IDS.tenantId, RENAMED_MANAGER_POSITION_ID],
    );
    await test.database.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1, $2, '000006', '10000000006', '孙店', '在职', false)`,
      [RENAMED_MANAGER_EMPLOYEE_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2, $3, $4)`,
      [
        DEMO_IDS.tenantId,
        RENAMED_MANAGER_EMPLOYEE_ID,
        DEMO_IDS.companyId,
        RENAMED_MANAGER_POSITION_ID,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-perm-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-perm-login-manager');
    salesCookie = await login(app, SALES_PHONE, 'req-perm-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('老板改销售：加一项、减一项都生效，版本 +1，ETag 返回新版本', async () => {
    const version = await versionOf(DEMO_IDS.salesEmployeeId);

    const response = await patch(
      ownerCookie,
      DEMO_IDS.salesEmployeeId,
      [
        { domain: 'audit', action: 'read', granted: true },
        { domain: 'sales', action: 'create', granted: false },
      ],
      { requestId: 'req-perm-owner-sales', ifMatch: String(version) },
    );

    expect(response.statusCode).toBe(204);
    expect(response.headers.etag).toBe(`"${version + 1}"`);

    const rows = await overridesOf(DEMO_IDS.salesEmployeeId);
    expect(rows).toEqual([
      { domain: 'audit', action: 'read', granted: true, operator_id: DEMO_IDS.ownerEmployeeId },
      { domain: 'sales', action: 'create', granted: false, operator_id: DEMO_IDS.ownerEmployeeId },
    ]);
    expect(await versionOf(DEMO_IDS.salesEmployeeId)).toBe(version + 1);

    // computeAuthz 立即反映：新增的 audit.read 出现，减掉的 sales.create 消失。
    expect(await scopeHas(DEMO_IDS.salesEmployeeId, 'audit', 'read')).toBe(true);
    expect(await scopeHas(DEMO_IDS.salesEmployeeId, 'sales', 'create')).toBe(false);

    const audits = await auditsOf('req-perm-owner-sales');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'platform.permission.update',
      object_type: 'employee',
      object_id: DEMO_IDS.salesEmployeeId,
      result: 'success',
      actor_id: DEMO_IDS.ownerEmployeeId,
      tenant_id: DEMO_IDS.tenantId,
      dry_run: false,
    });
    expect(audits[0]!.changes).toMatchObject({ employeeId: DEMO_IDS.salesEmployeeId, self: false });
    expect((audits[0]!.changes as { before: unknown[] }).before).toEqual([]);
    expect((audits[0]!.changes as { after: unknown[] }).after).toHaveLength(2);
  });

  it('经理边界：改老板 / 改自己 / 改财务 / 改名后的经理岗 → 403，原因进 details', async () => {
    const cases = [
      {
        target: DEMO_IDS.ownerEmployeeId,
        reason: 'TARGET_IS_OWNER',
        requestId: 'req-perm-manager-owner',
      },
      {
        // 非老板改自己优先按自我提权报错。
        target: DEMO_IDS.managerEmployeeId,
        reason: 'SELF_ESCALATION_DENIED',
        requestId: 'req-perm-manager-self',
      },
      {
        // 财务岗 preset_key IS NULL（模拟旧库），名称含「财务」→ 过渡兜底仍拦。
        target: FINANCE_EMPLOYEE_ID,
        reason: 'TARGET_IS_FINANCE',
        requestId: 'req-perm-manager-finance',
      },
      {
        // 预设经理岗改名「店长」，preset_key=manager → 仍拦。
        target: RENAMED_MANAGER_EMPLOYEE_ID,
        reason: 'TARGET_IS_MANAGER',
        requestId: 'req-perm-manager-renamed',
      },
    ];

    for (const item of cases) {
      const version = await versionOf(item.target);
      const response = await patch(
        managerCookie,
        item.target,
        [{ domain: 'sales', action: 'read', granted: true }],
        { requestId: item.requestId, ifMatch: String(version) },
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: 'FORBIDDEN',
        details: { reason: item.reason, targetEmployeeId: item.target },
      });
      expect(await overridesOf(item.target)).toEqual([]);
    }

    // 正向对照：经理可改普通员工（纯仓管）。
    const warehouseVersion = await versionOf(DEMO_IDS.warehouseEmployeeId);
    const allowed = await patch(
      managerCookie,
      DEMO_IDS.warehouseEmployeeId,
      [{ domain: 'sales', action: 'read', granted: true }],
      { requestId: 'req-perm-manager-warehouse', ifMatch: String(warehouseVersion) },
    );
    expect(allowed.statusCode).toBe(204);
    expect(await overridesOf(DEMO_IDS.warehouseEmployeeId)).toEqual([
      {
        domain: 'sales',
        action: 'read',
        granted: true,
        operator_id: DEMO_IDS.managerEmployeeId,
      },
    ]);
  });

  it('经理给下属授予自己没有的权限 → 403，details.denied 列被拒项，整单不落库', async () => {
    const before = await overridesOf(DEMO_IDS.warehouseEmployeeId);
    const version = await versionOf(DEMO_IDS.warehouseEmployeeId);

    const response = await patch(
      managerCookie,
      DEMO_IDS.warehouseEmployeeId,
      [
        // 这一项经理自己有：若单独提交应成功。
        { domain: 'audit', action: 'read', granted: true },
        // 经理的 settlement 只有 read，没有 view_price → 越权。
        { domain: 'settlement', action: 'view_price', granted: true },
      ],
      { requestId: 'req-perm-manager-overreach', ifMatch: String(version) },
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      details: {
        denied: [{ domain: 'settlement', action: 'view_price' }],
        targetEmployeeId: DEMO_IDS.warehouseEmployeeId,
      },
    });
    // 整单拒绝：合法的那一项也不得落库，版本不变。
    expect(await overridesOf(DEMO_IDS.warehouseEmployeeId)).toEqual(before);
    expect(await versionOf(DEMO_IDS.warehouseEmployeeId)).toBe(version);
  });

  it('经理给下属授予自己有的权限 → 204', async () => {
    const version = await versionOf(DEMO_IDS.warehouseEmployeeId);

    const response = await patch(
      managerCookie,
      DEMO_IDS.warehouseEmployeeId,
      [{ domain: 'audit', action: 'read', granted: true }],
      { requestId: 'req-perm-manager-subset-ok', ifMatch: String(version) },
    );

    expect(response.statusCode).toBe(204);
    expect(response.headers.etag).toBe(`"${version + 1}"`);
    const rows = await overridesOf(DEMO_IDS.warehouseEmployeeId);
    expect(
      rows.find((row) => row.domain === 'audit' && row.action === 'read'),
    ).toMatchObject({ granted: true, operator_id: DEMO_IDS.managerEmployeeId });
  });

  it('减权不受 ⊆ 限制：经理可撤销下属自己也没有的权限', async () => {
    // 销售岗基线有 sales.view_price，经理自己的 sales 只有 read。
    const version = await versionOf(DEMO_IDS.salesEmployeeId);

    const response = await patch(
      managerCookie,
      DEMO_IDS.salesEmployeeId,
      [{ domain: 'sales', action: 'view_price', granted: false }],
      { requestId: 'req-perm-manager-revoke-not-owned', ifMatch: String(version) },
    );

    expect(response.statusCode).toBe(204);
    const rows = await overridesOf(DEMO_IDS.salesEmployeeId);
    expect(
      rows.find((row) => row.domain === 'sales' && row.action === 'view_price'),
    ).toMatchObject({ granted: false, operator_id: DEMO_IDS.managerEmployeeId });
    expect(await scopeHas(DEMO_IDS.salesEmployeeId, 'sales', 'view_price')).toBe(false);
  });

  it('无 permission.update（销售）→ 403', async () => {
    const version = await versionOf(DEMO_IDS.warehouseEmployeeId);
    const response = await patch(
      salesCookie,
      DEMO_IDS.warehouseEmployeeId,
      [{ domain: 'sales', action: 'read', granted: true }],
      { requestId: 'req-perm-sales-forbidden', ifMatch: String(version) },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('If-Match 选填：缺省跳过版本校验并审计 versionChecked=false；非法 / 不匹配 → 409', async () => {
    const version = await versionOf(DEMO_IDS.warehouseEmployeeId);

    // 不传 If-Match：仍成功，ETag 回新版本，审计标 versionChecked=false。
    const missing = await patch(
      ownerCookie,
      DEMO_IDS.warehouseEmployeeId,
      [{ domain: 'product', action: 'create', granted: true }],
      { requestId: 'req-perm-missing-if-match' },
    );
    expect(missing.statusCode).toBe(204);
    expect(missing.headers.etag).toBe(`"${version + 1}"`);
    const missingAudits = await auditsOf('req-perm-missing-if-match');
    expect(missingAudits).toHaveLength(1);
    expect(missingAudits[0]!.changes).toMatchObject({ versionChecked: false });

    const afterOptional = await overridesOf(DEMO_IDS.warehouseEmployeeId);

    // 传了但格式非法 → 409。
    const malformed = await patch(
      ownerCookie,
      DEMO_IDS.warehouseEmployeeId,
      [{ domain: 'product', action: 'create', granted: true }],
      { requestId: 'req-perm-malformed-if-match', ifMatch: 'abc' },
    );
    expect(malformed.statusCode).toBe(409);
    expect(malformed.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    // 传了但版本不匹配 → 409。
    const conflict = await patch(
      ownerCookie,
      DEMO_IDS.warehouseEmployeeId,
      [{ domain: 'product', action: 'create', granted: true }],
      { requestId: 'req-perm-version-conflict', ifMatch: '99999' },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    // 后两个失败请求都不落库。
    expect(await overridesOf(DEMO_IDS.warehouseEmployeeId)).toEqual(afterOptional);
  });

  it('老板改自己：豁免自我提权 / ⊆ 边界，审计 self=true', async () => {
    const version = await versionOf(DEMO_IDS.ownerEmployeeId);

    const response = await patch(
      ownerCookie,
      DEMO_IDS.ownerEmployeeId,
      [{ domain: 'audit', action: 'read', granted: true }],
      { requestId: 'req-perm-owner-self', ifMatch: String(version) },
    );

    expect(response.statusCode).toBe(204);
    const audits = await auditsOf('req-perm-owner-self');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.changes).toMatchObject({
      employeeId: DEMO_IDS.ownerEmployeeId,
      self: true,
      versionChecked: true,
    });
  });

  it('dryRun：不落库、返回 DryRunResult，并写一条 dry_run=true 审计；失败也记', async () => {
    const version = await versionOf(DEMO_IDS.warehouseEmployeeId);

    const ok = await patch(
      ownerCookie,
      DEMO_IDS.warehouseEmployeeId,
      [{ domain: 'product', action: 'update', granted: true }],
      { requestId: 'req-perm-dry-run-ok', ifMatch: String(version), dryRun: true },
    );
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      dryRun: boolean;
      valid: boolean;
      changes: Array<Record<string, unknown>>;
      errors: unknown[];
    };
    expect(body.dryRun).toBe(true);
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.changes).toEqual([
      {
        operation: 'create',
        entity: 'employee_permission_override',
        id: 'product.update',
        before: null,
        after: { granted: true },
      },
    ]);

    // 不落库：覆盖行与员工版本都不变。
    expect(
      (await overridesOf(DEMO_IDS.warehouseEmployeeId)).some(
        (row) => row.domain === 'product' && row.action === 'update',
      ),
    ).toBe(false);
    expect(await versionOf(DEMO_IDS.warehouseEmployeeId)).toBe(version);

    const okAudits = await auditsOf('req-perm-dry-run-ok');
    expect(okAudits).toHaveLength(1);
    expect(okAudits[0]).toMatchObject({
      action: 'platform.permission.update',
      object_type: 'employee',
      object_id: DEMO_IDS.warehouseEmployeeId,
      result: 'success',
      actor_id: DEMO_IDS.ownerEmployeeId,
      dry_run: true,
    });

    // 失败（经理改老板）同样 200 + valid=false，并记一条 dry_run=true / result=fail 审计。
    const ownerVersion = await versionOf(DEMO_IDS.ownerEmployeeId);
    const failed = await patch(
      managerCookie,
      DEMO_IDS.ownerEmployeeId,
      [{ domain: 'sales', action: 'read', granted: true }],
      { requestId: 'req-perm-dry-run-fail', ifMatch: String(ownerVersion), dryRun: true },
    );
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({
      dryRun: true,
      valid: false,
      changes: [],
      errors: [{ code: 'FORBIDDEN' }],
    });

    const failAudits = await auditsOf('req-perm-dry-run-fail');
    expect(failAudits).toHaveLength(1);
    expect(failAudits[0]).toMatchObject({
      action: 'platform.permission.update',
      object_type: 'employee',
      object_id: DEMO_IDS.ownerEmployeeId,
      result: 'fail',
      error_code: 'FORBIDDEN',
      actor_id: DEMO_IDS.managerEmployeeId,
      dry_run: true,
    });
  });

  it('覆盖项与岗位基线一致 → 删除冗余覆盖行', async () => {
    const version = await versionOf(DEMO_IDS.salesEmployeeId);

    const removed = await patch(
      ownerCookie,
      DEMO_IDS.salesEmployeeId,
      [{ domain: 'sales', action: 'read', granted: false }],
      { requestId: 'req-perm-redundant-create', ifMatch: String(version) },
    );
    expect(removed.statusCode).toBe(204);
    const withOverride = await overridesOf(DEMO_IDS.salesEmployeeId);
    expect(
      withOverride.find((row) => row.domain === 'sales' && row.action === 'read'),
    ).toMatchObject({ granted: false });

    const nextVersion = await versionOf(DEMO_IDS.salesEmployeeId);
    const restored = await patch(
      ownerCookie,
      DEMO_IDS.salesEmployeeId,
      [{ domain: 'sales', action: 'read', granted: true }],
      { requestId: 'req-perm-redundant-delete', ifMatch: String(nextVersion) },
    );
    expect(restored.statusCode).toBe(204);

    const after = await overridesOf(DEMO_IDS.salesEmployeeId);
    expect(after.some((row) => row.domain === 'sales' && row.action === 'read')).toBe(false);
    expect(await scopeHas(DEMO_IDS.salesEmployeeId, 'sales', 'read')).toBe(true);
  });
});
