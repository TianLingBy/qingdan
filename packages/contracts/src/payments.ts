import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 在线支付契约（#101，商户模式 A：客户扫码 + 到账回调）。
 *
 * 口径约束：
 * - **回调匿名可达**：第三方支付平台不携带本系统会话，验签由 handler 负责；
 * - **原始报文由 handler 处理**：微信 / 支付宝的回调格式不同（XML / form / JSON），
 *   契约层不声明 body schema，避免把某一家厂商的报文结构固化进注册表；
 * - **幂等**：同一笔回调可能重复投递，handler 按商户订单号 + 交易号做幂等入账；
 * - 回调不是本系统用户的写操作，不记操作日志（`audit.kind: 'none'`）。
 */

export const PaymentChannelSchema = z.enum(['wechat', 'alipay']);
export type PaymentChannel = z.infer<typeof PaymentChannelSchema>;

export const PaymentCallbackResultSchema = z.object({
  received: z.boolean(),
  duplicate: z.boolean(),
  receiptId: z.string().uuid().nullable(),
});
export type PaymentCallbackResult = z.infer<typeof PaymentCallbackResultSchema>;

export const PAYMENT_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'payment',
    domain: 'payment',
    action: 'create',
    operationId: 'payment.callback.receive',
    method: 'POST',
    path: '/api/v1/payments/{channel}/callback',
    summary: '第三方支付异步回调：验签→金额校验→幂等入账，匿名可达',
    publicAccess: true,
    idempotent: true,
    audit: { kind: 'none' },
    response: { status: 200, schema: PaymentCallbackResultSchema },
  }),
];
