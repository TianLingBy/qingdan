import { AppError, ROUTES, buildOpenApiDocument, type OpenApiDocument } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../platform/config.js';
import { createApiToken, listApiTokens, revokeApiToken } from './usecases/api-tokens.js';
import { listAuditLogs } from './usecases/audit-logs.js';
import { login } from './usecases/login.js';
import { logout } from './usecases/logout.js';
import { me } from './usecases/me.js';
import { updatePermissionOverrides } from './usecases/permission-overrides.js';

/**
 * platform 端点挂载。
 *
 * 路由**只从契约注册表 `ROUTES` 生成**，禁止手写 path/scope 绕过注册表：
 *   - `GET /api/v1/health` → 200 `{ status:'ok', version }`（不认证、不记审计）；
 *   - `GET /api/v1/openapi.json` → 由 `buildOpenApiDocument(ROUTES)` 现发射；
 *   - 已实现的认证端点 → 分派到 `usecases/`；
 *   - 其余已登记端点 → 501 `NOT_IMPLEMENTED`（D54 缺口 10：先登记签名，handler 后补）。
 *
 * 注册表里的路由策略（`publicAccess` / `requiresIfMatch` / `dryRun` / `ai`）一并透传到
 * Fastify `config`，认证插件与后续闸门只读 `routeOptions.config`，不另建真源。
 */

export interface PlatformRoutesOptions {
  /** 健康检查回显的 API 版本。 */
  readonly version: string;
  /** 应用配置（登录验证码 / 会话 TTL / 环境）。 */
  readonly config: AppConfig;
}

let cachedDocument: OpenApiDocument | undefined;

function openApiDocument(): OpenApiDocument {
  cachedDocument ??= buildOpenApiDocument(ROUTES);
  return cachedDocument;
}

/**
 * 契约里的路径是 OpenAPI 风格 `{employeeId}`；Fastify 用 `:employeeId`。
 * 只做这一个机械转换，不改注册表、不改 OpenAPI 输出。
 */
export function fastifyPath(path: string): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
}

export function registerPlatformRoutes(app: FastifyInstance, options: PlatformRoutesOptions): void {
  for (const route of ROUTES) {
    app.route({
      method: route.method,
      url: fastifyPath(route.path),
      // 与契约注册表对齐：日志 / 错误体 / 认证插件 / 后续 reason、If-Match、dry-run 闸门都读这里。
      config: {
        operationId: route.operationId,
        auditKind: route.audit.kind,
        publicAccess: route.publicAccess,
        requiresIfMatch: route.requiresIfMatch,
        dryRun: route.dryRun,
        ai: route.ai,
      },
      handler: async (request, reply) => {
        switch (route.operationId) {
          case 'platform.health.read':
            return { status: 'ok' as const, version: options.version };
          case 'platform.openapi.read':
            reply.type('application/json; charset=utf-8');
            return openApiDocument();
          case 'platform.auth.login':
            return login({
              database: app.database,
              config: options.config,
              request,
              reply,
            });
          case 'platform.auth.logout':
            return logout({
              database: app.database,
              config: options.config,
              request,
              reply,
            });
          case 'platform.auth.me':
            return me({ database: app.database, request });
          case 'platform.token.create':
            return createApiToken({ database: app.database, request, reply });
          case 'platform.token.read':
            return listApiTokens({ database: app.database, request });
          case 'platform.token.revoke':
            return revokeApiToken({ database: app.database, request, reply });
          case 'platform.audit.read':
            return listAuditLogs({ database: app.database, request });
          case 'platform.permission.update':
            return updatePermissionOverrides({ database: app.database, request, reply });
          default:
            throw new AppError(
              'NOT_IMPLEMENTED',
              `${route.operationId} 尚未实现（M0 骨架只登记端点签名）`,
              { operationId: route.operationId, method: route.method, path: route.path },
            );
        }
      },
    });
  }
}
