import { ROUTES, buildOpenApiDocument, routesOfModule, type OpenApiDocument } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../platform/config.js';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';
import { createApiToken, listApiTokens, revokeApiToken } from './usecases/api-tokens.js';
import { listAuditLogs } from './usecases/audit-logs.js';
import { listEmployees } from './usecases/employees.js';
import { login } from './usecases/login.js';
import { logout } from './usecases/logout.js';
import { me } from './usecases/me.js';
import { updatePermissionOverrides } from './usecases/permission-overrides.js';

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
}

let cachedDocument: OpenApiDocument | undefined;

function openApiDocument(): OpenApiDocument {
  cachedDocument ??= buildOpenApiDocument(ROUTES);
  return cachedDocument;
}

/** 失败审计的 objectType：按端点推断；未登记的回退 `http_request`。 */
const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'platform.auth.login': 'session',
  'platform.auth.logout': 'session',
  'platform.audit.read': 'audit_log',
  'platform.token.create': 'api_token',
  'platform.token.read': 'api_token',
  'platform.token.revoke': 'api_token',
  'platform.permission.update': 'employee',
};

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
    'platform.auth.logout': ({ app: instance, request, reply }) =>
      logout({ database: instance.database, config: options.config, request, reply }),
    'platform.auth.me': ({ app: instance, request }) => me({ database: instance.database, request }),
    'platform.employee.read': ({ app: instance, request }) =>
      listEmployees({ database: instance.database, request }),
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
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'platform'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
