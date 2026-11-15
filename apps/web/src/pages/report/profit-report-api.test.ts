import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api/client';
import { profitReportApi, profitReportQueryKeys } from './profit-report-api';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const FILTERS = {
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  companyId: COMPANY_ID,
} as const;

function clientWith(payload: unknown) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    calls,
    client: new ApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchImpl as typeof fetch,
      newRequestId: () => 'req-profit-report-api',
    }),
  };
}

describe('利润报表 API 封装', () => {
  it('汇总查询把 companyIds 发送为数组查询参数', async () => {
    const { calls, client } = clientWith({
      periodStart: FILTERS.periodStart,
      periodEnd: FILTERS.periodEnd,
      grossProfit: null,
      fullLossAmount: null,
      netProfit: null,
      unattributedLoss: null,
      unattributedLossAvailable: false,
      settledOrderCount: 0,
    });
    await profitReportApi.get(FILTERS, client);

    expect(calls[0]?.input).toBe(
      `/api/v1/reports/profit?periodStart=2026-11-01&periodEnd=2026-11-30&companyIds=${COMPANY_ID}`,
    );
  });

  it('损失下钻使用同一组期间与公司筛选', async () => {
    const { calls, client } = clientWith({ items: [] });
    await profitReportApi.losses(FILTERS, client);

    expect(calls[0]?.input).toBe(
      `/api/v1/reports/profit/losses?periodStart=2026-11-01&periodEnd=2026-11-30&companyIds=${COMPANY_ID}`,
    );
  });

  it('汇总与下钻使用不同的 query key，避免缓存串用', () => {
    expect(profitReportQueryKeys.report(FILTERS)).toEqual([
      'report',
      'profit',
      FILTERS,
    ]);
    expect(profitReportQueryKeys.losses(FILTERS)).toEqual([
      'report',
      'profit-losses',
      FILTERS,
    ]);
  });
});
