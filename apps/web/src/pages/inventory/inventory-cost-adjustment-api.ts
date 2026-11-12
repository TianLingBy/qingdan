import type {
  CostAdjustmentCreateInput,
  CostAdjustmentRejectInput,
  CostAdjustmentStatus,
  CostAdjustmentTier,
  InventoryCostAdjustment,
} from '@qingdan/contracts';
import { apiClient, type ApiClient } from '../../api/client';

export interface CostAdjustmentFilters {
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface CostAdjustmentPage {
  readonly items: readonly InventoryCostAdjustment[];
  readonly nextCursor: string | null;
}

export const COST_ADJUSTMENT_TIER_LABEL: Readonly<Record<CostAdjustmentTier, string>> = {
  T1: 'T1 直接生效',
  T2: 'T2 待审批',
  T3: 'T3 已结算锁定',
};

export const COST_ADJUSTMENT_STATUS_LABEL: Readonly<Record<CostAdjustmentStatus, string>> = {
  pending_approval: '待审批',
  applied: '已生效',
  rejected: '已驳回',
};

export const costAdjustmentQueryKeys = {
  list: (batchId: string, filters: CostAdjustmentFilters) =>
    ['inventory', 'cost-adjustments', batchId, filters] as const,
};

function ifMatch(version: number): Record<string, string> {
  return { 'If-Match': `"${version}"` };
}

export const costAdjustmentApi = {
  list(
    batchId: string,
    filters: CostAdjustmentFilters = {},
    client: ApiClient = apiClient,
  ): Promise<CostAdjustmentPage> {
    return client.get<CostAdjustmentPage>(
      `/inventory/batches/${batchId}/cost-adjustments`,
      {
        query: {
          cursor: filters.cursor ?? undefined,
          limit: filters.limit ?? 50,
        },
      },
    );
  },

  create(
    batchId: string,
    input: CostAdjustmentCreateInput,
    client: ApiClient = apiClient,
  ): Promise<InventoryCostAdjustment> {
    return client.post<InventoryCostAdjustment>(
      `/inventory/batches/${batchId}/cost-adjustments`,
      input,
    );
  },

  approve(
    id: string,
    version: number,
    client: ApiClient = apiClient,
  ): Promise<InventoryCostAdjustment> {
    return client.post<InventoryCostAdjustment>(
      `/inventory/cost-adjustments/${id}/approve`,
      undefined,
      { headers: ifMatch(version) },
    );
  },

  reject(
    id: string,
    version: number,
    input: CostAdjustmentRejectInput,
    client: ApiClient = apiClient,
  ): Promise<InventoryCostAdjustment> {
    return client.post<InventoryCostAdjustment>(
      `/inventory/cost-adjustments/${id}/reject`,
      input,
      { headers: ifMatch(version) },
    );
  },
};
