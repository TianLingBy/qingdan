/**
 * 在线收款接口封装（#101 发起侧 / #386）。
 *
 * 三条端点（`payments.ts`）：
 * - `POST /sales-orders/{orderId}/payment-requests` —— 发起收款，body **只有渠道**；
 * - `GET  /payments/{id}` —— 查待支付单（含二维码、金额、有效期）；
 * - `POST /payments/mock/{providerOrderNo}/confirm` —— mock 模式下模拟「客户已付款」。
 *
 * 口径（别在这里发明）：
 * - **金额由服务端按应收余额算**，前端不传。契约 `.strict()` 会拒绝多余字段 ——
 *   这是刻意的：允许客户端传金额就多了一条「100 元的单子改成 0.01 元」的路；
 * - **同单同渠道未过期的待支付单会被复用**，所以反复点「发起收款」不会生成一堆二维码，
 *   对账时不会有「同一笔钱 N 个入口」的问题；
 * - **不需要 `If-Match`**：发起收款不改单据本身（契约 `requiresIfMatch: false`）；
 * - `qrContent` / `payUrl` 是**可能为 null** 的：live 模式下单还没落地到支付平台时就没有；
 * - `mock.confirm` 只存在于 mock 模式，live 模式返回 **404**（不是 403 —— 存在性本身不该暴露）。
 */

import type {
  PaymentCallbackResult,
  PaymentChannel,
  PaymentRequest,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';

export function createPaymentsApi(client: ApiClient = apiClient) {
  return {
    /** 发起收款：金额由服务端按「总额 − 已收」算，前端只选渠道。 */
    createRequest: (orderId: string, channel: PaymentChannel) =>
      client.post<PaymentRequest>(`/sales-orders/${orderId}/payment-requests`, { channel }),
    /** 查待支付单。`pending` 且已过有效期时服务端返回 `expired`（惰性判定，不写库）。 */
    read: (id: string) => client.get<PaymentRequest>(`/payments/${id}`),
    /**
     * mock 模式下模拟客户已付款（复用真实回调的入账路径）。
     *
     * 参数是**商户订单号**不是待支付单 id：这个端点模拟的是第三方平台投递回调，
     * 平台那边只认自己下发的 `out_trade_no`。
     */
    mockConfirm: (providerOrderNo: string) =>
      client.post<PaymentCallbackResult>(
        `/payments/mock/${encodeURIComponent(providerOrderNo)}/confirm`,
        undefined,
      ),
  };
}

export type PaymentsApi = ReturnType<typeof createPaymentsApi>;
export const paymentsApi = createPaymentsApi();

export const paymentQueryKeys = {
  /** 待支付单：轮询等「客户付了没」时按这个键失效。 */
  request: (id: string | null) => ['payments', 'request', id] as const,
};
