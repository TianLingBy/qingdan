import {
  AppError,
  CompanySubscriptionUpdateSchema,
  ROUTES,
  allowsScope,
  buildOpenApiDocument,
  routesOfModule,
  type OpenApiDocument,
  type RouteDef,
} from '@qingdan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant } from '../../platform/auth/tenant-context.js';
import type { AppConfig } from '../../platform/config.js';
import type { Database } from '../../platform/db/client.js';
import { requestIdFor } from '../../platform/http/request-id.js';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';
import { SmsNotConfiguredError, type SmsSender } from '../../platform/sms/tencent.js';
import { createApiToken, listApiTokens, revokeApiToken } from './usecases/api-tokens.js';
import { listAuditLogs } from './usecases/audit-logs.js';
import {
  createCompany,
  listCompanies,
  updateCompany,
} from './usecases/companies.js';
import {
  createEmployee,
  disableEmployee,
  listEmployees,
  updateEmployee,
} from './usecases/employees.js';
import { login } from './usecases/login.js';
import { logout } from './usecases/logout.js';
import { me } from './usecases/me.js';
import { sendLoginCode } from './usecases/send-code.js';
import {
  createPosition,
  disablePosition,
  listPositions,
  updatePosition,
} from './usecases/positions.js';
import { updatePermissionOverrides } from './usecases/permission-overrides.js';
import { getCompanySubscription, updateCompanySubscription } from './usecases/subscription.js';

/**
 * platform 端点挂载。
 *
 * 路由**只从契约注册表 `ROUTES` 中本模块的那批生成**（D62 / Issue #15）：
 *   - `GET /api/v1/health` → 200 `{ status:'ok', version }`（不认证、不记审计）；
 *   - `GET /api/v1/openapi.json` → 由 `buildOpenApiDocument(ROUTES)` 现发射；
 *   - 已实现的认证端点 → 分派到 `usecases/`；
 *   - 其余已登记端点 → 501 `NOT_IMPLEMENTED`（D54 缺口 10：先登记签名，handler 后补）。
 *
 * 机械部分（路径转换 / config 透传 / 失败审计 / 默认 501）交给 `mountRoutes`；
 * 本文件只保留平台端点的 handler 分派与 OpenAPI 文档缓存。
 */

export interface PlatformRoutesOptions {
  /** 健康检查回显的 API 版本。 */
  readonly version: string;
  /** 应用配置（登录验证码 / 会话 TTL / 环境）。 */
  readonly config: AppConfig;
  /** 短信发送器；测试可注入假实现，未配置时用会抛错的占位实现。 */
  readonly smsSender: SmsSender;
}

let cachedDocument: OpenApiDocument | undefined;

function openApiDocument(): OpenApiDocument {
  cachedDocument ??= buildOpenApiDocument(ROUTES);
  return cachedDocument;
}

/** 失败审计的 objectType：按端点推断；未登记的回退 `http_request`。 */
/** 无数据库时保持骨架语义：501 + operationId（与 sales 等模块同一约定）。 */
function requireDatabase(instance: FastifyInstance, route: RouteDef): Database {
  const database = instance.database;
  if (!database) {
    throw new AppError(
      'NOT_IMPLEMENTED',
      `${route.operationId} 尚未实现（数据库未配置）`,
      { operationId: route.operationId },
    );
  }
  return database;
}

const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'platform.auth.login': 'session',
  'platform.code.send': 'login_code',
  'platform.auth.logout': 'session',
  'platform.audit.read': 'audit_log',
  'platform.token.create': 'api_token',
  'platform.token.read': 'api_token',
  'platform.token.revoke': 'api_token',
  'platform.permission.update': 'employee',
  'platform.employee.create': 'employee',
  'platform.employee.update': 'employee',
  'platform.employee.disable': 'employee',
  'platform.company.create': 'company',
  'platform.company.update': 'company',
  'platform.position.create': 'position',
  'platform.position.update': 'position',
  'platform.position.delete': 'position',
  'billing.subscription.update': 'company',
};

