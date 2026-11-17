import type {
  InventoryBatch,
  InventoryBatchDetail,
  InventoryFlow,
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

export interface InventoryBatchFilters {
  readonly companyId?: string;
  readonly productId?: string;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
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

function queryOf(filters: Record<string, QueryValue>): Record<string, QueryValue> {
  return filters;
}

export const inventoryQueryKeys = {
  batches: (filters: InventoryBatchFilters) => ['inventory', 'batches', filters] as const,
  batch: (id: string | null) => ['inventory', 'batch', id] as const,
  flows: (filters: InventoryFlowFilters) => ['inventory', 'flows', filters] as const,
  stocktakes: (filters: StocktakeFilters) => ['inventory', 'stocktakes', filters] as const,
  stocktake: (id: string | null) => ['inventory', 'stocktake', id] as const,
};

export const inventoryApi = {
  async listBatches(
    filters: InventoryBatchFilters,
    client: ApiClient = apiClient,
  ): Promise<CursorPage<InventoryBatch>> {
    return client.get<CursorPage<InventoryBatch>>('/inventory/batches', {
      query: queryOf({
        companyId: filters.companyId,
        productId: filters.productId,
        keyword: filters.keyword,
        cursor: filters.cursor ?? undefined,
        limit: filters.limit ?? DEFAULT_LIMIT,
      }),
    });
  },

  async getBatch(id: string, client: ApiClient = apiClient): Promise<InventoryBatchDetail> {
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
      page.items.find((batch) => batch.batchNo.toLocaleUpperCase() === normalized) ??
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

  async getStocktake(id: string, client: ApiClient = apiClient): Promise<StocktakeDetail> {
    return client.get<StocktakeDetail>(`/stocktakes/${id}`);
  },

  async createStocktake(
    direction: StocktakeDirection,
    input: StocktakeCreateInput,
    client: ApiClient = apiClient,
  ): Promise<Stocktake> {
    const path = direction === 'increase' ? '/stocktakes/increases' : '/stocktakes/decreases';
    return client.post<Stocktake>(path, input);
  },

  async approveStocktake(
    id: string,
    version: number,
    client: ApiClient = apiClient,
  ): Promise<StocktakeDetail> {
    return client.post<StocktakeDetail>(`/stocktakes/${id}/approve`, undefined, {
      headers: { 'If-Match': `"${version}"` },
    });
  },
};
