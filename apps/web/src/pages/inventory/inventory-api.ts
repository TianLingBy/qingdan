import type {
  InventoryBatch,
  InventoryBatchDetail,
  InventoryFlow,
  InventoryAlertListResponse,
  Stocktake,
  StocktakeCreateInput,
  StocktakeDetail,
  StocktakeStatus,
} from '@qingdan/contracts';
import { apiClient, type ApiClient, type QueryValue } from '../../api/client';

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface PagedInventoryBatches extends CursorPage<InventoryBatch> {
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number | null;
}

export type InventoryBatchSort = 'batchNo' | 'availableQty' | 'createdAt';

export interface InventoryBatchFilters {
  readonly companyId?: string;
  readonly productId?: string;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
  /** 页码模式（D95）；与 cursor/limit 不要同时使用。 */
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: InventoryBatchSort;
  readonly order?: 'asc' | 'desc';
}

export interface InventoryBatchExport {
  readonly blob: Blob;
  readonly filename: string;
}

export interface InventoryFlowFilters {
  readonly companyId?: string;
  readonly batchId?: string;
  readonly sourceDocType?: string;
  readonly sourceDocId?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface StocktakeFilters {
  readonly companyId?: string;
  readonly status?: StocktakeStatus;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export type StocktakeDirection = 'increase' | 'decrease';

const DEFAULT_LIMIT = 50;
const DEFAULT_EXPORT_FILENAME = '库存批次.csv';

/**
 * 从 `Content-Disposition` 提取下载名。
 *
 * 服务端同时兼容 `filename*=UTF-8''...` 与普通 `filename="..."`；浏览器通过 fetch
 * 拿到的响应头可以被同源代码读取，所以这里优先取 UTF-8 形式，避免中文名被解码坏。
 */
export function exportFilename(
  disposition: string | null,
  fallback = DEFAULT_EXPORT_FILENAME,
): string {
  if (!disposition) return fallback;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ''));
    } catch {
      // 响应头损坏时退回普通 filename，不让一次下载因为文件名解析失败。
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(disposition);
  return (plain?.[1] ?? plain?.[2] ?? fallback).trim();
}

function queryOf(
  filters: Record<string, QueryValue>,
): Record<string, QueryValue> {
  return filters;
}

export const inventoryQueryKeys = {
  batches: (filters: InventoryBatchFilters) =>
    ['inventory', 'batches', filters] as const,
  alerts: (companyId: string) => ['inventory', 'alerts', companyId] as const,
  batch: (id: string | null) => ['inventory', 'batch', id] as const,
  flows: (filters: InventoryFlowFilters) =>
    ['inventory', 'flows', filters] as const,
  stocktakes: (filters: StocktakeFilters) =>
    ['inventory', 'stocktakes', filters] as const,
  stocktake: (id: string | null) => ['inventory', 'stocktake', id] as const,
};

export const inventoryApi = {
  async listBatches(
    filters: InventoryBatchFilters,
    client: ApiClient = apiClient,
  ): Promise<PagedInventoryBatches> {
    const pageMode =
      filters.page !== undefined || filters.pageSize !== undefined;
    return client.get<PagedInventoryBatches>('/inventory/batches', {
      query: queryOf({
        companyId: filters.companyId,
        productId: filters.productId,
        keyword: filters.keyword,
        ...(pageMode
          ? {
              page: filters.page ?? 1,
              pageSize: filters.pageSize ?? 20,
              sort: filters.sort,
              order: filters.order,
            }
          : {
              cursor: filters.cursor ?? undefined,
              limit: filters.limit ?? DEFAULT_LIMIT,
            }),
      }),
    });
  },

  async listAlerts(
    companyId: string,
    client: ApiClient = apiClient,
  ): Promise<InventoryAlertListResponse> {
    return client.get<InventoryAlertListResponse>('/inventory/alerts', {
      query: { companyId },
    });
  },

  async exportBatches(
    filters: Pick<InventoryBatchFilters, 'companyId' | 'productId' | 'keyword'>,
    client: ApiClient = apiClient,
  ): Promise<InventoryBatchExport> {
    let filename = DEFAULT_EXPORT_FILENAME;
    const blob = await client.get<Blob>('/inventory/batches/export', {
      query: {
        companyId: filters.companyId,
        productId: filters.productId,
        keyword: filters.keyword,
      },
      responseType: 'blob',
      responseMeta: ({ headers }) => {
        filename = exportFilename(headers.get('content-disposition'));
      },
    });
    return { blob, filename };
  },

  async getBatch(
    id: string,
    client: ApiClient = apiClient,
  ): Promise<InventoryBatchDetail> {
    return client.get<InventoryBatchDetail>(`/inventory/batches/${id}`);
  },

  async listFlows(
    filters: InventoryFlowFilters,
    client: ApiClient = apiClient,
  ): Promise<CursorPage<InventoryFlow>> {
    return client.get<CursorPage<InventoryFlow>>('/inventory/flows', {
      query: queryOf({
        companyId: filters.companyId,
        batchId: filters.batchId,
        sourceDocType: filters.sourceDocType,
        sourceDocId: filters.sourceDocId,
        cursor: filters.cursor ?? undefined,
        limit: filters.limit ?? DEFAULT_LIMIT,
      }),
    });
  },

  async resolveBatchByNumber(
    batchNo: string,
    companyId?: string,
    client: ApiClient = apiClient,
  ): Promise<InventoryBatch | null> {
    const trimmed = batchNo.trim();
    if (!trimmed) return null;
    const page = await this.listBatches(
      { companyId, keyword: trimmed, limit: 100 },
      client,
    );
    const normalized = trimmed.toLocaleUpperCase();
    return (
      page.items.find(
        (batch) => batch.batchNo.toLocaleUpperCase() === normalized,
      ) ??
      page.items[0] ??
      null
    );
  },

  async listStocktakes(
    filters: StocktakeFilters,
    client: ApiClient = apiClient,
  ): Promise<CursorPage<Stocktake>> {
    return client.get<CursorPage<Stocktake>>('/stocktakes', {
      query: queryOf({
        companyId: filters.companyId,
        status: filters.status,
        keyword: filters.keyword,
        cursor: filters.cursor ?? undefined,
        limit: filters.limit ?? DEFAULT_LIMIT,
      }),
    });
  },

  async getStocktake(
    id: string,
    client: ApiClient = apiClient,
  ): Promise<StocktakeDetail> {
    return client.get<StocktakeDetail>(`/stocktakes/${id}`);
  },

  async createStocktake(
    direction: StocktakeDirection,
    input: StocktakeCreateInput,
    client: ApiClient = apiClient,
  ): Promise<Stocktake> {
    const path =
      direction === 'increase'
        ? '/stocktakes/increases'
        : '/stocktakes/decreases';
    return client.post<Stocktake>(path, input);
  },

  async approveStocktake(
    id: string,
    version: number,
    client: ApiClient = apiClient,
  ): Promise<StocktakeDetail> {
    return client.post<StocktakeDetail>(
      `/stocktakes/${id}/approve`,
      undefined,
      {
        headers: { 'If-Match': `"${version}"` },
      },
    );
  },
};
