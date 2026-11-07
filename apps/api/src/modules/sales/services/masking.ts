import type { SalesOrder, SalesOrderDetail } from '@qingdan/contracts';

/**
 * E 单金额脱敏（D27 / D79）。
 *
 * 「看价」是数据可见性开关，不是操作权限（D4）：没有 `sales.view_price` 时
 * **记录照常可见，只是金额字段返回 `null`** —— 不下发 0、不删字段、不 403。
 * 列表与详情共用同一口径；详情多两块：收款记录金额与块内余额。
 *
 * 注意：脱敏只发生在**响应**上，写路径（开单/改单/完成）永远用真实金额计算；
 * 因此写权限判定不看 view_price。
 */
export type SalesOrderAmountFields = Pick<
  SalesOrder,
  'totalAmount' | 'lines' | 'fees'
>;

/** 无看价权限时要置 null 的字段（供测试与文档引用，保持单一真源）。 */
export const SALES_MASKED_FIELDS = [
  'totalAmount',
  'lines[].unitPrice',
  'lines[].amount',
  'fees[].unitPrice',
  'fees[].amount',
] as const;

function maskLines<T extends { unitPrice: string | null; amount: string | null }>(
  lines: T[],
): T[] {
  return lines.map((line) => ({ ...line, unitPrice: null, amount: null }));
}

function maskFees<T extends { unitPrice: string | null; amount: string | null }>(
  fees: T[],
): T[] {
  return fees.map((fee) => ({ ...fee, unitPrice: null, amount: null }));
}

/** 列表实体：单头总额 + 明细/费用单价与金额。 */
export function maskSalesOrderAmounts<T extends SalesOrderAmountFields>(
  order: T,
  canViewPrice: boolean,
): T {
  if (canViewPrice) return order;
  return {
    ...order,
    totalAmount: null,
    lines: maskLines(order.lines),
    fees: maskFees(order.fees),
  };
}

/** 详情实体：在列表口径上再脱敏收款记录金额与块内余额。 */
export function maskSalesOrderDetailAmounts(
  detail: SalesOrderDetail,
  canViewPrice: boolean,
): SalesOrderDetail {
  if (canViewPrice) return detail;
  return {
    ...maskSalesOrderAmounts(detail, false),
    receipts: detail.receipts.map((receipt) => ({ ...receipt, amount: null })),
    receiptBalance: null,
  };
}
