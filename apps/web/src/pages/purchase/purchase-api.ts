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


// ============ decimal / 展示 / 取消口径 ============
// 实现搬到了 `src/lib/decimal.ts`（B 加工单也要算钱，不复制第二份）；
// 这里原样 re-export，采购单页与其测试的 import 路径保持不变。

export {
  CANCEL_REASON_TEXT,
  MASKED_AMOUNT,
  cancelDisabledReason,
  formatMoney,
  formatQty,
  isNegativeDecimal,
  isPositiveDecimal,
  isPositiveNonZeroDecimal,
  isSignedDecimal,
  multiplyDecimal,
  sumDecimal,
} from '../../lib/decimal';

export const EMPTY_LINES_HINT = '采购单至少 1 行商品明细';
