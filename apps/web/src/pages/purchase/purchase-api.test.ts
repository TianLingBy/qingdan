import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../api/client';
import {
  MASKED_AMOUNT,
  cancelDisabledReason,
  createPurchaseApi,
  formatMoney,
  formatQty,
  isNegativeDecimal,
  isPositiveDecimal,
  multiplyDecimal,
  purchaseQueryKeys,
  sumDecimal,
} from './purchase-api';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe('采购单接口封装', () => {
  it('列表带上公司/供应商/状态/关键字/游标，走 GET /purchase-orders', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createPurchaseApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), init: init ?? {} });
          return jsonResponse({ items: [], nextCursor: null }, 200);
        },
      }),
    );

    await api.list({
      companyId: 'c1',
      supplierId: 's1',
      status: '进行中',
      keyword: '宁波',
      cursor: 'cursor-1',
      limit: 20,
    });

    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.url).toBe(
      '/api/v1/purchase-orders?companyId=c1&supplierId=s1&status=%E8%BF%9B%E8%A1%8C%E4%B8%AD&keyword=%E5%AE%81%E6%B3%A2&cursor=cursor-1&limit=20',
    );
    // 会话是 HttpOnly Cookie（D59⑦）
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('创建不带单号（服务端生成 D16），PUT 语义用 POST', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createPurchaseApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), init: init ?? {} });
          return jsonResponse({ id: 'o1' }, 201);
        },
      }),
    );

    await api.create({
      companyId: 'c1',
      supplierId: 's1',
      handlerId: 'e1',
      lines: [{ productId: 'p1', qty: '500', unitPrice: '8.6', amount: '4300' }],
    });

    expect(calls[0]?.url).toBe('/api/v1/purchase-orders');
    expect(calls[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.orderNo).toBeUndefined();
    expect(body.lines).toEqual([{ productId: 'p1', qty: '500', unitPrice: '8.6', amount: '4300' }]);
  });

  it('修改 / 取消都带强 ETag If-Match（D60），版本不一致由服务端 409', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createPurchaseApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), init: init ?? {} });
          return jsonResponse({ id: 'o1' }, 200);
        },
      }),
    );

    await api.update('o1', { supplierId: 's2' }, 7);
    await api.cancel('o1', 7);

    expect(calls[0]?.url).toBe('/api/v1/purchase-orders/o1');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(headerOf(calls[0]!.init, 'If-Match')).toBe('"7"');

    expect(calls[1]?.url).toBe('/api/v1/purchase-orders/o1/cancel');
    expect(calls[1]?.init.method).toBe('POST');
    expect(headerOf(calls[1]!.init, 'If-Match')).toBe('"7"');
    // 取消没有请求体：不能给服务端塞一个空对象
    expect(calls[1]?.init.body).toBeUndefined();
  });

  it('查询键按筛选条件区分，避免不同筛选共用缓存', () => {
    expect(purchaseQueryKeys.list({ status: '进行中' })).not.toEqual(
      purchaseQueryKeys.list({ status: '已取消' }),
    );
    expect(purchaseQueryKeys.detail('o1')).toEqual(['purchase-orders', 'detail', 'o1']);
  });
});

describe('decimal 定点运算（D54 numeric(18,6)）', () => {
  it('数量 × 单价 不产生浮点误差', () => {
    expect(multiplyDecimal('2', '12.5')).toBe('25');
    expect(multiplyDecimal('3', '0.1')).toBe('0.3');
    expect(multiplyDecimal('500', '8.6')).toBe('4300');
    expect(multiplyDecimal('1.5', '2.25')).toBe('3.375');
  });

  it('合计支持负数费用行（D39）', () => {
    expect(sumDecimal(['4300', '120', '-200'])).toBe('4220');
    expect(sumDecimal(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimal([])).toBe('0');
    // 负号必须在拼小数位之前摘掉，否则 -1.5 会被算成 -0.5
    expect(sumDecimal(['-1.5', '0.5'])).toBe('-1');
  });

  it('合法性判定与前后端口径一致', () => {
    expect(isPositiveDecimal('12.5')).toBe(true);
    expect(isPositiveDecimal('12.1234567')).toBe(false);
    expect(isPositiveDecimal('-1')).toBe(false);
    expect(isPositiveDecimal('')).toBe(false);

    expect(isNegativeDecimal('-3')).toBe(true);
    expect(isNegativeDecimal('-0.00')).toBe(false);
    expect(isNegativeDecimal('3')).toBe(false);
  });
});

describe('金额展示（D79 遮罩）', () => {
  it('null 显示破折号，绝不用 0 顶替', () => {
    expect(formatMoney(null)).toBe(MASKED_AMOUNT);
    expect(formatMoney(null)).not.toContain('0');
  });

  it('保留两位小数与千分位，负数符号在币种前', () => {
    expect(formatMoney('4300')).toBe('¥4,300.00');
    expect(formatMoney('1234.5')).toBe('¥1,234.50');
    expect(formatMoney('-100')).toBe('-¥100.00');
    expect(formatMoney('0')).toBe('¥0.00');
  });

  it('数量去尾零，整数不显示小数点', () => {
    expect(formatQty('500.000000')).toBe('500');
    expect(formatQty('1.500000')).toBe('1.5');
  });

  it('不可取消的原因是给人看的话，不是错误码', () => {
    expect(cancelDisabledReason('already_completed')).toContain('已完成');
    expect(cancelDisabledReason('has_downstream')).toContain('下游');
    expect(cancelDisabledReason(null)).toBeNull();
    expect(cancelDisabledReason('whatever')).toContain('不可取消');
  });
});
