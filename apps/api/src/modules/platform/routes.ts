import { AppError, ROUTES, buildOpenApiDocument, type OpenApiDocument } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';

/**
 * platform 端点挂载（M0 骨架）。
 *
 * 路由**只从契约注册表 `ROUTES` 生成**，禁止手写 path/scope 绕过注册表：
 *   - `GET /api/v1/health` → 200 `{ status:'ok', version }`（不认证、不记审计）；
 *   - `GET /api/v1/openapi.json` → 由 `buildOpenApiDocument(ROUTES)` 现发射；
 *   - 其余已登记端点 → 501 `NOT_IMPLEMENTED`（D54 缺口 10：先登记签名，handler 后补）。
 */

export interface PlatformRoutesOptions {
  /** 健康检查回显的 API 版本。 */
  readonly version: string;
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
      // 与契约 operationId / 审计策略对齐，便于日志、错误体与 reason 闸门定位到注册表条目。
      config: { operationId: route.operationId, auditKind: route.audit.kind },
      handler: async (_request, reply) => {
        switch (route.operationId) {
          case 'platform.health.read':
            return { status: 'ok' as const, version: options.version };
          case 'platform.openapi.read':
            reply.type('application/json; charset=utf-8');
            return openApiDocument();
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
