import { AppError, ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes } from '../../platform/http/route-mount.js';
import { receivePaymentCallback } from './usecases/callback.js';

/**
 * payment 模块路由（#101）。
 *
 * 回调是匿名端点，验签需要**原始报文**：
 * - 微信 API v3 对 `timestamp\nnonce\nrawBody\n` 做 RSA 验签，JSON 不能先被反序列化再
 *   序列化回去（空白 / 键序都可能变）；
 * - 支付宝是 form 编码，另外兼容 JSON / text/plain 两种 content-type。
 *
 * 因此这里用**封装插件**注册 parser 和路由：content-type parser 只作用于 payment
 * 作用域，不影响其它模块的 `application/json` 解析。
 */

const RAW_BODY_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain',
] as const;

export function registerPaymentRoutes(app: FastifyInstance): void {
  app.register(async (paymentApp) => {
    for (const contentType of RAW_BODY_CONTENT_TYPES) {
      paymentApp.addContentTypeParser(
        contentType,
        { parseAs: 'string' },
        (_request, body, done) => {
          done(null, body);
        },
      );
    }

    mountRoutes(paymentApp, {
      routes: routesOfModule(ROUTES, 'payment'),
      handlers: {
        'payment.callback.receive': async ({ app: instance, request }) => {
          if (!instance.database) {
            throw new AppError(
              'NOT_IMPLEMENTED',
              'payment.callback.receive 尚未实现（数据库未配置）',
              { operationId: 'payment.callback.receive' },
            );
          }
          return await receivePaymentCallback({
            database: instance.database,
            request,
          });
        },
      },
    });
  });
}
