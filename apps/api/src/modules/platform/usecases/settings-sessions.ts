import {
  AppError,
  type SettingsSession,
  type SettingsSessionList,
  type SettingsSessionRevokeResult,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import { withAudit } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { settingsAuditEventOf } from './settings-profile.js';

/**
 * 我的登录会话（`platform.settings.sessions` / `platform.settings.revoke_session`，Issue #298 / D97）。
 *
 * 只回「设备标识 + 时间」，不回 token（服务端只有哈希，本来也拿不出原文）、
 * 不回 UA 原文、不回 IP：`session.ip` / `session.user_agent` 是排障用的原始痕迹，
 * 拿来当「设备名」展示等于把指纹细节倒给前端，且对用户毫无用处。
 *
 * 「踢下线」只认本人的会话：`id` 不是当前 principal 的（包括根本不存在）一律 403。
 * 不返回 404 是刻意的——两个码的分歧会让攻击者能用来枚举「哪些 session id 真实存在」。
 */

const LIST_ACTION = 'platform.settings.sessions';
const REVOKE_ACTION = 'platform.settings.revoke_session';

/** 列表上限：一个人的会话数不该无界增长，200 条足够覆盖「多设备 + 多历史」。 */
const SESSION_LIST_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SettingsSessionsContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

interface SessionRow {
  id: string;
  issued_at: Date | string;
  expires_at: Date | string;
  last_seen_at: Date | string | null;
  revoked_at: Date | string | null;
  user_agent: string | null;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: SettingsSessionsContext): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${LIST_ACTION} 不可用`, {
      operationId: LIST_ACTION,
    });
  }
  return database;
}

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * 由 UA 派生一句人话（「Chrome · Windows」）。
 *
 * 顺序有讲究：Edge 的 UA 里也含 `Chrome/`，iOS 的 UA 里也含 `Mac OS X`，
 * 所以更具体的名字必须先判，否则所有浏览器都会被识别成 Chrome。
 * 识别不出来就回「未知设备」，不回原文。
 */
function deviceLabelOf(userAgent: string | null): string {
  if (!userAgent) return '未知设备';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /(OPR|Opera)\//.test(userAgent)
      ? 'Opera'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Firefox\//.test(userAgent)
          ? 'Firefox'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : '浏览器';
  const system = /Windows NT/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /(iPhone|iPad|iPod)/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '未知系统';
  return `${browser} · ${system}`;
}

function toSession(row: SessionRow, currentSessionId: string | null, now: number): SettingsSession {
  const revokedAt = row.revoked_at === null ? null : isoOf(row.revoked_at);
  const expiresAt = isoOf(row.expires_at);
  return {
    id: row.id,
    deviceLabel: deviceLabelOf(row.user_agent),
    issuedAt: isoOf(row.issued_at),
    lastSeenAt: row.last_seen_at === null ? null : isoOf(row.last_seen_at),
    expiresAt,
    revokedAt,
    // 当前会话按 credentialId 认：cookie 认证时它就是会话 id；
    // API 令牌调用时它指向令牌，不会命中任何会话行（列表中就没有「当前」）。
    current: currentSessionId !== null && row.id === currentSessionId,
    active: revokedAt === null && new Date(expiresAt).getTime() > now,
  };
}

/** 我的会话列表：有效与已吊销都返回（前端才能显示「刚刚被踢掉的那台」）。 */
export async function listSettingsSessions(
  ctx: SettingsSessionsContext,
): Promise<SettingsSessionList> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);

  const rows = await withTenant(database, principal.tenantId, async (tx: SqlClient) => {
    const result = await tx.query<SessionRow>(
      `SELECT id, issued_at, expires_at, last_seen_at, revoked_at, user_agent
         FROM session
        WHERE tenant_id = $1 AND employee_id = $2
        ORDER BY issued_at DESC
        LIMIT $3`,
      [principal.tenantId, principal.employeeId, SESSION_LIST_LIMIT],
    );
    return result.rows;
  });

  const now = Date.now();
  return {
    items: rows.map((row) => toSession(row, principal.credentialId, now)),
  };
}

/** 踢掉我的一条会话；别人的 id → 403（不是 404，也不静默当成功）。 */
export async function revokeSettingsSession(
  ctx: SettingsSessionsContext,
): Promise<SettingsSessionRevokeResult> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);

  // 参数名固定 `id`（契约 `{id}`），且**只有**这个 id——没有员工 id 参数可传。
  const raw = (ctx.request.params as { id?: string }).id ?? '';
  if (!UUID_RE.test(raw)) {
    throw new AppError('VALIDATION_FAILED', '会话 id 格式不合法', { field: 'id' });
  }

  const summary: Record<string, unknown> = { sessionId: raw };

  return withAudit(
    database,
    settingsAuditEventOf(ctx.request, principal, REVOKE_ACTION, summary),
    async (tx) => {
      const found = await tx.query<{ employee_id: string; revoked_at: Date | string | null }>(
        'SELECT employee_id, revoked_at FROM session WHERE id = $1 AND tenant_id = $2',
        [raw, principal.tenantId],
      );
      const row = found.rows[0];
      // 不存在与非本人同等对待：都回 403，别让 404/403 的差异泄漏「这条 session 存在」。
      if (!row || row.employee_id !== principal.employeeId) {
        throw new AppError('FORBIDDEN', '只能撤销本人的登录会话');
      }

      let revokedAt = row.revoked_at;
      if (revokedAt === null) {
        const updated = await tx.query<{ revoked_at: Date | string }>(
          `UPDATE session
              SET revoked_at = now()
            WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
            RETURNING revoked_at`,
          [raw, principal.tenantId],
        );
        revokedAt = updated.rows[0]?.revoked_at ?? new Date();
      }

      const iso = isoOf(revokedAt);
      summary.revokedAt = iso;
      summary.alreadyRevoked = row.revoked_at !== null;
      return { id: raw, revokedAt: iso } satisfies SettingsSessionRevokeResult;
    },
  );
}
