import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../api/client';
import {
  createSalesApi,
  lineAmountOf,
  orderTotalOf,
  receiptAmountText,
  salesQueryKeys,
  signedReceiptAmount,
  sumNullable,
  validateDraft,
} from './sales-api';

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
  const api = createSalesApi(
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

const LINE = {
  productId: 'p1',
  batchIds: ['b1', 'b2'],
  qty: '10',
  unitPrice: '12.5',
  amount: '125',
};

describe('销售单接口封装', () => {
  it('列表带上公司/客户/状态/关键字/游标，走 GET /sales-orders', async () => {
    const { api, calls } = recorder();

    await api.list({
      companyId: 'c1',
      customerId: 'cu1',
      status: '进行中',
      keyword: '王记',
      cursor: 'cursor-1',
      limit: 20,
    });

    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.url).toBe(
      '/api/v1/sales-orders?companyId=c1&customerId=cu1&status=%E8%BF%9B%E8%A1%8C%E4%B8%AD&keyword=%E7%8E%8B%E8%AE%B0&cursor=cursor-1&limit=20',
    );
    // 会话是 HttpOnly Cookie（D59⑦）
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('开单不带单号（D16），商品行引用批次原样透传（D22）', async () => {
    const { api, calls } = recorder();

    await api.create({
      companyId: 'c1',
      customerId: 'cu1',
      handlerId: 'e1',
      lines: [LINE],
      fees: [{ feeName: '运费', qty: '1', unitPrice: '100', amount: '100', remark: null }],
    });

    expect(calls[0]?.url).toBe('/api/v1/sales-orders');
    expect(calls[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.orderNo).toBeUndefined();
    expect(body.lines).toEqual([LINE]);
  });

  it('修改 / 完成 / 取消都带强 ETag If-Match（D60③），完成与取消没有请求体', async () => {
    const { api, calls } = recorder();

    await api.update('o1', { customerId: 'cu2' }, 3);
    await api.complete('o1', 3);
    await api.cancel('o1', 3);

    expect(calls[0]?.url).toBe('/api/v1/sales-orders/o1');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(headerOf(calls[0]!.init, 'If-Match')).toBe('"3"');

    expect(calls[1]?.url).toBe('/api/v1/sales-orders/o1/complete');
    expect(calls[1]?.init.method).toBe('POST');
    expect(headerOf(calls[1]!.init, 'If-Match')).toBe('"3"');
    expect(calls[1]?.init.body).toBeUndefined();

    expect(calls[2]?.url).toBe('/api/v1/sales-orders/o1/cancel');
    expect(calls[2]?.init.method).toBe('POST');
    expect(headerOf(calls[2]!.init, 'If-Match')).toBe('"3"');
  });

  it('追加收款走 /sales-orders/{id}/receipts，退款是负数行（D34 / D40）', async () => {
    const { api, calls } = recorder();

    await api.createReceipt('o1', {
      direction: '退款',
      amount: '-1200',
      method: '原路退款',
      occurredAt: '2026-11-08T10:00:00.000Z',
      remark: '客户退货',
    });

    expect(calls[0]?.url).toBe('/api/v1/sales-orders/o1/receipts');
    expect(calls[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.direction).toBe('退款');
    expect(body.amount).toBe('-1200');
  });

  it('打印客户联与导出 CSV 走 prints 契约的两条路径', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createSalesApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), init: init ?? {} });
          return jsonResponse(
            { contentType: 'text/html', content: '<h1>客户联</h1>', filename: '销售单-E-1.html' },
            200,
          );
        },
      }),
    );

    await api.print('o1');
    await api.exportCsv({ companyId: 'c1', status: '已完成' });

    expect(calls[0]?.url).toBe('/api/v1/sales-orders/o1/print');
    expect(calls[1]?.url).toBe(
      '/api/v1/sales-orders/export?companyId=c1&status=%E5%B7%B2%E5%AE%8C%E6%88%90&limit=50',
    );
  });

  it('客户 / 批次走只读端点：客户按公司、批次按公司与商品（D15 / D22）', async () => {
    const { api, calls } = recorder();

    await api.listCustomers({ companyId: 'c1', limit: 200 });
    await api.listBatches({ companyId: 'c1', productId: 'p1', limit: 200 });

    expect(calls[0]?.url).toBe('/api/v1/customers?companyId=c1&limit=200');
    expect(calls[1]?.url).toBe(
      '/api/v1/inventory/batches?companyId=c1&productId=p1&limit=200',
    );
  });

  it('查询键按筛选条件区分，明细键带 id', () => {
    expect(salesQueryKeys.list({ status: '进行中' })).not.toEqual(
      salesQueryKeys.list({ status: '已取消' }),
    );
    expect(salesQueryKeys.detail('o1')).toEqual(['sales-orders', 'detail', 'o1']);
    // 客户 / 批次缓存键按公司区分，换公司不会读错数据
    expect(salesQueryKeys.customers('c1', '')).not.toEqual(salesQueryKeys.customers('c2', ''));
    expect(salesQueryKeys.batches('c1', 'p1')).not.toEqual(salesQueryKeys.batches('c1', 'p2'));
  });
});

