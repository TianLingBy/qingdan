import { AppError, allowsScope } from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../../platform/auth/principal.js';
import type { Database } from '../../../platform/db/client.js';

/**
 * payment 模块三个用例（发起 / 查单 / mock 确认）共用的入口校验。
 *
 * 放在一个文件里而不是各抄一份：这三条路径的「谁能做、什么算登录」必须是同一套口径，
 * 抄三份之后改权限只改到两处就是越权。
 */

export interface PaymentContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

export function requireDatabase(ctx: PaymentContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, {
      operationId,
    });
  }
  return database;
}

/**
 * `payment` 域只有 `create` / `read` 两个动作可用（契约 `domains.ts` 的动作表 +
 * 本模块三条路由的 action），这里只收这两个值，免得写出一个永远为真的检查。
 */
export function requirePaymentScope(principal: Principal, action: 'create' | 'read'): void {
  if (!allowsScope(principal.scope, 'payment', action)) {
    throw new AppError('FORBIDDEN', `缺少 payment.${action} 权限`);
  }
}
