import {
  AppError,
  ROUTES,
  SYSTEM_ACTOR_ID,
  buildOpenApiDocument,
  type OpenApiDocument,
  type RouteDef,
} from '@qingdan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { recordAuditFailure, wasFailureAuditRecorded } from '../../platform/audit/writer.js';
import type { AppConfig } from '../../platform/config.js';
import { requestIdFor } from '../../platform/http/request-id.js';
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

/** 失败也要落审计的路由类型（成功路径各自在用例里写，见 usecases/）。 */
const FAILURE_AUDITED_KINDS: ReadonlySet<string> = new Set(['write', 'sensitive-read']);

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

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

function objectIdOf(request: FastifyRequest): string | null {
  const params = request.params as Record<string, unknown> | undefined;
  const value = params?.employeeId ?? params?.id;
  return typeof value === 'string' ? value : null;
}

/**
 * handler 抛错时为 write / sensitive-read 端点补一条 `result='fail'` 审计（D51 / D55⑤）。
 *
 * - 失败审计写失败只记服务端日志，**原错误继续上抛**（不能让审计故障掩盖业务故障）；
 * - 已由用例自行记录失败的请求（登录）通过 `wasFailureAuditRecorded` 去重；
 * - 成功路径不经过这里，仍由各用例自己写 success，避免重复。
 */
async function auditHandlerFailure(
  app: FastifyInstance,
  route: RouteDef,
  request: FastifyRequest,
  error: unknown,
): Promise<void> {
  if (!FAILURE_AUDITED_KINDS.has(route.audit.kind)) return;
  if (wasFailureAuditRecorded(request)) return;
  const database = app.database;
  if (!database) return;

  const principal = request.principal;
  try {
    await recordAuditFailure(database, {
      tenantId: principal?.tenantId ?? null,
      actorType: principal?.actorType ?? 'system',
      actorId: principal?.actorId ?? SYSTEM_ACTOR_ID,
      credentialId: principal?.credentialId ?? null,
      source: request.auditSource,
      action: route.operationId,
      objectType: FAILURE_OBJECT_TYPES[route.operationId] ?? 'http_request',
      objectId: objectIdOf(request),
      result: 'fail',
      errorCode: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
      requestId: requestIdFor(request),
      ip: request.ip,
      userAgent: headerValue(request, 'user-agent') ?? null,
      reason: request.auditReason,
    });
  } catch (auditError) {
    request.log.error(
      { err: auditError, requestId: requestIdFor(request) },
      '失败审计写入失败（保留原错误）',
    );
  }
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
        try {
          switch (route.operationId) {
            case 'platform.health.read':
              return { status: 'ok' as const, version: options.version };
            case 'platform.openapi.read':
              reply.type('application/json; charset=utf-8');
              return openApiDocument();
            case 'platform.auth.login':
              // 必须 await：只 return Promise 的话，拒绝会绕过下面的 catch，失败审计就丢了。
              return await login({
                database: app.database,
                config: options.config,
                request,
                reply,
              });
            case 'platform.auth.logout':
              return await logout({
                database: app.database,
                config: options.config,
                request,
                reply,
              });
            case 'platform.auth.me':
              return await me({ database: app.database, request });
            case 'platform.token.create':
              return await createApiToken({ database: app.database, request, reply });
            case 'platform.token.read':
              return await listApiTokens({ database: app.database, request });
            case 'platform.token.revoke':
              return await revokeApiToken({ database: app.database, request, reply });
            case 'platform.audit.read':
              return await listAuditLogs({ database: app.database, request });
            case 'platform.permission.update':
              return await updatePermissionOverrides({ database: app.database, request, reply });
            default:
              throw new AppError(
                'NOT_IMPLEMENTED',
                `${route.operationId} 尚未实现（M0 骨架只登记端点签名）`,
                { operationId: route.operationId, method: route.method, path: route.path },
              );
          }
        } catch (error) {
          // 被拒的写请求同样要留痕：先补失败审计，再把原错误交给统一错误处理。
          await auditHandlerFailure(app, route, request, error);
          throw error;
        }
      },
    });
  }
}
