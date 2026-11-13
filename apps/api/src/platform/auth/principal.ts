import {
  AppError,
  ScopeMatrixSchema,
  auditSourceFromClient,
  type AuditSource,
  type ScopeMatrix,
} from '@qingdan/contracts';
import type { ActorType } from '../audit/writer.js';
import { computeAuthz, type AuthzResult } from '../authz/service.js';
import type { Database, SqlClient } from '../db/client.js';
import {
  SESSION_COOKIE_NAME,
  hashSessionToken,
  resolveSession,
  touchSession,
} from './session-store.js';
import { withTenant } from './tenant-context.js';

/**
 * 请求主体解析（D59②⑦⑧ / D52.1）。
 *
 * 优先级：`Authorization: Bearer` > Cookie `qingdan_session`（D59 认证优先级）。
 *   ① Bearer = API Token → actorType `ai`；status/过期/IP 白名单全部校验；
 *   ② 否则 Cookie 会话 → actorType `employee`；
 *   ③ 命中后在同一连接 `set_config('app.tenant_id', tenantId, true)` 再算权限，
 *      token scope 与员工当前权限取交集（D52.1①），每请求现算、不缓存（D52.1②）。
 *
 * 任何一步失败统一抛 `UNAUTHENTICATED`，不向客户端泄露失败原因。
 */

export type CredentialType = 'session' | 'api_token';

export interface Principal {
  readonly actorType: Extract<ActorType, 'employee' | 'ai'>;
  /** 员工 id（AI 凭证 = 绑定员工 id）。 */
  readonly actorId: string;
  readonly tenantId: string;
  readonly employeeId: string;
  /** 会话 id 或 API Token id（D51 凭证反查）。 */
  readonly credentialId: string;
  readonly companyIds: readonly string[];
  readonly scope: ScopeMatrix;
  /** 是否老板（Issue #227 身份位）；由权限引擎现算，随 /auth/me 下发。 */
  readonly isOwner: boolean;
  /** 是否可看单据「负责人」字段（老板或经理岗位）；供列表/详情脱敏用，不下发。 */
  readonly canViewHandler: boolean;
  /** 审计来源，仍只由 `X-Client` 映射（D59）。 */
  readonly source: AuditSource;
  /** 本请求实际使用的凭证类型（供 CSRF 判定）。 */
  readonly credentialType: CredentialType;
  /**
   * Cookie 会话本次是否实际做了滑动续期写入（5 分钟窗口外才为 true）。
   * 为 true 时认证插件必须重发 `Set-Cookie`，否则库里的 `expires_at` 延长了、
   * 浏览器 Cookie 却仍按旧的 Max-Age 过期（活跃用户第 7 天被登出）。
   */
  readonly sessionRenewed: boolean;
}

export interface PrincipalInput {
  readonly authorization?: string;
  readonly cookie?: string;
  readonly ip?: string;
  readonly client?: string;
}

export interface PrincipalOptions {
  readonly sessionTtlDays: number;
  /** 测试注入用；生产不传 = 当前时间。 */
  readonly now?: Date;
}

interface ApiTokenRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  scope: unknown;
  status: string;
  expires_at: Date | string | null;
  ip_allowlist: string[] | null;
}

function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED');
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** 从标准 Cookie 头里取一个值（不引入 @fastify/cookie，只为单块会话 Cookie）。 */
export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function normalizeScope(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function ipMatches(ip: string | undefined, allowlist: readonly string[] | null): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (!ip) return false;
  // 同一地址可能以 IPv4-mapped IPv6 形式出现（::ffff:127.0.0.1）；两种写法都认。
  const normalized = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  return allowlist.some((entry) => {
    const allowed = entry.trim();
    return allowed !== '' && (allowed === ip || allowed === normalized);
  });
}

async function authzFor(
  db: Database,
  tenantId: string,
  employeeId: string,
  tokenScope?: ScopeMatrix,
): Promise<AuthzResult> {
  return withTenant(db, tenantId, async (tx: SqlClient) => {
    const authz = await computeAuthz(tx, { employeeId, tenantId, tokenScope });
    if (!authz) throw unauthenticated();
    return authz;
  });
}

async function resolveApiTokenPrincipal(
  db: Database,
  token: string,
  input: PrincipalInput,
  now: Date,
): Promise<Principal> {
  const result = await db.query<ApiTokenRow>(`SELECT * FROM auth_resolve_api_token($1)`, [
    hashSessionToken(token),
  ]);
  const row = result.rows[0];
  if (!row) throw unauthenticated();
  if (row.status !== 'active') throw unauthenticated();
  if (row.expires_at !== null && toDate(row.expires_at).getTime() <= now.getTime()) {
    throw unauthenticated();
  }
  if (!ipMatches(input.ip, row.ip_allowlist)) throw unauthenticated();

  const parsedScope = ScopeMatrixSchema.safeParse(normalizeScope(row.scope));
  if (!parsedScope.success) {
    throw new AppError('INTERNAL_ERROR', 'API Token scope 数据不合法', { tokenId: row.id });
  }

  const authz = await authzFor(db, row.tenant_id, row.employee_id, parsedScope.data);
  return {
    actorType: 'ai',
    actorId: row.employee_id,
    tenantId: row.tenant_id,
    employeeId: row.employee_id,
    credentialId: row.id,
    companyIds: authz.companyIds,
    scope: authz.scope,
    isOwner: authz.isOwner,
    canViewHandler: authz.canViewHandler,
    source: auditSourceFromClient(input.client),
    credentialType: 'api_token',
    sessionRenewed: false,
  };
}

async function resolveSessionPrincipal(
  db: Database,
  token: string,
  input: PrincipalInput,
  options: PrincipalOptions,
): Promise<Principal> {
  const now = options.now ?? new Date();
  const session = await resolveSession(db, token, { now });
  if (!session) throw unauthenticated();

  const authz = await authzFor(db, session.tenantId, session.employeeId);
  // 滑动续期（每 5 分钟最多写一次；写失败按 500 处理，不静默降级）。
  // 返回值带出「是否实际写入」，插件据此决定是否重发 Cookie（D59⑦）。
  const sessionRenewed = await touchSession(db, {
    tenantId: session.tenantId,
    sessionId: session.id,
    ttlDays: options.sessionTtlDays,
    now,
  });

  return {
    actorType: 'employee',
    actorId: session.employeeId,
    tenantId: session.tenantId,
    employeeId: session.employeeId,
    credentialId: session.id,
    companyIds: authz.companyIds,
    scope: authz.scope,
    isOwner: authz.isOwner,
    canViewHandler: authz.canViewHandler,
    source: auditSourceFromClient(input.client),
    credentialType: 'session',
    sessionRenewed,
  };
}

/** 解析请求主体；凭证缺失/无效 → `UNAUTHENTICATED`。 */
export async function resolvePrincipal(
  db: Database,
  input: PrincipalInput,
  options: PrincipalOptions,
): Promise<Principal> {
  const now = options.now ?? new Date();
  const authorization = input.authorization?.trim();

  // Bearer 优先：带了 Bearer 就只认它，失败不回退 Cookie（避免“坏 token + 好 Cookie”被静默放行）。
  if (authorization && /^bearer\s+/i.test(authorization)) {
    const token = authorization.replace(/^bearer\s+/i, '').trim();
    if (!token) throw unauthenticated();
    return resolveApiTokenPrincipal(db, token, input, now);
  }

  const sessionToken = parseCookieHeader(input.cookie, SESSION_COOKIE_NAME);
  if (!sessionToken) throw unauthenticated();
  return resolveSessionPrincipal(db, sessionToken, input, options);
}
