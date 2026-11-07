import type { SettlementOrder } from '@qingdan/contracts';

/**
 * C 单金额脱敏（D27 / D78）。
 *
 * 「看价」是数据可见性开关，不是操作权限（D4）：没有 `settlement.view_price` 时
 * **记录照常可见，只是金额字段返回 `null`** —— 不下发 0、不删字段、不 403。
 * 列表与详情共用本函数（列表也含金额，D27 不分列表/详情）。
 *
 * 注意：脱敏只发生在**响应**上，写路径（确认结算）永远用真实金额计算；
 * 因此确认结算的权限判定不看 view_price。
 */
export type SettlementAmountFields = Pick<
  SettlementOrder,
  | 'totalSaleAmount'
  | 'totalCostAmount'
  | 'grossProfit'
  | 'grossMarginRate'
  | 'relatedLossAmount'
  | 'netProfit'
  | 'commissionAmount'
>;

/** 无看价权限时要置 null 的字段（供测试与文档引用，保持单一真源）。 */
export const SETTLEMENT_MASKED_FIELDS = [
  'totalSaleAmount',
  'totalCostAmount',
  'grossProfit',
  'grossMarginRate',
  'relatedLossAmount',
  'netProfit',
  'commissionAmount',
] as const satisfies readonly (keyof SettlementAmountFields)[];

/** 有看价权限 → 原样返回；无权限 → 金额字段全部置 null（类型本身已 nullable）。 */
export function maskSettlementAmounts<T extends SettlementAmountFields>(
  order: T,
  canViewPrice: boolean,
): T {
  if (canViewPrice) return order;
  return {
    ...order,
    totalSaleAmount: null,
    totalCostAmount: null,
    grossProfit: null,
    grossMarginRate: null,
    relatedLossAmount: null,
    netProfit: null,
    commissionAmount: null,
  };
}
