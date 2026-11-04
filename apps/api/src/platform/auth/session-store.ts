import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Database, SqlClient } from '../db/client.js';
import { withTenant } from './tenant-context.js';

/**
 * 会话存储（D59⑦）。
 *
 * - 原始令牌 32 字节随机 hex 只在创建时返回一次；服务端只存 sha256 hex；
 * - 解析走 `auth_resolve_session`（SECURITY DEFINER，D59②），不需要租户上下文；
 * - 滑动续期：`last_seen_at` 每 5 分钟最多写一次，写入时把 `expires_at` 推到 now + TTL；
 * - 登出只撤销当前会话。
 */

export const SESSION_COOKIE_NAME = 'qingdan_session';

/** 续期写放大保护窗口（D59⑦：5 分钟）。 */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreateSessionInput {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly ttlDays: number;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  /** 测试注入用；生产不传 = 当前时间。 */
  readonly now?: Date;
}

export interface CreatedSession {
  /** 原始令牌（Cookie 值），仅此一次可拿到。 */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface ResolvedSession {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

interface SessionRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function expiryFrom(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * DAY_MS);
}

/** 新建会话；调用方拿到的 `token` 是唯一一次明文。 */
export async function createSession(db: Database, input: CreateSessionInput): Promise<CreatedSession> {
  const now = input.now ?? new Date();
  const expiresAt = expiryFrom(now, input.ttlDays);
  const token = randomBytes(32).toString('hex');
  const sessionId = uuidv7();

  await withTenant(db, input.tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO session (id, tenant_id, employee_id, token_hash, issued_at, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        input.tenantId,
        input.employeeId,
        hashSessionToken(token),
        now,
        expiresAt,
        input.ip ?? null,
        input.userAgent ?? null,
      ],
    );
  });

  return { token, sessionId, expiresAt };
}

/**
 * 按原始令牌解析会话；撤销 / 过期返回 null。
 * 走 SECURITY DEFINER 函数，因此不要求调用方已设置 `app.tenant_id`。
 */
export async function resolveSession(
  db: SqlClient,
  token: string,
  options: { now?: Date } = {},
): Promise<ResolvedSession | null> {
  const result = await db.query<SessionRow>(`SELECT * FROM auth_resolve_session($1)`, [
    hashSessionToken(token),
  ]);
  const row = result.rows[0];
  if (!row) return null;

  const revokedAt = row.revoked_at === null ? null : toDate(row.revoked_at);
  if (revokedAt !== null) return null;

  const expiresAt = toDate(row.expires_at);
  const now = options.now ?? new Date();
  if (expiresAt.getTime() <= now.getTime()) return null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    employeeId: row.employee_id,
    expiresAt,
    revokedAt,
  };
}

/**
 * 滑动续期：距上次 `last_seen_at` 超过 5 分钟才写，同时把 `expires_at` 推到 now + TTL。
 * 返回是否实际写入（便于测试与观测）。
 */
export async function touchSession(
  db: Database,
  input: { tenantId: string; sessionId: string; ttlDays: number; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const expiresAt = expiryFrom(now, input.ttlDays);

  return withTenant(db, input.tenantId, async (tx) => {
    const result = await tx.query<{ id: string }>(
      `UPDATE session
          SET last_seen_at = $2,
              expires_at = $3
        WHERE id = $1
          AND revoked_at IS NULL
          AND (last_seen_at IS NULL OR last_seen_at < $2::timestamptz - interval '5 minutes')
        RETURNING id`,
      [input.sessionId, now, expiresAt],
    );
    return result.rows.length > 0;
  });
}

/** 撤销会话（幂等：已撤销返回 false）。 */
export async function revokeSession(
  db: Database,
  input: { tenantId: string; sessionId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return withTenant(db, input.tenantId, async (tx) => {
    const result = await tx.query<{ id: string }>(
      `UPDATE session
          SET revoked_at = $2
        WHERE id = $1
          AND revoked_at IS NULL
        RETURNING id`,
      [input.sessionId, now],
    );
    return result.rows.length > 0;
  });
}
