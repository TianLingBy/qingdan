import { AppError, SYSTEM_ACTOR_ID, type RouteDef } from '@qingdan/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recordAuditFailure, wasFailureAuditRecorded } from '../audit/writer.js';
import { requestIdFor } from './request-id.js';

/**
 * 通用路由挂载器（D62 / Issue #15）。
 *
 * 各业务模块只拿 `routesOfModule(ROUTES, <module>)` 的结果来挂载，禁止遍历整张注册表；
 * `mountRoutes` 负责机械部分：路径转换、路由策略 config 透传、失败审计、未实现端点的 501。
 * 具体实现由调用方以 `handlers[operationId]` 注入；未命中的 operationId 一律 501。
 */

export interface RouteHandlerContext {
  readonly app: FastifyInstance;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly route: RouteDef;
}

export type RouteHandler = (ctx: RouteHandlerContext) => unknown;

export type RouteHandlers = Readonly<Record<string, RouteHandler>>;

export interface MountRoutesOptions {
  /** 本模块要挂载的路由（调用方按 `route.module` 切好）。 */
  readonly routes: readonly RouteDef[];
  /** operationId → 实现；未登记的 operationId 走默认 501。 */
  readonly handlers: RouteHandlers;
  /** 失败审计的 objectType：按 operationId 查表；缺省回退 `http_request`。 */
  readonly failureObjectTypes?: Readonly<Record<string, string>>;
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
  failureObjectTypes: Readonly<Record<string, string>>,
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
      objectType: failureObjectTypes[route.operationId] ?? 'http_request',
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

export function mountRoutes(app: FastifyInstance, options: MountRoutesOptions): void {
  const failureObjectTypes = options.failureObjectTypes ?? {};

  for (const route of options.routes) {
    app.route({
      method: route.method,
      url: fastifyPath(route.path),
      // 与契约注册表对齐：日志 / 错误体 / 认证插件 / 后续 reason、If-Match、dry-run 闸门都读这里。
      config: {
        operationId: route.operationId,
        module: route.module,
        auditKind: route.audit.kind,
        publicAccess: route.publicAccess,
        requiresIfMatch: route.requiresIfMatch,
        dryRun: route.dryRun,
        ai: route.ai,
      },
      handler: async (request, reply) => {
        try {
          const handler = options.handlers[route.operationId];
          if (!handler) {
            throw new AppError(
              'NOT_IMPLEMENTED',
              `${route.operationId} 尚未实现（M0 骨架只登记端点签名）`,
              { operationId: route.operationId, method: route.method, path: route.path },
            );
          }
          return await handler({ app, request, reply, route });
        } catch (error) {
          // 被拒的写请求同样要留痕：先补失败审计，再把原错误交给统一错误处理。
          await auditHandlerFailure(app, route, request, error, failureObjectTypes);
          throw error;
        }
      },
    });
  }
}
