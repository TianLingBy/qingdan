import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../api/client';
import {
  createProcessingApi,
  isAttributionDoc,
  isFullLoss,
  processingQueryKeys,
  sellableQtyText,
} from './processing-api';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function recorder() {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createProcessingApi(
    new ApiClient({
      baseUrl: '/api/v1',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse({ items: [], nextCursor: null }, 200);
      },
    }),
  );
  return { api, calls };
}

describe('加工单接口封装', () => {
  it('列表带上公司/加工厂/状态/关键字/游标，走 GET /processing-orders', async () => {
    const { api, calls } = recorder();

    await api.list({
      companyId: 'c1',
      processorId: 'p1',
      status: '进行中',
      keyword: '宁波',
      cursor: 'cursor-1',
      limit: 20,
    });

    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.url).toBe(
      '/api/v1/processing-orders?companyId=c1&processorId=p1&status=%E8%BF%9B%E8%A1%8C%E4%B8%AD&keyword=%E5%AE%81%E6%B3%A2&cursor=cursor-1&limit=20',
    );
    // 会话是 HttpOnly Cookie（D59⑦）
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('开单不带单号（D16），材料投入与投入量原样透传', async () => {
    const { api, calls } = recorder();

    await api.create({
      companyId: 'c1',
      processorId: 'p1',
      outputProductId: 'prod-1',
      handlerId: 'e1',
      materialBatchIds: [
        { batchId: 'b1', qty: '300' },
        { batchId: 'b2', qty: '200' },
      ],
      inputQty: '500',
      fees: [{ feeName: '加工费', qty: '1', unitPrice: '1500', amount: '1500' }],
    });

    expect(calls[0]?.url).toBe('/api/v1/processing-orders');
    expect(calls[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.orderNo).toBeUndefined();
    expect(body.inputQty).toBe('500');
    expect(body.materialBatchIds).toEqual([
      { batchId: 'b1', qty: '300' },
      { batchId: 'b2', qty: '200' },
    ]);
    // F3：损耗量只在完成时一次填入，开单不传
    expect(body.lossQty).toBeUndefined();
  });

  it('修改 / 取消都带强 ETag If-Match（D60③），取消没有请求体', async () => {
    const { api, calls } = recorder();

    await api.update('o1', { auxMaterials: '包装膜 20 卷' }, 3);
    await api.cancel('o1', 3);

    expect(calls[0]?.url).toBe('/api/v1/processing-orders/o1');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(headerOf(calls[0]!.init, 'If-Match')).toBe('"3"');

    expect(calls[1]?.url).toBe('/api/v1/processing-orders/o1/cancel');
    expect(calls[1]?.init.method).toBe('POST');
    expect(headerOf(calls[1]!.init, 'If-Match')).toBe('"3"');
    expect(calls[1]?.init.body).toBeUndefined();
  });

  it('修改入参不接收 lossQty（F3：验收时一次填入、事后不改）', async () => {
    const { api, calls } = recorder();
    const patch = { auxMaterials: '胶水 5 桶' } as Record<string, unknown>;
    // 类型上就传不进去；这里确认封装没有偷偷补字段
    await api.update('o1', patch as never, 1);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.lossQty).toBeUndefined();
    expect(body.status).toBeUndefined();
    expect(body.sellableQty).toBeUndefined();
  });

  it('打印走 /processing-orders/{id}/print，返回服务端生成的 HTML', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createProcessingApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), init: init ?? {} });
          return jsonResponse(
            { contentType: 'text/html', content: '<h1>发厂联</h1>', filename: '加工单-B-1.html' },
            200,
          );
        },
      }),
    );

    const doc = await api.print('o1');
    expect(calls[0]?.url).toBe('/api/v1/processing-orders/o1/print');
    expect(doc.contentType).toBe('text/html');
    expect(doc.filename).toContain('加工单');
  });

  it('材料投入选批次走 inventory 只读端点（库存没有 HTTP 写入口）', async () => {
    const { api, calls } = recorder();

    await api.listBatches({ companyId: 'c1' });

    expect(calls[0]?.url).toBe('/api/v1/inventory/batches?companyId=c1&limit=100');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('查询键按筛选条件区分，明细键带 id', () => {
    expect(processingQueryKeys.list({ status: '进行中' })).not.toEqual(
      processingQueryKeys.list({ status: '已取消' }),
    );
    expect(processingQueryKeys.detail('o1')).toEqual(['processing-orders', 'detail', 'o1']);
    // 批次缓存键按公司与关键字区分，换公司不会读错批次
    expect(processingQueryKeys.batches('c1', '')).not.toEqual(
      processingQueryKeys.batches('c2', ''),
    );
  });
});

describe('数量口径（D5 / F3）', () => {
  it('可售量 = 投入量 − 损耗量，定点计算不漂', () => {
    expect(sellableQtyText('500', '12')).toBe('488');
    expect(sellableQtyText('1200', '0')).toBe('1200');
    expect(sellableQtyText('0.3', '0.1')).toBe('0.2');
  });

  it('损耗量还没填时可售量是 null —— 不能拿投入量顶替（那是假装零损耗）', () => {
    expect(sellableQtyText('500', null)).toBeNull();
  });

  it('损耗超过投入时按 0 处理，不出现负可售量', () => {
    expect(sellableQtyText('200', '200')).toBe('0');
    expect(sellableQtyText('200', '260')).toBe('0');
  });

  it('全损耗判定（G2 / D26：需二次确认、不生成产出批次）', () => {
    expect(isFullLoss('200', '200')).toBe(true);
    expect(isFullLoss('200', '260')).toBe(true);
    expect(isFullLoss('200', '199.999999')).toBe(false);
    expect(isFullLoss('200', null)).toBe(false);
  });
});

describe('归属单格式（D18 / D35）', () => {
  it('只收 D16 格式的 E / N 单号', () => {
    expect(isAttributionDoc('E-0001-20261105-0001')).toBe(true);
    expect(isAttributionDoc('N-0001-20261105-0001')).toBe(true);
    expect(isAttributionDoc('A-0001-20261105-0001')).toBe(false);
    expect(isAttributionDoc('E-1-2026-1')).toBe(false);
    expect(isAttributionDoc('')).toBe(false);
  });
});
