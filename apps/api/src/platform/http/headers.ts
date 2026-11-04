import type { FastifyInstance } from 'fastify';

/**
 * 最小安全响应头。
 *
 * `X-Powered-By` 是显式标识（不是框架泄漏）；其余为 API 服务的低风险加固项：
 * 禁止 MIME 嗅探、禁止缓存认证响应。
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Powered-By', 'qingdan-api');
    if (!reply.hasHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
}
