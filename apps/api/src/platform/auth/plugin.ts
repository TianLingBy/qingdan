import { AppError, HEADERS } from '@qingdan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { setSessionCookie } from './cookie.js';
import { parseCookieHeader, resolvePrincipal, type Principal } from './principal.js';
import { SESSION_COOKIE_NAME } from './session-store.js';

/**
 * 认证 Fastify 插件（D59）。
 *
 * - `onRequest` 里解析主体，成功写 `request.principal` + `request.actorType`
 *   （后者供既有 reason 闸门使用，D52.1 / audit-context.ts）；
 * - 公开路由跳过认证：优先看 `routeOptions.config.publicAccess`，没有标记再按路径白名单
 *   （health / openapi.json）；
 * - 登录 / 登出属「可选认证」：匿名可到达 handler，但带有效 Cookie 时仍做同源校验；
 * - CSRF（D59⑧）：**Cookie 认证** + 非安全方法必须同源（Origin 或 Referer），
 *   期望同源 = `PUBLIC_BASE_URL`（若配置）或请求 Host；缺失/跨源 → 403 FORBIDDEN。
 *   Bearer 请求不受 CSRF 约束（浏览器不会自动携带）。
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** 认证成功后的请求主体；未认证 / 公开路由为 null。 */
    principal: Principal | null;
  }
}

/** 公开路径白名单（routeOptions.config.publicAccess 缺失时的兜底）。 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/api/v1/health', '/api/v1/openapi.json']);

/**
 * 「可选认证」路径：未带凭证也放行到 handler，但带了有效 Cookie 时仍做同源校验。
 *
 * 登录 / 登出需要匿名可达（契约注册表里它们不是 publicAccess 端点）：
 *   - 登录由手机号 + 验证码自行认证；
 *   - 登出必须幂等（会话已失效也要清 Cookie 并返回成功）。
 * 有效 Cookie 的 CSRF 约束（D59⑧）不因此放宽 —— 同源校验仍会执行。
 */
export const OPTIONAL_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/auth/code',
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
]);

const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

function requestPath(request: FastifyRequest): string {
  const routeUrl = request.routeOptions?.url;
  const raw = typeof routeUrl === 'string' && routeUrl !== '' ? routeUrl : request.url;
  return raw.split('?')[0] ?? raw;
}

export function isPublicRequest(request: FastifyRequest): boolean {
  const config = request.routeOptions?.config as { publicAccess?: unknown } | undefined;
  if (config?.publicAccess === true) return true;
  return PUBLIC_PATHS.has(requestPath(request));
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export interface SameOriginInput {
  readonly origin: string | undefined;
  readonly referer: string | undefined;
  readonly host: string | undefined;
  /** 请求协议（经 trustProxy 解析后的 `request.protocol`）。 */
  readonly protocol: string;
  /** 配置的对外基址；空串 = 不参与判定，按请求 Host 推断同源。 */
  readonly publicBaseUrl: string;
}

/**
 * 校验 Cookie 认证的非安全请求是否同源。
 * 浏览器发 `Origin` 优先；没有时退回 `Referer`；两者都没有视为不可信。
 */
export function assertCookieRequestSameOrigin(input: SameOriginInput): void {
  const candidate = originOf(input.origin) ?? originOf(input.referer);
  if (!candidate) {
    throw new AppError(
      'FORBIDDEN',
      'Cookie 认证的非安全请求必须携带同源 Origin 或 Referer',
    );
  }

  // 配置了 PUBLIC_BASE_URL 时**只认它**：否则任意 Host（可被 X-Forwarded-Host / 直接请求头伪造）
  // 都能与攻击者 Origin 配对通过同源校验。未配置时才退回按请求 Host 推断。
  const configured = originOf(input.publicBaseUrl);
  const allowed = configured
    ? configured
    : input.host
      ? originOf(`${input.protocol}://${input.host}`)
      : null;

  if (!allowed || allowed !== candidate) {
    throw new AppError('FORBIDDEN', 'Cookie 认证的非安全请求来源与本站不同源');
  }
}

export interface AuthPluginOptions {
  readonly config: Pick<AppConfig, 'sessionTtlDays' | 'publicBaseUrl' | 'nodeEnv'>;
}

const DAY_SECONDS = 24 * 60 * 60;

export function registerAuthPlugin(app: FastifyInstance, options: AuthPluginOptions): void {
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicRequest(request)) return;

    // M0 骨架允许不配数据库启动（端点统一 501）；没有库时无从认证，保持未认证。
    const database = app.database;
    if (!database) return;

    const optionalAuth = OPTIONAL_AUTH_PATHS.has(requestPath(request));
    let principal: Principal;
    try {
      principal = await resolvePrincipal(
        database,
        {
          authorization: headerValue(request, 'authorization'),
          cookie: headerValue(request, 'cookie'),
          ip: request.ip,
          client: headerValue(request, HEADERS.client),
        },
        { sessionTtlDays: options.config.sessionTtlDays },
      );
    } catch (error) {
      // 登录 / 登出允许匿名：坏 Cookie / 过期会话不应把用户挡在登录页外。
      // 只吞「凭证无效」；内部错误照常上抛，不能借可选认证掩盖故障。
      // 带了有效 Cookie 的请求仍会继续走下面的 CSRF 校验。
      if (optionalAuth && error instanceof AppError && error.code === 'UNAUTHENTICATED') return;
      throw error;
    }

    if (principal.credentialType === 'session' && isUnsafeMethod(request.method)) {
      assertCookieRequestSameOrigin({
        origin: headerValue(request, 'origin'),
        referer: headerValue(request, 'referer'),
        host: headerValue(request, 'host'),
        protocol: request.protocol,
        publicBaseUrl: options.config.publicBaseUrl,
      });
    }

    // 滑动续期实际写入时同步续浏览器 Cookie：属性与登录一致，值仍是同一个会话令牌。
    // 放在同源校验之后 —— 跨源请求即使触发了续期，也不给攻击者下发新 Cookie。
    if (principal.credentialType === 'session' && principal.sessionRenewed) {
      const token = parseCookieHeader(headerValue(request, 'cookie'), SESSION_COOKIE_NAME);
      if (token) {
        setSessionCookie(reply, token, {
          maxAgeSeconds: options.config.sessionTtlDays * DAY_SECONDS,
          secure: options.config.nodeEnv === 'production',
        });
      }
    }

    request.principal = principal;
    request.actorType = principal.actorType;
  });
}
