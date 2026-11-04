import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerPlatformRoutes } from './modules/platform/routes.js';
import { registerAuthPlugin } from './platform/auth/plugin.js';
import { loadConfig, type AppConfig } from './platform/config.js';
import type { Database } from './platform/db/client.js';
import { registerAuditContext } from './platform/http/audit-context.js';
import { registerErrorHandling } from './platform/http/errors.js';
import { registerSecurityHeaders } from './platform/http/headers.js';
import { registerRequestId } from './platform/http/request-id.js';

/**
 * 组装 Fastify 实例（不监听端口，便于 `app.inject` 测试）。
 *
 * 可注入：config / 数据库 / 版本 / 日志 / requestId 生成器。生产由 `main.ts` 调；
 * 测试注入 `testConfig()` + 可选 PGlite 数据库。骨架阶段端点全是 501，没有数据库也能起。
 */

export const APP_VERSION = '0.0.0';

declare module 'fastify' {
  interface FastifyInstance {
    /** 注入的数据库句柄；未配置 `DATABASE_URL` 时为 null。 */
    database: Database | null;
  }
}

export interface BuildAppOptions {
  readonly config?: AppConfig;
  readonly database?: Database | null;
  readonly version?: string;
  /** false 关闭日志；不传则按 config.nodeEnv / config.logLevel 决定。 */
  readonly logger?: FastifyServerOptions['logger'];
  /** 测试注入固定 request id。 */
  readonly requestIdFactory?: () => string;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const logger =
    options.logger ?? (config.nodeEnv === 'test' ? false : { level: config.logLevel });

  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  app.decorate('database', options.database ?? null);

  registerRequestId(app, options.requestIdFactory ? { factory: options.requestIdFactory } : {});
  registerAuditContext(app);
  registerAuthPlugin(app, { config });
  registerSecurityHeaders(app);
  registerErrorHandling(app);
  registerPlatformRoutes(app, { version: options.version ?? APP_VERSION, config });

  return app;
}
