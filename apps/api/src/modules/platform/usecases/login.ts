import { AppError } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { markFailureAuditRecorded, recordAudit } from '../../../platform/audit/writer.js';
import { setSessionCookie } from '../../../platform/auth/cookie.js';
import { createSession } from '../../../platform/auth/session-store.js';
import type { AppConfig } from '../../../platform/config.js';
import type { Database } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { consumeLoginCode } from './send-code.js';

/**
 * 登录用例（D54④ / D59③⑦）。
 *
 * 验证码两条通道：
 *   - 非生产：`LOGIN_DEV_CODE`（默认 000000）直通，本地/测试不发短信；
 *   - 生产 / 其他：校验 `login_code` 表里尚未消费、未过期、次数未超限的码，成功后立即作废。
 *
 * 失败原因对客户端一律 `UNAUTHENTICATED`（未知手机号 / 停用员工 / 停用租户 / 码错不区分，防枚举）；
 * 审计里仍按可用信息尽量记全（未知手机号只能记 tenant_id = NULL）。
 */

export interface LoginContext {
  readonly database: Database | null;
  readonly config: AppConfig;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

export interface LoginResult {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
}

interface LoginRow {
  tenant_id: string;
  employee_id: string;
  employee_name: string;
  employee_status: string;
  tenant_status: string;
}

const LOGIN_ACTION = 'platform.auth.login';
const DAY_SECONDS = 24 * 60 * 60;

function isProduction(config: AppConfig): boolean {
  return config.nodeEnv === 'production';
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

function parseLoginBody(body: unknown): { phone: string; code: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象');
  }
  const { phone, code } = body as Record<string, unknown>;
  if (typeof phone !== 'string' || phone.length < 6 || phone.length > 32) {
    throw new AppError('VALIDATION_FAILED', 'phone 不合法', { field: 'phone' });
  }
  if (typeof code !== 'string' || code.length < 1 || code.length > 16) {
    throw new AppError('VALIDATION_FAILED', 'code 不合法', { field: 'code' });
  }
  return { phone, code };
}

async function recordLoginFailure(
  ctx: LoginContext,
  database: Database,
  input: { readonly tenantId: string | null; readonly actorId: string },
): Promise<void> {
  await recordAudit(database, {
    tenantId: input.tenantId,
    actorType: 'employee',
    actorId: input.actorId,
    source: ctx.request.auditSource,
    action: LOGIN_ACTION,
    objectType: 'session',
    objectId: null,
    result: 'fail',
    errorCode: 'UNAUTHENTICATED',
    requestId: requestIdFor(ctx.request),
    ip: ctx.request.ip,
    userAgent: headerValue(ctx.request, 'user-agent') ?? null,
  });
  // 已自行记录失败审计：告诉统一失败钩子别再记第二条（路由 auditKind=write）。
  markFailureAuditRecorded(ctx.request);
}

export async function login(ctx: LoginContext): Promise<LoginResult> {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `${LOGIN_ACTION} 尚未实现（数据库未配置，登录不可用）`, {
      operationId: LOGIN_ACTION,
    });
  }

  const { phone, code } = parseLoginBody(ctx.request.body);

  // 非生产固定码直通（本地/测试零成本）；其余一律走库里的一次性验证码。
  const devCodeAccepted = !isProduction(ctx.config) && code === ctx.config.loginDevCode;
  if (!devCodeAccepted) {
    const accepted = await consumeLoginCode(database, ctx.config, phone, code);
    if (!accepted) {
      await recordLoginFailure(ctx, database, { tenantId: null, actorId: phone });
      throw new AppError('UNAUTHENTICATED');
    }
  }

  // 登录时尚无租户上下文：走 SECURITY DEFINER 函数跨 RLS 查找（D59②）。
  const found = await database.query<LoginRow>('SELECT * FROM auth_find_login($1)', [phone]);
  const row = found.rows[0];

  // 未知手机号 / 非在职 / 租户停用 → 同一个 401，不向客户端区分原因。
  if (!row || row.employee_status !== '在职' || row.tenant_status !== '启用') {
    await recordLoginFailure(ctx, database, {
      tenantId: row?.tenant_id ?? null,
      actorId: row?.employee_id ?? phone,
    });
    throw new AppError('UNAUTHENTICATED');
  }

  const session = await createSession(database, {
    tenantId: row.tenant_id,
    employeeId: row.employee_id,
    ttlDays: ctx.config.sessionTtlDays,
    ip: ctx.request.ip,
    userAgent: headerValue(ctx.request, 'user-agent') ?? null,
  });

  await recordAudit(database, {
    tenantId: row.tenant_id,
    actorType: 'employee',
    actorId: row.employee_id,
    credentialId: session.sessionId,
    source: ctx.request.auditSource,
    action: LOGIN_ACTION,
    objectType: 'session',
    objectId: session.sessionId,
    result: 'success',
    requestId: requestIdFor(ctx.request),
    ip: ctx.request.ip,
    userAgent: headerValue(ctx.request, 'user-agent') ?? null,
  });

  setSessionCookie(ctx.reply, session.token, {
    maxAgeSeconds: ctx.config.sessionTtlDays * DAY_SECONDS,
    secure: isProduction(ctx.config),
  });

  return {
    employeeId: row.employee_id,
    tenantId: row.tenant_id,
    displayName: row.employee_name,
  };
}
