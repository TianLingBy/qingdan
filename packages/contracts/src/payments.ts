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

/**
 * 发起收款（客户扫码）→ 待支付单。
 *
 * 金额一律字符串：金额是 money 语义（定点小数），交给 JS number 处理会在 0.1 + 0.2
 * 这类地方丢精度，而这条链路上的每个数字都要被对账。与既有契约（D54）一致。
 */
export const PaymentRequestStatusSchema = z.enum(['pending', 'paid', 'expired', 'cancelled']);
export type PaymentRequestStatus = z.infer<typeof PaymentRequestStatusSchema>;

export const PaymentRequestSchema = z.object({
  id: z.string().uuid(),
  salesOrderId: z.string().uuid(),
  channel: PaymentChannelSchema,
  amount: z.string(),
  status: PaymentRequestStatusSchema,
  /**
   * 商户订单号（微信 `out_trade_no`）：回调靠它对齐幂等键，客服对账也靠它。
   *
   * 对外暴露无风险 —— 它是**我们自己生成的**号（`QD + 公司码 + 时间戳 + 随机`），
   * 不带客户信息、不带金额，且客户在收银台上本来就看得见。
   * 不暴露它的后果是：前端拿不到它就没法调 `payment.mock.confirm` 做端到端验证，
   * 只能从 `qrContent` 里正则抠出来 —— 把内部标识的获取方式变成「解析另一段字符串」。
   */
  providerOrderNo: z.string(),
  qrContent: z.string().nullable(),
  payUrl: z.string().nullable(),
  expiresAt: z.string(),
  paidAt: z.string().nullable(),
});
export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;

/**
 * 发起收款入参：**只有渠道**。
 *
 * `.strict()` 不是洁癖：金额必须由服务端按「应收余额」算。若允许客户端传 amount，
 * 就多了一条「把 100 元单子改成 0.01 元支付」的路径，而收多少是账的事，不是表单的事。
 * 传了多余字段直接 422，让调用方立刻知道这里不接受金额。
 */
export const PaymentRequestCreateInputSchema = z
  .object({ channel: PaymentChannelSchema })
  .strict();
export type PaymentRequestCreateInput = z.infer<typeof PaymentRequestCreateInputSchema>;

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
  defineRoute({
    module: 'payment',
    domain: 'payment',
    action: 'create',
    operationId: 'payment.request.create',
    method: 'POST',
    path: '/api/v1/sales-orders/{orderId}/payment-requests',
    summary:
      '发起客户扫码收款：服务端按应收余额算金额并生成支付二维码（不接收金额入参；同一单同渠道未过期的待支付单直接复用）',
    // 发起收款不改单据本身，所以不要求 If-Match；但它是员工发起的收款动作，必须留痕。
    audit: { kind: 'write' },
    requiresIfMatch: false,
    // 动钱的动作 AI 一律不许：金额与对象都由请求决定，没有「AI 也能做对」的余地。
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: PaymentRequestCreateInputSchema },
    response: { status: 200, schema: PaymentRequestSchema },
  }),
  defineRoute({
    module: 'payment',
    domain: 'payment',
    action: 'read',
    operationId: 'payment.request.read',
    method: 'GET',
    path: '/api/v1/payments/{id}',
    summary: '查询待支付单（含二维码与金额）；已过期但未写入库的 pending 单在这里返回 expired',
    audit: { kind: 'none' },
    response: { status: 200, schema: PaymentRequestSchema },
  }),
  defineRoute({
    module: 'payment',
    domain: 'payment',
    action: 'create',
    operationId: 'payment.mock.confirm',
    method: 'POST',
    path: '/api/v1/payments/mock/{providerOrderNo}/confirm',
    summary:
      'mock 模式下模拟第三方平台「客户已付款」：复用回调入账路径写收款；live 模式返回 404（不暴露存在性）',
    // 模拟第三方平台投递回调：不带本系统会话，重复调用按幂等返回 duplicate。
    publicAccess: true,
    idempotent: true,
    audit: { kind: 'none' },
    // `confirm` 是危险动词（registry.test 的 D54⑥ 守卫）：它真的会写一条收款行，
    // 即便是 mock 也不许 AI 触发——真钱与假钱只隔 QINGDAN_PAYMENT_MODE 一个开关。
    ai: { policy: 'forbid', reasonRequired: true },
    response: { status: 200, schema: PaymentCallbackResultSchema },
  }),
];
