import {
  AppError,
  PageQuerySchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  encodeCursor,
  type AuditLog,
  type CursorPayload,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import { recordAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import type { Database } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';

/**
 * 操作日志查询（D51 / D54② / D59①）。
 *
 * - 只读 `audit_log_view`（属主权限视图，视图内已显式按 `app.tenant_id` 过滤，未设租户 fail-closed），
 *   基表 `audit_log` 对应用角色仍只有 INSERT；
 * - 游标分页 + `occurred_at DESC, id DESC`；
 * - 看日志本身属敏感读：每成功查询写一条审计。审计写入走 outbox，不查 `audit_log_view`，
 *   因此不会递归触发查询。
 */

const ACTION = 'platform.audit.read';
const OBJECT_TYPE = 'audit_log';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditLogContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

interface AuditLogRow {
  id: string;
  occurred_at: Date | string;
  tenant_id: string | null;
  company_id: string | null;
  actor_type: string;
  actor_id: string;
  credential_id: string | null;
  source: string;
  action: string;
  object_type: string;
  object_id: string | null;
  changes: unknown;
  result: string;
  error_code: string | null;
  request_id: string;
  ip: string | null;
  user_agent: string | null;
  reason: string | null;
  business_txn_id: string | null;
  dry_run: boolean;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parsePageQuery(request: FastifyRequest): { cursor?: CursorPayload; limit: number } {
  const parsed = PageQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '分页参数不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  let cursor: CursorPayload | undefined;
  if (parsed.data.cursor !== undefined) {
    cursor = decodeCursor(parsed.data.cursor);
    if (!UUID_RE.test(cursor.id)) {
      throw new AppError('VALIDATION_FAILED', 'cursor 内容不合法', { field: 'cursor' });
    }
  }
  return { cursor, limit: clampLimit(parsed.data.limit) };
}

function normalizeChanges(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

function mapAuditRow(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    time: toDate(row.occurred_at).toISOString(),
    tenantId: row.tenant_id,
    companyId: row.company_id,
    actorType: row.actor_type as AuditLog['actorType'],
    actorId: row.actor_id,
    credentialId: row.credential_id,
    source: row.source as AuditLog['source'],
    action: row.action,
    objectType: row.object_type,
    objectId: row.object_id,
    changeSummary: normalizeChanges(row.changes),
    result: row.result as AuditLog['result'],
    errorCode: row.error_code,
    requestId: row.request_id,
    ip: row.ip,
    ua: row.user_agent,
    reason: row.reason,
    businessTxId: row.business_txn_id,
    dryRun: row.dry_run,
  };
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  changeSummary: Record<string, unknown>,
): AuditEvent {
  return {
    tenantId: principal.tenantId,
    actorType: principal.actorType,
    actorId: principal.actorId,
    credentialId: principal.credentialId,
    source: request.auditSource,
    action: ACTION,
    objectType: OBJECT_TYPE,
    objectId: null,
    changeSummary,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: headerValue(request, 'user-agent') ?? null,
    reason: request.auditReason,
  };
}

export async function listAuditLogs(
  ctx: AuditLogContext,
): Promise<{ items: AuditLog[]; nextCursor: string | null }> {
  const principal = ctx.request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');

  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', '数据库未配置，审计查询不可用', { operationId: ACTION });
  }

  if (!allowsScope(principal.scope, 'audit', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 audit.read 权限');
  }

  const { cursor, limit } = parsePageQuery(ctx.request);

  const rows = await database.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [principal.tenantId]);
    const params: unknown[] = [];
    let where = '';
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      where = 'WHERE (occurred_at, id) < ($1::timestamptz, $2::uuid)';
    }
    params.push(limit + 1);
    const result = await tx.query<AuditLogRow>(
      `SELECT id, occurred_at, tenant_id, company_id, actor_type, actor_id, credential_id,
              source, action, object_type, object_id, changes, result, error_code, request_id,
              ip, user_agent, reason, business_txn_id, dry_run
         FROM audit_log_view
         ${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(mapAuditRow);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: toDate(last.occurred_at).toISOString(), id: last.id })
      : null;

  // D54②：看日志本身是敏感读，每次成功查询写一条审计（不递归查询日志）。
  await recordAudit(
    database,
    auditEventOf(ctx.request, principal, {
      limit,
      cursor: cursor ?? null,
      returned: items.length,
    }),
  );

  return { items, nextCursor };
}
