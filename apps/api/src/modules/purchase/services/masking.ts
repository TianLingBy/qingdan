import type { PurchaseOrder } from '@qingdan/contracts';

/**
 * A 单金额脱敏（D27 / D79）。
 *
 * 「看价」是数据可见性开关，不是操作权限（D4）：没有 `purchase.view_price` 时
 * **记录照常可见，只是金额字段返回 `null`** —— 不下发 0、不删字段、不 403。
 * 覆盖：单头 `goodsAmount` / `feeAmount` / `totalAmount`，明细与费用行的
 * `unitPrice` / `amount`。
 *
 * 注意：脱敏只发生在**响应**上，写路径（开单/改单/完成入库）永远用真实金额计算；
 * 因此写权限判定不看 view_price。
 */
export type PurchaseOrderAmountFields = Pick<
  PurchaseOrder,
  'goodsAmount' | 'feeAmount' | 'totalAmount' | 'lines' | 'fees'
>;

/** 无看价权限时要置 null 的字段（供测试与文档引用，保持单一真源）。 */
export const PURCHASE_MASKED_FIELDS = [
  'goodsAmount',
  'feeAmount',
  'totalAmount',
  'lines[].unitPrice',
  'lines[].amount',
  'fees[].unitPrice',
  'fees[].amount',
] as const;

/** 有看价权限 → 原样返回；无权限 → 金额字段全部置 null（类型本身已 nullable）。 */
export function maskPurchaseOrderAmounts<T extends PurchaseOrderAmountFields>(
  order: T,
  canViewPrice: boolean,
): T {
  if (canViewPrice) return order;
  return {
    ...order,
    goodsAmount: null,
    feeAmount: null,
    totalAmount: null,
    lines: order.lines.map((line) => ({
      ...line,
      unitPrice: null,
      amount: null,
    })),
    fees: order.fees.map((fee) => ({
      ...fee,
      unitPrice: null,
      amount: null,
    })),
  };
}