describe('金额与合计口径（D54 / D79）', () => {
  it('行金额 = 数量 × 单价，定点乘法不漂', () => {
    expect(lineAmountOf({ productId: 'p', batchIds: ['b'], qty: '0.1', unitPrice: '3' })).toBe('0.3');
    expect(lineAmountOf({ productId: 'p', batchIds: ['b'], qty: '10', unitPrice: '12.5' })).toBe('125');
  });

  it('单据合计 = 商品行 + 费用行；非法输入按 0 计，不产生 NaN', () => {
    const total = orderTotalOf(
      [{ productId: 'p', batchIds: ['b'], qty: '10', unitPrice: '12.5' }],
      [{ feeName: '运费', qty: '1', unitPrice: '100', amount: '', remark: '' }],
    );
    expect(total).toBe('225');
    expect(
      orderTotalOf([{ productId: '', batchIds: [], qty: '', unitPrice: '' }], []),
    ).toBe('0');
  });

  it('费用金额手填优先于自动计算（负数也如实返回，由校验去拦 D39）', () => {
    const total = orderTotalOf([], [{ feeName: '折扣', qty: '1', unitPrice: '100', amount: '-50', remark: '' }]);
    expect(total).toBe('-50');
  });

  it('无看价时金额全为 null，合计是 null 而不是 0（D79 不用 0 顶替）', () => {
    expect(sumNullable([null, null])).toBeNull();
    expect(sumNullable(['100', null])).toBe('100');
    expect(sumNullable(['0.1', '0.2'])).toBe('0.3');
  });
});

describe('收款符号（§6 / D34）', () => {
  it('收款填正数、退款自动转负数行', () => {
    expect(signedReceiptAmount('收款', '1200')).toBe('1200');
    expect(signedReceiptAmount('退款', '1200')).toBe('-1200');
    // 用户误填负号也不叠加成 --1200
    expect(signedReceiptAmount('退款', '-1200')).toBe('-1200');
    expect(signedReceiptAmount('收款', '-1200')).toBe('1200');
  });

  it('展示时退款带负号，历史数据方向与符号不一致也按方向补齐', () => {
    expect(receiptAmountText('退款', '-1200')).toBe('-1200');
    expect(receiptAmountText('退款', '1200')).toBe('-1200');
    expect(receiptAmountText('收款', '1200')).toBe('1200');
    expect(receiptAmountText('收款', null)).toBe('—');
  });
});

describe('开单前校验', () => {
  const validLine = { productId: 'p1', batchIds: ['b1'], qty: '10', unitPrice: '12.5' };
  const validFee = { feeName: '运费', qty: '1', unitPrice: '100', amount: '100', remark: '' };

  it('客户与至少 1 行商品是硬门槛（§3.3）', () => {
    expect(validateDraft('', [], [])).toEqual(
      expect.arrayContaining(['请选择客户', '销售单至少 1 行商品明细（§3.3）']),
    );
  });

  it('商品行必须选商品、引用至少 1 个批次（D22）', () => {
    expect(validateDraft('cu1', [{ ...validLine, productId: '', batchIds: [] }], [])).toEqual(
      expect.arrayContaining([
        '第 1 行商品：请选择商品',
        '第 1 行商品：至少引用 1 个批次（D22 只能引用本公司批次）',
      ]),
    );
  });

  it('数量必须大于 0，单价必须是非负数字', () => {
    expect(validateDraft('cu1', [{ ...validLine, qty: '0' }], [])).toContain(
      '第 1 行商品：数量必须大于 0',
    );
    expect(validateDraft('cu1', [{ ...validLine, qty: '-1' }], [])).toContain(
      '第 1 行商品：数量必须是非负数字（最多 6 位小数）',
    );
    expect(validateDraft('cu1', [{ ...validLine, unitPrice: 'abc' }], [])).toContain(
      '第 1 行商品：单价必须是非负数字（最多 6 位小数）',
    );
  });

  it('D39：E 单费用行金额必须 ≥ 0', () => {
    expect(
      validateDraft('cu1', [validLine], [{ ...validFee, amount: '-50' }]),
    ).toContain('第 1 行费用：金额必须是非负数字（D39：E 单费用行不可为负）');
  });

  it('合法单据零报错（费用选填，一条都不填也能开）', () => {
    expect(validateDraft('cu1', [validLine], [])).toHaveLength(0);
    expect(validateDraft('cu1', [validLine], [validFee])).toHaveLength(0);
  });
});