function userAgentOf(request: FastifyRequest): string | null {
  const raw = request.headers['user-agent'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : null;
}

/**
 * 订阅调整按契约强制 X-Reason（运营写操作）。错误码表里没有 400，
 * 这里显式映射，仍走统一错误体与 mountRoutes 的失败审计。
 */
class MissingReasonError extends AppError {
  override get status(): number {
    return 400;
  }

  constructor() {
    super('VALIDATION_FAILED', '本端点必须提供 X-Reason 说明调整原因', { header: 'X-Reason' });
  }
}

export function registerPlatformRoutes(app: FastifyInstance, options: PlatformRoutesOptions): void {
  const handlers: RouteHandlers = {
    'platform.health.read': () => ({ status: 'ok' as const, version: options.version }),
    'platform.openapi.read': ({ reply }) => {
      reply.type('application/json; charset=utf-8');
      return openApiDocument();
    },
    // 必须 await（mountRoutes 会 await handler 返回值）：只 return Promise 的话，
    // 拒绝会绕过失败审计。
    'platform.auth.login': ({ app: instance, request, reply }) =>
      login({ database: instance.database, config: options.config, request, reply }),
    'platform.code.send': ({ app: instance, request }) =>
      sendLoginCode({
        database: instance.database,
        config: options.config,
        smsSender: options.smsSender,
        request,
      }).catch((error: unknown) => {
        // 生产环境短信未配置：明确 501，别让用户以为是验证码错。
        if (error instanceof SmsNotConfiguredError) {
          throw new AppError('NOT_IMPLEMENTED', error.message, {
            operationId: 'platform.code.send',
          });
        }
        throw error;
      }),
    'platform.auth.logout': ({ app: instance, request, reply }) =>
      logout({ database: instance.database, config: options.config, request, reply }),
    'platform.auth.me': ({ app: instance, request }) => me({ database: instance.database, request }),
    'platform.employee.read': ({ app: instance, request }) =>
      listEmployees({ database: instance.database, request }),
    'platform.employee.create': ({ app: instance, request, reply }) =>
      createEmployee({ database: instance.database, request, reply }),
    'platform.employee.update': ({ app: instance, request, reply }) =>
      updateEmployee({ database: instance.database, request, reply }),
    'platform.employee.disable': ({ app: instance, request, reply }) =>
      disableEmployee({ database: instance.database, request, reply }),
    'platform.token.create': ({ app: instance, request, reply }) =>
      createApiToken({ database: instance.database, request, reply }),
    'platform.token.read': ({ app: instance, request }) =>
      listApiTokens({ database: instance.database, request }),
    'platform.token.revoke': ({ app: instance, request, reply }) =>
      revokeApiToken({ database: instance.database, request, reply }),
    'platform.audit.read': ({ app: instance, request }) =>
      listAuditLogs({ database: instance.database, request }),
    'platform.permission.update': ({ app: instance, request, reply }) =>
      updatePermissionOverrides({ database: instance.database, request, reply }),
    'platform.company.list': ({ app: instance, request }) =>
      listCompanies({ database: instance.database, request }),
    'platform.company.create': ({ app: instance, request, reply }) =>
      createCompany({ database: instance.database, request, reply }),
    'platform.company.update': ({ app: instance, request, reply }) =>
      updateCompany({ database: instance.database, request, reply }),
    'platform.position.list': ({ app: instance, request }) =>
      listPositions({ database: instance.database, request }),
    'platform.position.create': ({ app: instance, request, reply }) =>
      createPosition({ database: instance.database, request, reply }),
    'platform.position.update': ({ app: instance, request, reply }) =>
      updatePosition({ database: instance.database, request, reply }),
    'platform.position.delete': ({ app: instance, request, reply }) =>
      disablePosition({ database: instance.database, request, reply }),
    'billing.subscription.read': async ({ app: instance, request, route }) => {
      const database = requireDatabase(instance, route);
      const principal = request.principal;
      if (!principal) throw new AppError('UNAUTHENTICATED');
      if (!allowsScope(principal.scope, 'billing', 'read')) {
        throw new AppError('FORBIDDEN', '缺少 billing.read 权限');
      }
      // 契约无 companyId 入参：取当前主体可见公司集合中的第一家公司。
      const companyId = principal.companyIds[0];
      if (!companyId) {
        throw new AppError('NOT_FOUND', '当前账号未绑定任何公司');
      }
      return await withTenant(database, principal.tenantId, (tx) =>
        getCompanySubscription(tx, companyId),
      );
    },
    'billing.subscription.update': async ({ app: instance, request, route }) => {
      const database = requireDatabase(instance, route);
      const principal = request.principal;
      if (!principal) throw new AppError('UNAUTHENTICATED');
      if (!allowsScope(principal.scope, 'billing', 'update')) {
        throw new AppError('FORBIDDEN', '缺少 billing.update 权限');
      }

      if (!request.auditReason) throw new MissingReasonError();

      const parsed = CompanySubscriptionUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_FAILED', '订阅修改入参不合法', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        });
      }

      // 契约无 companyId 入参：与读端点一致，取当前主体可见公司的第一家公司。
      const companyId = principal.companyIds[0];
      if (!companyId) {
        throw new AppError('NOT_FOUND', '当前账号未绑定任何公司');
      }

      return await updateCompanySubscription(database, {
        companyId,
        patch: parsed.data,
        reason: request.auditReason,
        actor: {
          tenantId: principal.tenantId,
          actorType: principal.actorType,
          actorId: principal.actorId,
          credentialId: principal.credentialId,
          source: request.auditSource,
          requestId: requestIdFor(request),
          ip: request.ip,
          userAgent: userAgentOf(request),
        },
      });
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'platform'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
