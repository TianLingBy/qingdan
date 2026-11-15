import type { ProfitLossList, ProfitReport } from '@qingdan/contracts';
import { apiClient, type ApiClient } from '../../api/client';

export interface ProfitReportFilters {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly companyId?: string;
}

export const profitReportQueryKeys = {
  report: (filters: ProfitReportFilters) => ['report', 'profit', filters] as const,
  losses: (filters: ProfitReportFilters) => ['report', 'profit-losses', filters] as const,
};

function query(filters: ProfitReportFilters) {
  return {
    periodStart: filters.periodStart,
    periodEnd: filters.periodEnd,
    companyIds: filters.companyId ? [filters.companyId] : undefined,
  };
}

export const profitReportApi = {
  get(filters: ProfitReportFilters, client: ApiClient = apiClient): Promise<ProfitReport> {
    return client.get<ProfitReport>('/reports/profit', { query: query(filters) });
  },

  losses(filters: ProfitReportFilters, client: ApiClient = apiClient): Promise<ProfitLossList> {
    return client.get<ProfitLossList>('/reports/profit/losses', { query: query(filters) });
  },
};
