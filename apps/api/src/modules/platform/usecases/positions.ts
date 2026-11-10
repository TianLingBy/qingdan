import {
  AppError,
  PositionCreateInputSchema,
  PositionListQuerySchema,
  PositionUpdateInputSchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  encodeCursor,
  etagOf,
  type CursorPayload,
  type Position,
  type PositionPresetKey,
} from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';

/**
 * 岗位（权限模板）用例（platform.position.list / create / update / delete，契约 positions.ts）。
 *
 * 口径（契约注释为准）：
 * - 岗位归 `permission` 功能域（D44），scope = `permission.<动作>`；不新增 position 功能域；
 * - 权限模板 = 功能域 × 动作（D4），落 `position_permission`（granted=true 行）；
 *   `view_price` 是数据可见性开关、不进动作勾选表（契约层已拒）；
 * - `presetKey` 只接受服务端预设值或 null（D60②），且不可改（更新入参没有它）；
 * - **停用 = 软删除**（status='停用'），不物理删；已停用再删幂等成功
 *   （与 employee.disable / token.revoke 同口径）；**被员工占用的岗位不允许删**
 *   （先查 `employee_company_position` 引用；错误码沿用封闭枚举内的 422 + reason，
 *   与「手机号被占用」同口径——契约注释建议 409，待 Lead 冻结新码后另行迁移）；
 * - 删除审计的 changeSummary 带被删岗位快照（Issue #121 验收）；
 * - 写操作 100% 审计（D51），objectType='position'；增删改模板 AI 默认禁止（D54⑥）。
 */

