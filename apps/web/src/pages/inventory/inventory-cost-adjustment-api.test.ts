import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api/client';
import { costAdjustmentApi } from './inventory-cost-adjustment-api';

const BATCH_ID = '00000000-0000-4000-8000-000000000001';
const ADJUSTMENT_ID = '00000000-0000-4000-8000-000000000002';

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
      newRequestId: () => 'req-cost-adjustment-api',
    }),
  };
}

describe('库存成本更正 API 封装', () => {
  it('历史列表使用批次路径、游标与条数参数', async () => {
    const { calls, client } = clientWith({ items: [], nextCursor: null });
    await costAdjustmentApi.list(BATCH_ID, { cursor: 'next', limit: 20 }, client);

    expect(calls[0]?.input).toBe(
      `/api/v1/inventory/batches/${BATCH_ID}/cost-adjustments?cursor=next&limit=20`,
    );
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('创建只发送更正后成本与原因，档位和状态留给服务端判定', async () => {
    const { calls, client } = clientWith({ id: ADJUSTMENT_ID });
    await costAdjustmentApi.create(
      BATCH_ID,
      { afterUnitCost: '21.5', reason: '补录运费' },
      client,
    );

    expect(calls[0]?.input).toBe(
      `/api/v1/inventory/batches/${BATCH_ID}/cost-adjustments`,
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      afterUnitCost: '21.5',
      reason: '补录运费',
    });
  });

  it('审批与驳回都发送强 If-Match；驳回同时发送必填原因', async () => {
    const approve = clientWith({ id: ADJUSTMENT_ID });
    await costAdjustmentApi.approve(ADJUSTMENT_ID, 7, approve.client);
    expect(approve.calls[0]?.input).toBe(
      `/api/v1/inventory/cost-adjustments/${ADJUSTMENT_ID}/approve`,
    );
    expect(new Headers(approve.calls[0]?.init?.headers).get('If-Match')).toBe('"7"');

    const reject = clientWith({ id: ADJUSTMENT_ID });
    await costAdjustmentApi.reject(
      ADJUSTMENT_ID,
      8,
      { reason: '依据不足' },
      reject.client,
    );
    expect(reject.calls[0]?.input).toBe(
      `/api/v1/inventory/cost-adjustments/${ADJUSTMENT_ID}/reject`,
    );
    expect(new Headers(reject.calls[0]?.init?.headers).get('If-Match')).toBe('"8"');
    expect(JSON.parse(String(reject.calls[0]?.init?.body))).toEqual({ reason: '依据不足' });
  });

  it('query key 同时包含批次、游标和条数，换批次不会串缓存', async () => {
    const { costAdjustmentQueryKeys } = await import('./inventory-cost-adjustment-api');
    expect(costAdjustmentQueryKeys.list(BATCH_ID, { cursor: null, limit: 50 })).toEqual([
      'inventory',
      'cost-adjustments',
      BATCH_ID,
      { cursor: null, limit: 50 },
    ]);
  });
});
