import type {
  InternalTradeOrder,
  InternalTradeOrderDetail,
} from '@qingdan/contracts';

/**
 * N 单金额脱敏（D27 / D79）。
 *
 * 「看价」是数据可见性开关，不是操作权限（D4）：没有 `internal_trade.view_price` 时
 * **记录照常可见，只是金额字段返回 `null`** —— 不下发 0、不删字段、不 403。
 *
 * 覆盖：单头 `internalPrice`，明细 `lines[].unitPrice` / `lines[].amount`。
 * **数量不脱敏**：`qty` / `inTransitQty` 是作业数据（多少件在路上），不是价格。
 *
 * 注意：脱敏只发生在**响应**上，写路径（开单/改单）永远用真实金额落库；
 * 因此写权限判定不看 view_price。
 */

/** 无看价权限时要置 null 的字段（供测试与文档引用，保持单一真源）。 */
export const INTERNAL_TRADE_MASKED_FIELDS = [
  'internalPrice',
  'lines[].unitPrice',
  'lines[].amount',
] as const;

/** 列表/写响应脱敏：有权限原样返回，无权限金额置 null。 */
export function maskInternalTradeAmounts(
  order: InternalTradeOrder,
  canViewPrice: boolean,
): InternalTradeOrder {
  if (canViewPrice) return order;
  return {
    ...order,
    internalPrice: null,
    lines: order.lines.map((line) => ({
      ...line,
      unitPrice: null,
      amount: null,
    })),
  };
}

/** 详情脱敏：在列表口径之上保留 `cancelable`（取消判定与价格无关，不能一起被抹掉）。 */
export function maskInternalTradeDetailAmounts(
  detail: InternalTradeOrderDetail,
  canViewPrice: boolean,
): InternalTradeOrderDetail {
  if (canViewPrice) return detail;
  return {
    ...detail,
    internalPrice: null,
    lines: detail.lines.map((line) => ({
      ...line,
      unitPrice: null,
      amount: null,
    })),
  };
}