const OBJECT_TYPE = 'position';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PositionRow {
  id: string;
  tenant_id: string;
  name: string;
  preset_key: string | null;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PositionContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
  readonly reply?: FastifyReply;
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: PositionContext, action: string): Database {
  if (!ctx.database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${action} 不可用`, { operationId: action });
  }
  return ctx.database;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** If-Match 强制（契约 requiresIfMatch=true）：缺失 → 428；格式非法 → 409。 */
function requireIfMatchVersion(request: FastifyRequest): number {
  const raw = headerValue(request, 'if-match');
  if (raw === undefined || raw.trim() === '') {
    throw new AppError('PRECONDITION_REQUIRED', '本端点必须携带 If-Match（强 ETag "<version>"）');
  }
  const match = /^"([0-9]+)"$/.exec(raw.trim());
  if (!match) {
    throw new AppError('VERSION_CONFLICT', 'If-Match 格式不合法，应为强 ETag "<version>"', {
      ifMatch: raw,
    });
  }
  return Number(match[1]);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  action: string,
  objectId: string | null,
  changeSummary: Record<string, unknown>,
): AuditEvent {
  return {
    tenantId: principal.tenantId,
    actorType: principal.actorType,
    actorId: principal.actorId,
    credentialId: principal.credentialId,
    source: request.auditSource,
    action,
    objectType: OBJECT_TYPE,
    objectId,
    changeSummary,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: headerValue(request, 'user-agent') ?? null,
    reason: request.auditReason,
  };
}

function sendEntity(reply: FastifyReply, entity: Position): void {
  reply.header('ETag', etagOf(entity.version)).status(200).send(entity);
}

/** 从 `position_permission` 读模板，按域聚合、域内动作字典序，保证响应稳定。 */
async function loadActions(
  tx: SqlClient,
  positionId: string,
  tenantId: string,
): Promise<Position['actions']> {
  const result = await tx.query<{ domain: string; action: string }>(
    `SELECT domain, action FROM position_permission
      WHERE position_id = $1 AND tenant_id = $2 AND granted = true
      ORDER BY domain, action`,
    [positionId, tenantId],
  );
  const byDomain = new Map<string, string[]>();
  for (const row of result.rows) {
    const actions = byDomain.get(row.domain) ?? [];
    actions.push(row.action);
    byDomain.set(row.domain, actions);
  }
  return [...byDomain.entries()].map(([domain, actions]) => ({ domain, actions }));
}

async function loadPositionEntity(
  tx: SqlClient,
  id: string,
  tenantId: string,
): Promise<Position> {
  const result = await tx.query<PositionRow>(
    `SELECT id, tenant_id, name, preset_key, status, version, created_at, updated_at
       FROM position WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('NOT_FOUND', '岗位不存在或不属于本租户');
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    presetKey: (row.preset_key ?? null) as PositionPresetKey | null,
    actions: await loadActions(tx, row.id, row.tenant_id),
    status: row.status as Position['status'],
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

/** 模板落库：全量替换该岗位的 granted=true 行（与员工绑定替换同口径）。 */
async function replaceActions(
  tx: SqlClient,
  positionId: string,
  tenantId: string,
  actions: Position['actions'],
): Promise<void> {
  await tx.query('DELETE FROM position_permission WHERE position_id = $1 AND tenant_id = $2', [
    positionId,
    tenantId,
  ]);
  for (const entry of actions) {
    for (const action of entry.actions) {
      await tx.query(
        `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true`,
        [tenantId, positionId, entry.domain, action],
      );
    }
  }
}

/** 岗位列表：租户内全量（scope=permission.read 把关），可按 presetKey 过滤，cursor 分页。 */
export async function listPositions(
  ctx: PositionContext,
): Promise<{ items: Position[]; nextCursor: string | null }> {
  const ACTION = 'platform.position.list';
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, ACTION);

  if (!allowsScope(principal.scope, 'permission', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 permission.read 权限');
  }

  const parsed = PositionListQuerySchema.safeParse(ctx.request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', { issues: issuesOf(parsed.error) });
  }
  let cursor: CursorPayload | undefined;
  if (parsed.data.cursor !== undefined) {
    cursor = decodeCursor(parsed.data.cursor);
    if (!UUID_RE.test(cursor.id)) {
      throw new AppError('VALIDATION_FAILED', 'cursor 内容不合法', { field: 'cursor' });
    }
  }
  const limit = clampLimit(parsed.data.limit);

  const rows = await withTenant(database, principal.tenantId, async (tx) => {
    const params: unknown[] = [principal.tenantId];
    const where: string[] = ['tenant_id = $1'];
    if (parsed.data.presetKey !== undefined) {
      params.push(parsed.data.presetKey);
      where.push(`preset_key = $${params.length}`);
    }
    if (cursor !== undefined) {
      params.push(cursor.id);
      where.push(`id < $${params.length}::uuid`);
    }
    params.push(limit + 1);
    const result = await tx.query<PositionRow>(
      `SELECT id, tenant_id, name, preset_key, status, version, created_at, updated_at
         FROM position
        WHERE ${where.join('\n          AND ')}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params,
    );
    // 实体含权限模板（position_permission 聚合），同事务内逐行装配。
    const loaded: Position[] = [];
    for (const row of result.rows) {
      loaded.push(await loadPositionEntity(tx, row.id, row.tenant_id));
    }
    return loaded;
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = hasMore ? rows[limit - 1] : rows[rows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null;

  // D54②：普通读不记审计。
  return { items, nextCursor };
}

/** 新建岗位：presetKey 有值 → kind='预设'；AI 默认禁止；201 + 实体 + 审计。 */
export async function createPosition(ctx: PositionContext): Promise<Position> {
  const ACTION = 'platform.position.create';
  const database = requireDatabase(ctx, ACTION);
  const principal = requirePrincipal(ctx.request);

  // 契约 ai.policy=forbid（D54⑥）：权限模板变更会改所有人的生效权限，AI 不得执行。
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接新建岗位（权限模板）');
  }
  if (!allowsScope(principal.scope, 'permission', 'create')) {
    throw new AppError('FORBIDDEN', '缺少 permission.create 权限');
  }

  const parsed = PositionCreateInputSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '创建岗位入参不合法', { issues: issuesOf(parsed.error) });
  }
  const summary: Record<string, unknown> = {
    name: parsed.data.name,
    presetKey: parsed.data.presetKey ?? null,
    actions: parsed.data.actions,
  };
  // UUIDv7 应用侧生成（D55③）：审计 objectId 从第一条记录就是本岗位。
  const newPositionId = uuidv7();

  const entity = await withAudit(
    database,
    auditEventOf(ctx.request, principal, ACTION, newPositionId, summary),
    async (tx) => {
      // 同租户岗位名唯一（0001 表约束）：先查再插，把唯一冲突翻译成 422 而不是 500。
      const nameTaken = await tx.query<{ id: string }>(
        'SELECT id FROM position WHERE tenant_id = $1 AND name = $2',
        [principal.tenantId, parsed.data.name],
      );
      if (nameTaken.rows[0] !== undefined) {
        throw new AppError('VALIDATION_FAILED', '同名岗位已存在', {
          field: 'name',
          reason: 'NAME_TAKEN',
        });
      }

      await tx.query(
        `INSERT INTO position (id, tenant_id, name, kind, is_system, preset_key)
         VALUES ($1, $2, $3, $4, false, $5)`,
        [
          newPositionId,
          principal.tenantId,
          parsed.data.name,
          parsed.data.presetKey ? '预设' : '自定义',
          parsed.data.presetKey ?? null,
        ],
      );
      await replaceActions(tx, newPositionId, principal.tenantId, parsed.data.actions);

      summary.positionId = newPositionId;
      return loadPositionEntity(tx, newPositionId, principal.tenantId);
    },
  );

  if (ctx.reply) ctx.reply.status(201).send(entity);
  return entity;
}

/** 修改岗位（名称 / 模板）：presetKey 不可改（入参没有它）；If-Match 强制；200 + 实体 + 审计。 */
export async function updatePosition(ctx: PositionContext): Promise<Position> {
  const ACTION = 'platform.position.update';
  const database = requireDatabase(ctx, ACTION);
  const principal = requirePrincipal(ctx.request);

  if (!allowsScope(principal.scope, 'permission', 'update')) {
    throw new AppError('FORBIDDEN', '缺少 permission.update 权限');
  }

  const params = ctx.request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id', operationId: ACTION });
  }

  const parsed = PositionUpdateInputSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '修改岗位入参不合法', { issues: issuesOf(parsed.error) });
  }
  const expectedVersion = requireIfMatchVersion(ctx.request);
  const summary: Record<string, unknown> = { positionId: id, fields: Object.keys(parsed.data) };

  const entity = await withAudit(
    database,
    auditEventOf(ctx.request, principal, ACTION, id, summary),
    async (tx) => {
      const existing = await tx.query<PositionRow>(
        `SELECT id, tenant_id, name, preset_key, status, version, created_at, updated_at
           FROM position WHERE id = $1 AND tenant_id = $2`,
        [id, principal.tenantId],
      );
      const target = existing.rows[0];
      if (!target) throw new AppError('NOT_FOUND', '岗位不存在或不属于本租户');

      if (parsed.data.name !== undefined && parsed.data.name !== target.name) {
        const nameTaken = await tx.query<{ id: string }>(
          'SELECT id FROM position WHERE tenant_id = $1 AND name = $2 AND id <> $3',
          [principal.tenantId, parsed.data.name, id],
        );
        if (nameTaken.rows[0] !== undefined) {
          throw new AppError('VALIDATION_FAILED', '同名岗位已存在', {
            field: 'name',
            reason: 'NAME_TAKEN',
          });
        }
      }

      if (parsed.data.actions !== undefined) {
        await replaceActions(tx, id, principal.tenantId, parsed.data.actions);
        summary.actions = parsed.data.actions;
      }

      // 版本守卫兜并发：模板替换与改名同事务，冲突时一并回滚。
      const updated = await tx.query<{ version: number }>(
        `UPDATE position
            SET name = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND version = $4
          RETURNING version`,
        [id, principal.tenantId, parsed.data.name ?? target.name, expectedVersion],
      );
      if (updated.rows[0] === undefined) {
        throw new AppError('VERSION_CONFLICT', '岗位已被并发修改，请重新读取后重试');
      }

      return loadPositionEntity(tx, id, principal.tenantId);
    },
  );

  summary.version = entity.version;
  if (ctx.reply) sendEntity(ctx.reply, entity);
  return entity;
}

/**
 * 停用岗位（软删除）：回实体 + 新 ETag；危险动作，AI 默认禁止。
 * - 被员工占用的岗位不允许删（`employee_company_position` 有引用即拒绝，岗位保持启用）；
 * - 已停用再删幂等成功（不校验版本、不自增）；
 * - 审计 changeSummary 带被删岗位快照（Issue #121）。
 */
export async function disablePosition(ctx: PositionContext): Promise<Position> {
  const ACTION = 'platform.position.delete';
  const database = requireDatabase(ctx, ACTION);
  const principal = requirePrincipal(ctx.request);

  // 契约 ai.policy=forbid（D54⑥）：停用岗位影响在职员工的授权路径，AI 不得执行。
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接停用岗位');
  }
  if (!allowsScope(principal.scope, 'permission', 'delete')) {
    throw new AppError('FORBIDDEN', '缺少 permission.delete 权限');
  }

  const params = ctx.request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id', operationId: ACTION });
  }
  const expectedVersion = requireIfMatchVersion(ctx.request);
  const summary: Record<string, unknown> = { positionId: id };

  const entity = await withAudit(
    database,
    auditEventOf(ctx.request, principal, ACTION, id, summary),
    async (tx) => {
      const existing = await tx.query<PositionRow>(
        `SELECT id, tenant_id, name, preset_key, status, version, created_at, updated_at
           FROM position WHERE id = $1 AND tenant_id = $2`,
        [id, principal.tenantId],
      );
      const target = existing.rows[0];
      if (!target) throw new AppError('NOT_FOUND', '岗位不存在或不属于本租户');

      const actions = await loadActions(tx, id, principal.tenantId);

      // 幂等：已停用直接成功，不校验版本、不自增（客户端重试不应报冲突）。
      if (target.status === '停用') {
        summary.idempotent = true;
        summary.snapshot = {
          id,
          name: target.name,
          presetKey: target.preset_key,
          status: target.status,
          actions,
          version: target.version,
        };
        return loadPositionEntity(tx, id, principal.tenantId);
      }

      // 被员工占用 → 拒绝：软删除不发生，岗位保持启用。
      // 口径（2026-11-10 负责人拍板 + 新增 STATE_CONFLICT）：资源存在、版本也对，
      // 只是「当前状态不允许删」→ 409 状态冲突；`reason=POSITION_IN_USE` 供前端给人话提示。
      const inUse = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM employee_company_position
          WHERE position_id = $1 AND tenant_id = $2`,
        [id, principal.tenantId],
      );
      if (Number(inUse.rows[0]?.count ?? '0') > 0) {
        throw new AppError('STATE_CONFLICT', '该岗位仍有员工占用，请先调整员工的岗位后再停用', {
          reason: 'POSITION_IN_USE',
          positionId: id,
        });
      }

      // 版本守卫兜并发：0 行 ⇒ 已被并发修改，事务回滚。
      const updated = await tx.query<{ version: number }>(
        `UPDATE position
            SET status = '停用', version = version + 1, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND version = $3
          RETURNING version`,
        [id, principal.tenantId, expectedVersion],
      );
      if (updated.rows[0] === undefined) {
        throw new AppError('VERSION_CONFLICT', '岗位已被并发修改，请重新读取后重试');
      }

      // 删除审计的 changeSummary 必须带被删岗位快照（Issue #121 验收）：
      // 记「停用前」的状态，审计与业务同事务落库。
      summary.snapshot = {
        id,
        name: target.name,
        presetKey: target.preset_key,
        status: target.status,
        actions,
        version: target.version,
      };

      return loadPositionEntity(tx, id, principal.tenantId);
    },
  );

  summary.newVersion = entity.version;
  if (ctx.reply) sendEntity(ctx.reply, entity);
  return entity;
}
