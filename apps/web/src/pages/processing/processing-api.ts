/**
 * 加工单 B 接口封装（契约第一批 §3.2 / §5.2 / §9 / §10，5 条端点 + 打印）。
 *
 * 口径（别在这里发明）：
 * - 数量 / 金额一律 **decimal 字符串**（D54 `numeric(18,6)`），定点运算走 `lib/decimal`；
 * - 单号服务端按 D16 生成，前端不传；
 * - **材料投入至少 1 行**，且各行 `qty` 合计 **必须等于** `inputQty`（F2b / D5）——
 *   契约层用 `refine` 卡这一点，所以页面里 `inputQty` 由材料行合计自动派生，不让人手填，
 *   否则一不小心就 422；
 * - **B 单费用行金额必须 ≥ 0**（D39）：加工费 / 运杂费为负无现实意义，前端先挡一道；
 * - 修改 / 取消 / 完成必须带强 ETag `If-Match: "<version>"`（D60③）；
 * - `lossQty` **只在完成时一次填入、事后不改**（F3），开单与修改都不传；
 * - `complete` 端点（D5 锁价 + 产出批次）依赖 inventory 写能力，API 侧**尚未登记**
 *   （`mountRoutes` 未登记的 operationId 仍回 501），页面不画假按钮。
 */

import type {
  InventoryBatch,
  ProcessingOrder,
  ProcessingOrderCreateInput,
  ProcessingOrderDetail,
  ProcessingOrderStatus,
  ProcessingOrderUpdateInput,
  PrintDocument,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';
import { compareDecimal, subtractDecimal } from '../../lib/decimal';
import type { PageResult } from '../masterdata/masterdata-api';

export interface ProcessingOrderListFilters {
  readonly companyId?: string;
  readonly processorId?: string;
  readonly status?: ProcessingOrderStatus;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

function listQuery(
  filters: ProcessingOrderListFilters,
): Record<string, string | number | undefined> {
  return {
    companyId: filters.companyId,
    processorId: filters.processorId,
    status: filters.status,
    keyword: filters.keyword,
    cursor: filters.cursor ?? undefined,
    limit: filters.limit ?? 50,
  };
}

function ifMatch(version: number): Record<string, string> {
  return { 'If-Match': `"${version}"` };
}

export interface BatchListFilters {
  readonly companyId?: string;
  readonly productId?: string;
  readonly keyword?: string;
  readonly limit?: number;
}

export function createProcessingApi(client: ApiClient = apiClient) {
  return {
    list: (filters: ProcessingOrderListFilters = {}) =>
      client.get<PageResult<ProcessingOrder>>('/processing-orders', { query: listQuery(filters) }),
    detail: (id: string) => client.get<ProcessingOrderDetail>(`/processing-orders/${id}`),
    create: (input: ProcessingOrderCreateInput) =>
      client.post<ProcessingOrder>('/processing-orders', input),
    update: (id: string, input: ProcessingOrderUpdateInput, version: number) =>
      client.patch<ProcessingOrder>(`/processing-orders/${id}`, input, {
        headers: ifMatch(version),
      }),
    cancel: (id: string, version: number) =>
      client.post<ProcessingOrder>(`/processing-orders/${id}/cancel`, undefined, {
        headers: ifMatch(version),
      }),
    /** 发厂联（HTML 文本由服务端生成，前端只负责打开 / 落盘）。 */
    print: (id: string) => client.get<PrintDocument>(`/processing-orders/${id}/print`),
    /** 材料投入要选批次：走 inventory 只读端点（D67；库存没有 HTTP 写入口）。 */
    listBatches: (filters: BatchListFilters = {}) =>
      client.get<PageResult<InventoryBatch>>('/inventory/batches', {
        query: {
          companyId: filters.companyId,
          productId: filters.productId,
          keyword: filters.keyword,
          limit: filters.limit ?? 100,
        },
      }),
  };
}

export type ProcessingApi = ReturnType<typeof createProcessingApi>;
export const processingApi = createProcessingApi();

export const processingQueryKeys = {
  list: (filters: {
    companyId?: string;
    processorId?: string;
    status?: ProcessingOrderStatus;
    keyword?: string;
    cursor?: string | null;
  }) => ['processing-orders', 'list', filters] as const,
  detail: (id: string | null) => ['processing-orders', 'detail', id] as const,
  /** 主数据映射：与主数据页共用同一前缀，切换页面不重复拉。 */
  processors: ['masterdata', 'processors', { limit: 200 }] as const,
  products: ['masterdata', 'products', { limit: 200 }] as const,
  batches: (companyId: string, keyword: string) =>
    ['inventory', 'batches', { companyId, keyword }] as const,
};

// ============ 业务口径（页面与测试共用） ============

export const EMPTY_MATERIALS_HINT = '加工单至少 1 行材料投入（F2b；包工包料请走 A 单）';
export const EMPTY_FEES_HINT = '加工单至少 1 行费用明细（加工费 / 运杂费，§3.2）';

/** 归属单只收 D16 格式的 E / N 单号（D18 / D35）。 */
const ATTRIBUTION_PATTERN = /^[EN]-\d{4}-\d{8}-\d{4}$/;

export function isAttributionDoc(value: string): boolean {
  return ATTRIBUTION_PATTERN.test(value.trim());
}

/**
 * 可售量 = 投入量 − 损耗量（D5 / F3）；损耗量为 null 时**可售量也是 null**，
 * 不能拿投入量顶替——那等于假装「零损耗」，会把批次成本算低。
 */
export function sellableQtyText(inputQty: string, lossQty: string | null): string | null {
  if (lossQty === null) return null;
  const sellable = subtractDecimal(inputQty, lossQty);
  return compareDecimal(sellable, '0') <= 0 ? '0' : sellable;
}

/** 全损耗（可售量 = 0）需二次确认（G2 / D26）；这里只做展示判定。 */
export function isFullLoss(inputQty: string, lossQty: string | null): boolean {
  if (lossQty === null) return false;
  return compareDecimal(lossQty, inputQty) >= 0;
}
