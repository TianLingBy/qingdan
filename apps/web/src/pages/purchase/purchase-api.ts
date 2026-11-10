/**
 * 采购单 A 接口封装（契约第一批 §3.1，5 条端点）。
 *
 * 口径（别在这里发明）：
 * - 金额 / 数量一律 **decimal 字符串**（D54 `numeric(18,6)`），前端不做浮点运算，
 *   合计用 `multiplyDecimal` / `sumDecimal`（BigInt 定点，见下方工具）；
 * - 单号服务端生成（D16），前端不传；
 * - 无 `purchase.view_price` 时服务端把金额回 `null`（D79）——**遮罩是 `null` 触发的，
 *   不是 0**：绝不能把 null 当 0 渲染，那是泄露价格；
 * - 修改 / 取消必须带强 ETag `If-Match: "<version>"`（D60）；
 * - 本批没有「入库 / 完成」端点（等 inventory）：A 单只能进行中 → 已取消。
 */

import type {
  PurchaseOrder,
  PurchaseOrderCreateInput,
  PurchaseOrderDetail,
  PurchaseOrderStatus,
  PurchaseOrderUpdateInput,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';
import type { PageResult } from '../masterdata/masterdata-api';

export interface PurchaseOrderListFilters {
  readonly companyId?: string;
  readonly supplierId?: string;
  readonly status?: PurchaseOrderStatus;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

function listQuery(
  filters: PurchaseOrderListFilters,
): Record<string, string | number | undefined> {
  return {
    companyId: filters.companyId,
    supplierId: filters.supplierId,
    status: filters.status,
    keyword: filters.keyword,
    cursor: filters.cursor ?? undefined,
    limit: filters.limit ?? 50,
  };
}

function ifMatch(version: number): Record<string, string> {
  return { 'If-Match': `"${version}"` };
}

export function createPurchaseApi(client: ApiClient = apiClient) {
  return {
    list: (filters: PurchaseOrderListFilters = {}) =>
      client.get<PageResult<PurchaseOrder>>('/purchase-orders', { query: listQuery(filters) }),
    detail: (id: string) => client.get<PurchaseOrderDetail>(`/purchase-orders/${id}`),
    create: (input: PurchaseOrderCreateInput) =>
      client.post<PurchaseOrder>('/purchase-orders', input),
    update: (id: string, input: PurchaseOrderUpdateInput, version: number) =>
      client.patch<PurchaseOrder>(`/purchase-orders/${id}`, input, { headers: ifMatch(version) }),
    cancel: (id: string, version: number) =>
      client.post<PurchaseOrder>(`/purchase-orders/${id}/cancel`, undefined, {
        headers: ifMatch(version),
      }),
  };
}

export type PurchaseApi = ReturnType<typeof createPurchaseApi>;
export const purchaseApi = createPurchaseApi();

export const purchaseQueryKeys = {
  list: (filters: {
    companyId?: string;
    supplierId?: string;
    status?: PurchaseOrderStatus;
    keyword?: string;
    cursor?: string | null;
  }) => ['purchase-orders', 'list', filters] as const,
  detail: (id: string | null) => ['purchase-orders', 'detail', id] as const,
  /** 明细里只有 productId，商品名要另查主数据映射；主数据页用同一个键，可共享缓存。 */
  products: ['masterdata', 'products', { limit: 200 }] as const,
  suppliers: ['masterdata', 'suppliers', { limit: 200 }] as const,
};

// ============ decimal 定点运算（D54 numeric(18,6)） ============

const SCALE = 6;
const SCALE_FACTOR = 10n ** 6n;
const DECIMAL_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;
/** 费用行金额可为负（D39），求和必须认负数。 */
const SIGNED_DECIMAL_PATTERN = /^-?\d{1,12}(\.\d{1,6})?$/;

/** 浮点会算错钱（0.1 × 3 = 0.30000000000000004），一律走 BigInt 定点。 */
export function isPositiveDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value.trim());
}

function toScaled(value: string): bigint {
  const text = value.trim();
  if (!SIGNED_DECIMAL_PATTERN.test(text)) {
    throw new Error(`不是合法的 decimal 字符串：${value}`);
  }
  // 负号必须先摘掉再拼小数部分，否则 -1.5 会算成 -1000000 + 500000。
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [integer, fraction = ''] = body.split('.');
  const scaled = BigInt(integer!) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
}

function fromScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const integer = abs / SCALE_FACTOR;
  const fraction = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const body = fraction.length > 0 ? `${integer}.${fraction}` : `${integer}`;
  return negative ? `-${body}` : body;
}

/** 数量 × 单价 = 金额（精确到 6 位小数，去尾零）。入参必须是非负 decimal。 */
export function multiplyDecimal(left: string, right: string): string {
  return fromScaled((toScaled(left) * toScaled(right)) / SCALE_FACTOR);
}

/** 同列合计（费用行可为负）。空数组返回 `0`。 */
export function sumDecimal(values: readonly string[]): string {
  return fromScaled(values.reduce((total, value) => total + toScaled(value), 0n));
}

/** D39：负数费用行必须填备注。返回 true 表示「这笔金额是负数」。 */
export function isNegativeDecimal(value: string): boolean {
  return value.trim().startsWith('-') && !/^-0(\.0+)?$/.test(value.trim());
}

// ============ 展示 ============

/** 无看价权限时服务端金额为 null（D79）；显示为破折号，**不显示 0**。 */
export const MASKED_AMOUNT = '—';

export function formatMoney(value: string | null, currency = '¥'): string {
  if (value === null) return MASKED_AMOUNT;
  const negative = value.trim().startsWith('-');
  const abs = negative ? value.trim().slice(1) : value.trim();
  const [integer = '0', fraction = ''] = abs.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimals = fraction.padEnd(2, '0').slice(0, 2);
  return `${negative ? '-' : ''}${currency}${grouped}.${decimals}`;
}

/** 数量展示：整数不带小数点，带小数保留原样（去尾零）。 */
export function formatQty(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

export const CANCEL_REASON_TEXT: Readonly<Record<string, string>> = {
  already_completed: '单据已完成，不能取消（错账请走冲正 R / S / I）',
  already_cancelled: '单据已取消',
  has_downstream: '存在下游单据，需先取消下游',
};

export function cancelDisabledReason(reason: string | null): string | null {
  if (reason === null) return null;
  return CANCEL_REASON_TEXT[reason] ?? '当前状态不可取消';
}

export const EMPTY_LINES_HINT = '采购单至少 1 行商品明细';
