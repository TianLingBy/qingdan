import { AppError } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { recordAudit } from '../../../platform/audit/writer.js';
import { clearSessionCookie } from '../../../platform/auth/cookie.js';
import { revokeSession } from '../../../platform/auth/session-store.js';
import type { AppConfig } from '../../../platform/config.js';
import type { Database } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';

/**
 * 登出用例（D59⑦）：只撤销当前会话。
 *
 * 幂等：没有会话 / 会话已失效也返回 204 并清 Cookie；有会话时撤销并记一条审计。
 * 认证插件把本路径列为「可选认证」，所以过期 Cookie 也能走到这里而不是被 401 挡住。
 */

export interface LogoutContext {
  readonly database: Database | null;
  readonly config: AppConfig;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

const LOGOUT_ACTION = 'platform.auth.logout';

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

export async function logout(ctx: LogoutContext): Promise<void> {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', '数据库未配置，登出不可用', { operationId: LOGOUT_ACTION });
  }

  const principal = ctx.request.principal;
  if (principal && principal.credentialType === 'session') {
    await revokeSession(database, {
      tenantId: principal.tenantId,
      sessionId: principal.credentialId,
    });

    await recordAudit(database, {
      tenantId: principal.tenantId,
      actorType: principal.actorType,
      actorId: principal.actorId,
      credentialId: principal.credentialId,
      source: ctx.request.auditSource,
      action: LOGOUT_ACTION,
      objectType: 'session',
      objectId: principal.credentialId,
      result: 'success',
      requestId: requestIdFor(ctx.request),
      ip: ctx.request.ip,
      userAgent: headerValue(ctx.request, 'user-agent') ?? null,
    });
  }

  clearSessionCookie(ctx.reply, { secure: ctx.config.nodeEnv === 'production' });
  ctx.reply.status(204).send();
}
