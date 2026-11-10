import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api/client';
import { compareDecimal } from '../../lib/decimal';
import { inventoryApi, type InventoryBatchFilters } from './inventory-api';

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
      newRequestId: () => 'req-inventory-page',
    }),
  };
}

describe('库存页面 API 封装', () => {
  it('批次列表使用公司、关键字与游标参数', async () => {
    const { calls, client } = clientWith({ items: [], nextCursor: null });
    const filters: InventoryBatchFilters = {
      companyId: '00000000-0000-4000-8000-000000000001',
      keyword: 'PB-0001',
      cursor: 'next',
    };
    await inventoryApi.listBatches(filters, client);

    expect(calls[0]?.input).toBe(
      '/api/v1/inventory/batches?companyId=00000000-0000-4000-8000-000000000001&keyword=PB-0001&cursor=next&limit=50',
    );
    expect(new Headers(calls[0]?.init?.headers).get('X-Client')).toBe('web');
  });

  it('盘点创建按盘盈/盘亏走不同端点', async () => {
    const increase = clientWith({ id: 's1' });
    await inventoryApi.createStocktake(
      'increase',
      {
        companyId: '00000000-0000-4000-8000-000000000001',
        batchId: '00000000-0000-4000-8000-000000000002',
        bookQty: '10',
        actualQty: '11',
        remark: null,
      },
      increase.client,
    );
    expect(increase.calls[0]?.input).toBe('/api/v1/stocktakes/increases');

    const decrease = clientWith({ id: 's2' });
    await inventoryApi.createStocktake(
      'decrease',
      {
        companyId: '00000000-0000-4000-8000-000000000001',
        batchId: '00000000-0000-4000-8000-000000000002',
        bookQty: '10',
        actualQty: '9',
        remark: '损耗',
      },
      decrease.client,
    );
    expect(decrease.calls[0]?.input).toBe('/api/v1/stocktakes/decreases');
  });

  it('盘点审批发送强 If-Match', async () => {
    const { calls, client } = clientWith({ id: 's1', approvable: { allowed: false, reason: null } });
    await inventoryApi.approveStocktake('s1', 7, client);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('If-Match')).toBe('"7"');
  });

  it('decimal 比较不使用浮点数', () => {
    expect(compareDecimal('123456789012.123456', '123456789012.123455')).toBe(1);
    expect(compareDecimal('1.000000', '1')).toBe(0);
    expect(compareDecimal('0.1', '0.2')).toBe(-1);
  });
});
