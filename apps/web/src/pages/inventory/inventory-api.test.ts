import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api/client';
import { compareDecimal } from '../../lib/decimal';
import {
  exportFilename,
  inventoryApi,
  type InventoryBatchFilters,
} from './inventory-api';

function clientWith(payload: unknown) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
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

  it('批次页码模式只发送 page / pageSize / sort / order，不与 cursor 混用', async () => {
    const { calls, client } = clientWith({
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
      nextCursor: null,
    });
    await inventoryApi.listBatches(
      {
        companyId: '00000000-0000-4000-8000-000000000001',
        keyword: 'PB-0001',
        page: 2,
        pageSize: 20,
        sort: 'availableQty',
        order: 'desc',
      },
      client,
    );

    expect(calls[0]?.input).toBe(
      '/api/v1/inventory/batches?companyId=00000000-0000-4000-8000-000000000001&keyword=PB-0001&page=2&pageSize=20&sort=availableQty&order=desc',
    );
    expect(calls[0]?.input).not.toContain('cursor=');
    expect(calls[0]?.input).not.toContain('limit=');
  });

  it('低库存预警按公司读取真接口', async () => {
    const { calls, client } = clientWith({ items: [] });
    await inventoryApi.listAlerts(
      '00000000-0000-4000-8000-000000000001',
      client,
    );

    expect(calls[0]?.input).toBe(
      '/api/v1/inventory/alerts?companyId=00000000-0000-4000-8000-000000000001',
    );
  });

  it('库存导出按当前筛选拉 CSV，并读取服务端文件名', async () => {
    const calls: { input: string; init?: RequestInit }[] = [];
    const client = new ApiClient({
      baseUrl: '/api/v1',
      fetchImpl: async (input, init) => {
        calls.push({ input: String(input), init });
        return new Response('批次号,可用\nP-1,10', {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': "attachment; filename*=UTF-8''%E5%BA%93%E5%AD%98.csv",
          },
        });
      },
    });

    const file = await inventoryApi.exportBatches(
      { keyword: 'PB-0001' },
      client,
    );

    expect(calls[0]?.input).toBe(
      '/api/v1/inventory/batches/export?keyword=PB-0001',
    );
    expect(new Headers(calls[0]?.init?.headers).get('accept')).toBe('*/*');
    expect(file.filename).toBe('库存.csv');
    expect(await file.blob.text()).toContain('P-1,10');
  });

  it('Content-Disposition 的 UTF-8 与普通文件名都能解析', () => {
    expect(
      exportFilename(
        "attachment; filename*=UTF-8''%E5%BA%93%E5%AD%98%E6%89%B9%E6%AC%A1.csv",
      ),
    ).toBe('库存批次.csv');
    expect(exportFilename('attachment; filename="batch.csv"')).toBe(
      'batch.csv',
    );
    expect(exportFilename(null)).toBe('库存批次.csv');
  });

  it('盘点审批发送强 If-Match', async () => {
    const { calls, client } = clientWith({
      id: 's1',
      approvable: { allowed: false, reason: null },
    });
    await inventoryApi.approveStocktake('s1', 7, client);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('If-Match')).toBe('"7"');
  });

  it('decimal 比较不使用浮点数', () => {
    expect(compareDecimal('123456789012.123456', '123456789012.123455')).toBe(
      1,
    );
    expect(compareDecimal('1.000000', '1')).toBe(0);
    expect(compareDecimal('0.1', '0.2')).toBe(-1);
  });
});
