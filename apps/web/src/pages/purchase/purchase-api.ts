/**
 * 采购单 A 接口封装（契约 §3.1：5 条第一批 + 完成 + D94 发货/撤销/到货三条）。
 *
 * 口径（别在这里发明）：
 * - 金额 / 数量一律 **decimal 字符串**（D54 `numeric(18,6)`），前端不做浮点运算，
 *   合计用 `multiplyDecimal` / `sumDecimal`（BigInt 定点，见下方工具）；
 * - 单号服务端生成（D16），前端不传；
 * - 无 `purchase.view_price` 时服务端把金额回 `null`（D79）——**遮罩是 `null` 触发的，
 *   不是 0**：绝不能把 null 当 0 渲染，那是泄露价格；
 * - 修改 / 取消 / 完成 / 发货 / 撤销发货 / 到货确认必须带强 ETag `If-Match: "<version>"`（D60）；
 * - 完成（D94 起改成 `purchase.approve`）会为每行明细创建库存批次并写库存流水（服务端走
 *   inventory 的 createBatch），再把 A 单置为「已完成」并 +version；不生成应付、不写结算草稿。
 */

import type {
  PurchaseOrder,
  PurchaseOrderCreateInput,
  PurchaseOrderDetail,
  PurchaseOrderShipInput,
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
    complete: (id: string, version: number) =>
      client.post<PurchaseOrder>(`/purchase-orders/${id}/complete`, undefined, {
        headers: ifMatch(version),
      }),
    /**
     * 发货（D94 ①/④）：进行中 → 在途，**按明细行**记去向（回仓库 / 直发加工厂）。
     * 权限 `purchase.ship`（与 update 拆开：能改单不等于能发货）；强 ETag。
     * 行用 `lineNo` 定位——服务端按 `order.lines` 的顺序号（`index + 1`）解释它。
     */
    ship: (id: string, input: PurchaseOrderShipInput, version: number) =>
      client.post<PurchaseOrder>(`/purchase-orders/${id}/ship`, input, {
        headers: ifMatch(version),
      }),
    /**
     * 撤销发货（D94 ⑤）：在途 → 进行中，权限同为 `purchase.ship`，强 ETag。
     *
     * 原因走 `X-Reason` 头（契约路由只声明了 `ai.reasonRequired`，**没有 body schema**，
     * 服务端读的是 `request.auditReason` 而不是 body 里的字段）。所以这里不发 body，
     * 免得下一个人误以为接口收 `{ reason }`。
     */
    revokeShip: (id: string, version: number, reason: string) =>
      client.post<PurchaseOrder>(`/purchase-orders/${id}/ship/revoke`, undefined, {
        headers: ifMatch(version),
        reason,
      }),
    /**
     * 到货确认（D94 ④）：在途 → 已完成，按行分流建批次（直发的挂加工厂）。
     * 权限是 `purchase.approve`——**到货确认是审批动作，不是改单**；强 ETag。
     */
    receive: (id: string, version: number) =>
      client.post<PurchaseOrder>(`/purchase-orders/${id}/receive`, undefined, {
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
  /** 发货弹层的「直发加工厂」下拉（D94 ①）。 */
  processors: ['masterdata', 'processors', { limit: 200 }] as const,
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
