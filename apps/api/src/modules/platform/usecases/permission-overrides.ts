import {
  ACTION_KEYS,
  AppError,
  DOMAIN_KEYS,
  allowsScope,
  etagOf,
  type DryRunResult,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { recordAudit, withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';

/**
 * 员工个人级权限覆盖（D50 / D54③ / D59）。
 *
 * 生效权限 = 岗位并集基线 ⊕ 个人覆盖（`computeAuthz` 已按此实现）。本用例只维护「差异项」：
 *   - 新 granted 与基线一致 ⇒ 删除覆盖行（表里永远只剩真正的差异）；
 *   - 不一致 ⇒ upsert 覆盖行。
 *
 * 边界（服务端判定，前端隐藏不算数）：
 *   - 调用者必须有 `permission.update`；
 *   - 非老板不可改老板（is_owner=true）、经理岗位、财务岗位持有者 —— 403，原因进 details；
 *   - 老板可改同租户任何员工（含自己，审计标 self=true）。
 * 并发：强 ETag `"<version>"`；缺 If-Match → 428，不匹配 → 409；成功后 employee.version+1。
 * dryRun：与真实执行走同一条判定路径，只不落库；成功 / 失败都回 200 + DryRunResult，
 *         且都写一条 `dry_run=true` 审计（D54③）。
 */

type DryRunChange = DryRunResult['changes'][number];
type DryRunIssue = DryRunResult['errors'][number];

const ACTION = 'platform.permission.update';
const OBJECT_TYPE = 'employee';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAIN_KEYS);
const ACTION_SET: ReadonlySet<string> = new Set(ACTION_KEYS);

export interface PermissionOverrideContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

interface OverrideInput {
  readonly domain: string;
  readonly action: string;
  readonly granted: boolean;
}

interface OverrideItem {
  domain: string;
  action: string;
  granted: boolean;
}

interface TargetRow {
  is_owner: boolean;
  version: number;
  is_manager: boolean;
  is_finance: boolean;
}

const BOUNDARY_REASON = {
  owner: 'TARGET_IS_OWNER',
  manager: 'TARGET_IS_MANAGER',
  finance: 'TARGET_IS_FINANCE',
} as const;

interface PlannedChange {
  readonly operation: 'create' | 'update' | 'delete';
  readonly domain: string;
  readonly action: string;
  readonly before: { granted: boolean } | null;
  readonly after: { granted: boolean } | null;
}

interface PlanResult {
  readonly changes: PlannedChange[];
  readonly before: OverrideItem[];
  readonly after: OverrideItem[];
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: PermissionOverrideContext): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${ACTION} 不可用`, { operationId: ACTION });
  }
  return database;
}

/** AI 不得直接改权限（契约 `ai.policy = forbid`，D54⑥）。 */
function assertHumanCredential(principal: Principal): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接修改员工权限');
  }
}

function parseEmployeeId(request: FastifyRequest): string {
  const params = request.params as { employeeId?: unknown };
  const employeeId = typeof params.employeeId === 'string' ? params.employeeId : '';
  if (!UUID_RE.test(employeeId)) {
    throw new AppError('VALIDATION_FAILED', 'employeeId 必须是合法 uuid', { field: 'employeeId' });
  }
  return employeeId;
}

function parseIfMatchVersion(request: FastifyRequest): number {
  const raw = headerValue(request, 'if-match');
  if (raw === undefined || raw.trim() === '') {
    throw new AppError('PRECONDITION_REQUIRED', '修改权限必须携带 If-Match（强 ETag "<version>"）');
  }
  const match = /^"([0-9]+)"$/.exec(raw.trim());
  if (!match) {
    throw new AppError('VERSION_CONFLICT', 'If-Match 格式不合法，应为强 ETag "<version>"', {
      ifMatch: raw,
    });
  }
  return Number(match[1]);
}

/** dryRun 可通过 query（CLI 口径 `?dryRun=true`）或 body 布尔字段声明。 */
function isDryRun(request: FastifyRequest): boolean {
  const query = request.query as Record<string, unknown> | undefined;
  if (query && (query.dryRun === true || query.dryRun === 'true')) return true;
  const body = request.body;
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).dryRun === true
  );
}

function parseOverrides(body: unknown): OverrideInput[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象');
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.overrides)) {
    throw new AppError('VALIDATION_FAILED', 'overrides 必须是数组', { field: 'overrides' });
  }

  const issues: Array<{ path: string; message: string }> = [];
  const parsed: OverrideInput[] = [];
  record.overrides.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push({ path: `overrides.${index}`, message: '必须是对象' });
      return;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.domain !== 'string' || !DOMAIN_SET.has(item.domain)) {
      issues.push({ path: `overrides.${index}.domain`, message: '未知功能域' });
      return;
    }
    if (typeof item.action !== 'string' || !ACTION_SET.has(item.action)) {
      issues.push({ path: `overrides.${index}.action`, message: '未知动作' });
      return;
    }
    if (typeof item.granted !== 'boolean') {
      issues.push({ path: `overrides.${index}.granted`, message: '必须是布尔值' });
      return;
    }
    parsed.push({ domain: item.domain, action: item.action, granted: item.granted });
  });

  if (issues.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'overrides 不合法', { field: 'overrides', issues });
  }
  return parsed;
}

/** 同一 domain+action 重复出现时以最后一次为准（契约未禁止重复）。 */
function dedupe(inputs: readonly OverrideInput[]): OverrideInput[] {
  const byKey = new Map<string, OverrideInput>();
  for (const input of inputs) byKey.set(`${input.domain}.${input.action}`, input);
  return [...byKey.values()];
}

async function loadCallerIsOwner(
  tx: SqlClient,
  employeeId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await tx.query<{ is_owner: boolean }>(
    'SELECT is_owner FROM employee WHERE id = $1 AND tenant_id = $2',
    [employeeId, tenantId],
  );
  return result.rows[0]?.is_owner === true;
}

async function loadTarget(tx: SqlClient, employeeId: string, tenantId: string): Promise<TargetRow> {
  const result = await tx.query<TargetRow>(
    `SELECT e.is_owner,
            e.version,
            EXISTS (
              SELECT 1
                FROM employee_company_position ecp
                JOIN position p ON p.id = ecp.position_id AND p.tenant_id = ecp.tenant_id
               WHERE ecp.employee_id = e.id
                 AND ecp.tenant_id = e.tenant_id
                 AND p.name LIKE '%经理%'
            ) AS is_manager,
            EXISTS (
              SELECT 1
                FROM employee_company_position ecp
                JOIN position p ON p.id = ecp.position_id AND p.tenant_id = ecp.tenant_id
               WHERE ecp.employee_id = e.id
                 AND ecp.tenant_id = e.tenant_id
                 AND p.name LIKE '%财务%'
            ) AS is_finance
       FROM employee e
      WHERE e.id = $1 AND e.tenant_id = $2`,
    [employeeId, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('NOT_FOUND', '目标员工不存在');
  return row;
}

async function loadBaseline(
  tx: SqlClient,
  employeeId: string,
  tenantId: string,
): Promise<Set<string>> {
  const result = await tx.query<{ domain: string; action: string }>(
    `SELECT DISTINCT pp.domain, pp.action
       FROM employee_company_position ecp
       JOIN position_permission pp
         ON pp.position_id = ecp.position_id AND pp.tenant_id = ecp.tenant_id
      WHERE ecp.employee_id = $1
        AND ecp.tenant_id = $2
        AND pp.granted`,
    [employeeId, tenantId],
  );
  return new Set(result.rows.map((row) => `${row.domain}.${row.action}`));
}

async function loadOverrides(
  tx: SqlClient,
  employeeId: string,
  tenantId: string,
): Promise<OverrideItem[]> {
  const result = await tx.query<OverrideItem>(
    `SELECT domain, action, granted
       FROM employee_permission_override
      WHERE employee_id = $1 AND tenant_id = $2
      ORDER BY domain, action`,
    [employeeId, tenantId],
  );
  return result.rows;
}

/** D50 经理边界：非老板不得改老板 / 经理 / 财务；老板全权（含改自己）。 */
function assertBoundary(callerIsOwner: boolean, targetId: string, target: TargetRow): void {
  if (callerIsOwner) return;
  let reason: (typeof BOUNDARY_REASON)[keyof typeof BOUNDARY_REASON] | null = null;
  if (target.is_owner) reason = BOUNDARY_REASON.owner;
  else if (target.is_manager) reason = BOUNDARY_REASON.manager;
  else if (target.is_finance) reason = BOUNDARY_REASON.finance;
  if (reason) {
    throw new AppError('FORBIDDEN', '经理只能调整普通员工的权限，不可修改老板、财务或其他经理', {
      reason,
      targetEmployeeId: targetId,
    });
  }
}

/** 计算「差异项」写入计划；dryRun 与真实执行共用。 */
function planChanges(
  inputs: readonly OverrideInput[],
  baseline: ReadonlySet<string>,
  existing: readonly OverrideItem[],
): PlanResult {
  const existingByKey = new Map(existing.map((item) => [`${item.domain}.${item.action}`, item]));
  const after = new Map(existingByKey);
  const changes: PlannedChange[] = [];

  for (const input of inputs) {
    const key = `${input.domain}.${input.action}`;
    const current = existingByKey.get(key);
    const inBaseline = baseline.has(key);

    if (input.granted === inBaseline) {
      // 与岗位基线一致 ⇒ 不留冗余覆盖行。
      if (current) {
        changes.push({
          operation: 'delete',
          domain: input.domain,
          action: input.action,
          before: { granted: current.granted },
          after: null,
        });
        after.delete(key);
      }
      continue;
    }

    changes.push({
      operation: current ? 'update' : 'create',
      domain: input.domain,
      action: input.action,
      before: current ? { granted: current.granted } : null,
      after: { granted: input.granted },
    });
    after.set(key, { domain: input.domain, action: input.action, granted: input.granted });
  }

  const sortedAfter = [...after.values()].sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.action.localeCompare(b.action),
  );
  return { changes, before: [...existing], after: sortedAfter };
}

async function applyChanges(
  tx: SqlClient,
  employeeId: string,
  tenantId: string,
  operatorId: string,
  changes: readonly PlannedChange[],
): Promise<void> {
  for (const change of changes) {
    if (change.operation === 'delete') {
      await tx.query(
        `DELETE FROM employee_permission_override
          WHERE employee_id = $1 AND tenant_id = $2 AND domain = $3 AND action = $4`,
        [employeeId, tenantId, change.domain, change.action],
      );
      continue;
    }
    await tx.query(
      `INSERT INTO employee_permission_override
         (tenant_id, employee_id, domain, action, granted, operator_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (employee_id, domain, action)
       DO UPDATE SET granted = EXCLUDED.granted,
                     operator_id = EXCLUDED.operator_id,
                     updated_at = now()`,
      [tenantId, employeeId, change.domain, change.action, change.after!.granted, operatorId],
    );
  }
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  targetId: string,
  options: {
    readonly dryRun: boolean;
    readonly result: 'success' | 'fail';
    readonly errorCode?: string | null;
    readonly changeSummary: Record<string, unknown>;
  },
): AuditEvent {
  return {
    tenantId: principal.tenantId,
    actorType: principal.actorType,
    actorId: principal.actorId,
    credentialId: principal.credentialId,
    source: request.auditSource,
    action: ACTION,
    objectType: OBJECT_TYPE,
    objectId: targetId,
    changeSummary: options.changeSummary,
    result: options.result,
    errorCode: options.errorCode ?? null,
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: headerValue(request, 'user-agent') ?? null,
    reason: request.auditReason,
    dryRun: options.dryRun,
  };
}

function summaryOf(
  targetId: string,
  self: boolean,
  before: readonly OverrideItem[],
  after: readonly OverrideItem[],
  changes: readonly PlannedChange[],
): Record<string, unknown> {
  return {
    employeeId: targetId,
    self,
    before: before.map((item) => ({ ...item })),
    after: after.map((item) => ({ ...item })),
    changes: changes.map((change) => ({
      operation: change.operation,
      domain: change.domain,
      action: change.action,
      before: change.before,
      after: change.after,
    })),
  };
}

function toDryRunChanges(changes: readonly PlannedChange[]): DryRunChange[] {
  return changes.map((change) => ({
    operation: change.operation,
    entity: 'employee_permission_override',
    id: `${change.domain}.${change.action}`,
    before: change.before,
    after: change.after,
  }));
}

async function executeDryRun(input: {
  readonly database: Database;
  readonly request: FastifyRequest;
  readonly principal: Principal;
  readonly targetId: string;
  readonly expectedVersion: number;
  readonly overrides: readonly OverrideInput[];
}): Promise<DryRunResult> {
  const { database, request, principal, targetId, expectedVersion, overrides } = input;
  const self = principal.employeeId === targetId;

  try {
    const plan = await withTenant(database, principal.tenantId, async (tx) => {
      const callerIsOwner = await loadCallerIsOwner(tx, principal.employeeId, principal.tenantId);
      const target = await loadTarget(tx, targetId, principal.tenantId);
      assertBoundary(callerIsOwner, targetId, target);
      if (target.version !== expectedVersion) {
        throw new AppError('VERSION_CONFLICT', '员工版本与 If-Match 不一致，请重新读取后重试', {
          expected: expectedVersion,
          current: target.version,
        });
      }
      const baseline = await loadBaseline(tx, targetId, principal.tenantId);
      const existing = await loadOverrides(tx, targetId, principal.tenantId);
      return planChanges(overrides, baseline, existing);
    });

    await recordAudit(
      database,
      auditEventOf(request, principal, targetId, {
        dryRun: true,
        result: 'success',
        changeSummary: summaryOf(targetId, self, plan.before, plan.after, plan.changes),
      }),
    );

    return {
      dryRun: true,
      valid: true,
      changes: toDryRunChanges(plan.changes),
      errors: [],
    };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const errors: DryRunIssue[] = [{ code: error.code, message: error.message }];
    await recordAudit(
      database,
      auditEventOf(request, principal, targetId, {
        dryRun: true,
        result: 'fail',
        errorCode: error.code,
        changeSummary: { employeeId: targetId, self, requested: [...overrides] },
      }),
    );
    return { dryRun: true, valid: false, changes: [], errors };
  }
}

export async function updatePermissionOverrides(
  ctx: PermissionOverrideContext,
): Promise<DryRunResult | void> {
  // 与骨架其他端点一致：未配置数据库时先返 501（不因认证/前置条件提前改判）。
  const database = requireDatabase(ctx);
  const principal = requirePrincipal(ctx.request);
  assertHumanCredential(principal);

  if (!allowsScope(principal.scope, 'permission', 'update')) {
    throw new AppError('FORBIDDEN', '缺少 permission.update 权限');
  }

  const targetId = parseEmployeeId(ctx.request);
  const overrides = dedupe(parseOverrides(ctx.request.body));
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const dryRun = isDryRun(ctx.request);
  const self = principal.employeeId === targetId;

  if (dryRun) {
    return executeDryRun({ database, request: ctx.request, principal, targetId, expectedVersion, overrides });
  }

  // withAudit 在 work 返回后才把事件写入 outbox；before/after 必须等事务内的读取与计划算完，
  // 故先建一个可变 summary，在 work 内回填（appendAudit 是 work 之后才序列化它）。
  const summary: Record<string, unknown> = { employeeId: targetId, self };

  const written = await withAudit(
    database,
    auditEventOf(ctx.request, principal, targetId, {
      dryRun: false,
      result: 'success',
      changeSummary: summary,
    }),
    async (tx) => {
      const callerIsOwner = await loadCallerIsOwner(tx, principal.employeeId, principal.tenantId);
      const target = await loadTarget(tx, targetId, principal.tenantId);
      assertBoundary(callerIsOwner, targetId, target);
      if (target.version !== expectedVersion) {
        throw new AppError('VERSION_CONFLICT', '员工版本与 If-Match 不一致，请重新读取后重试', {
          expected: expectedVersion,
          current: target.version,
        });
      }

      const baseline = await loadBaseline(tx, targetId, principal.tenantId);
      const existing = await loadOverrides(tx, targetId, principal.tenantId);
      const plan = planChanges(overrides, baseline, existing);
      await applyChanges(tx, targetId, principal.tenantId, principal.employeeId, plan.changes);
      Object.assign(summary, summaryOf(targetId, self, plan.before, plan.after, plan.changes));

      // 版本守卫同时兜住并发写：0 行 ⇒ 事务回滚，覆盖写入一并撤销。
      const updated = await tx.query<{ version: number }>(
        `UPDATE employee
            SET version = version + 1
          WHERE id = $1 AND tenant_id = $2 AND version = $3
          RETURNING version`,
        [targetId, principal.tenantId, expectedVersion],
      );
      const version = updated.rows[0]?.version;
      if (version === undefined) {
        throw new AppError('VERSION_CONFLICT', '员工已被并发修改，请重新读取后重试');
      }
      return { version };
    },
  );

  ctx.reply.header('ETag', etagOf(written.version)).status(204).send();
}
