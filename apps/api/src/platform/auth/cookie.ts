import type { FastifyReply } from 'fastify';
import { SESSION_COOKIE_NAME } from './session-store.js';

/**
 * 会话 Cookie 序列化（D59⑦ / D54）。
 *
 * 不引入 `@fastify/cookie`：只需要一个 HttpOnly 会话 Cookie。
 *   - `HttpOnly`：脚本不可读；
 *   - `SameSite=Lax`：跨站 POST 不携带，配合认证插件的同源校验（D59⑧）；
 *   - `Path=/`：全站可见；
 *   - `Secure`：仅 production（本地 http 调试也能登录）；
 *   - `Max-Age`：TTL 秒数（登出用 0 清除）。
 */

const COOKIE_PATH = '/';

export interface SessionCookieOptions {
  /** 浏览器侧有效期（秒）。 */
  readonly maxAgeSeconds: number;
  /** production 才加 `Secure`。 */
  readonly secure: boolean;
}

function attributes(options: SessionCookieOptions): string {
  const parts = [
    `Path=${COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 序列化登录成功的 `Set-Cookie` 值。 */
export function serializeSessionCookie(token: string, options: SessionCookieOptions): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${attributes(options)}`;
}

/** 序列化登出的清除指令（`Max-Age=0`）。 */
export function serializeClearedSessionCookie(options: { readonly secure: boolean }): string {
  return serializeSessionCookie('', { maxAgeSeconds: 0, secure: options.secure });
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  options: SessionCookieOptions,
): void {
  reply.header('Set-Cookie', serializeSessionCookie(token, options));
}

export function clearSessionCookie(reply: FastifyReply, options: { readonly secure: boolean }): void {
  reply.header('Set-Cookie', serializeClearedSessionCookie(options));
}
