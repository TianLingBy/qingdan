import { AppError, ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes } from '../../platform/http/route-mount.js';
import { receivePaymentCallback } from './usecases/callback.js';
import { createPaymentRequest } from './usecases/create-request.js';
import { confirmMockPayment } from './usecases/mock-confirm.js';
import { readPaymentRequest } from './usecases/read-request.js';

/**
 * payment 模块路由（#101）。
 *
 * 回调是匿名端点，验签需要**原始报文**：
 * - 微信 API v3 对 `timestamp\nnonce\nrawBody\n` 做 RSA 验签，JSON 不能先被反序列化再
 *   序列化回去（空白 / 键序都可能变）；
 * - 支付宝是 form 编码，另外兼容 JSON / text/plain 两种 content-type。
 *
 * 因此回调单独放在一个封装插件里注册 parser：content-type parser 只作用于回调作用域，
 * 既不影响其它模块的 `application/json`，也不会让「发起收款」这条普通 JSON 端点
 * 收到一个字符串 body（那样 `.strict()` 校验会把合法请求判成不合法）。
 */

const RAW_BODY_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain',
] as const;

const CALLBACK_OPERATION_ID = 'payment.callback.receive';

export function registerPaymentRoutes(app: FastifyInstance): void {
  const routes = routesOfModule(ROUTES, 'payment');

  app.register(async (callbackApp) => {
    for (const contentType of RAW_BODY_CONTENT_TYPES) {
      callbackApp.addContentTypeParser(
        contentType,
        { parseAs: 'string' },
        (_request, body, done) => {
          done(null, body);
        },
      );
    }

    mountRoutes(callbackApp, {
      routes: routes.filter((route) => route.operationId === CALLBACK_OPERATION_ID),
      handlers: {
        [CALLBACK_OPERATION_ID]: async ({ app: instance, request }) => {
          if (!instance.database) {
            throw new AppError(
              'NOT_IMPLEMENTED',
              'payment.callback.receive 尚未实现（数据库未配置）',
              { operationId: CALLBACK_OPERATION_ID },
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

  // 发起 / 查单 / mock 确认：普通 JSON 端点，不需要原始报文。
  app.register(async (paymentApp) => {
    mountRoutes(paymentApp, {
      routes: routes.filter((route) => route.operationId !== CALLBACK_OPERATION_ID),
      handlers: {
        'payment.request.create': ({ app: instance, request }) =>
          createPaymentRequest({ database: instance.database, request }),
        'payment.request.read': ({ app: instance, request }) =>
          readPaymentRequest({ database: instance.database, request }),
        'payment.mock.confirm': ({ app: instance, request }) =>
          confirmMockPayment({ database: instance.database, request }),
      },
    });
  });
}
