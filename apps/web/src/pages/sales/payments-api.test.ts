/**
 * 在线收款接口封装的三条端点（#101 / #386）。
 *
 * 断言重点不是「函数被调用了」，而是**发出去的请求长什么样**：
 * 路径、method、body 字段集。`payment.request.create` 的 body 是 `.strict()` 的，
 * 多带一个字段（哪怕是 `amount`）后端就 422，所以这里逐字段核对。
 */

import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../api/client';
import { createPaymentsApi } from './payments-api';

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function recorder(respondWith: unknown = {}) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return new Response(JSON.stringify(respondWith), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const api = createPaymentsApi(new ApiClient({ baseUrl: '/api/v1', fetchImpl }));
  return { api, calls };
}

describe('发起收款（payment.request.create）', () => {
  it('只传 channel，不传金额 —— 金额必须由服务端按应收余额算', async () => {
    const { api, calls } = recorder({
      id: 'p1',
      salesOrderId: 'o1',
      channel: 'wechat',
      amount: '225.00',
      status: 'pending',
      providerOrderNo: 'QD0001202611181234ABCDEF',
      qrContent: 'qingdan-mock://pay/QD0001202611181234ABCDEF',
      payUrl: '/mock-pay/QD0001202611181234ABCDEF',
      expiresAt: '2026-11-18T10:30:00.000Z',
      paidAt: null,
    });

    await api.createRequest('o1', 'wechat');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/v1/sales-orders/o1/payment-requests');
    // 逐字段核对：body 里只能有 channel。带上 amount 会被 `.strict()` 判 422。
    expect(calls[0]!.body).toEqual({ channel: 'wechat' });
    expect(Object.keys(calls[0]!.body as object)).toEqual(['channel']);
  });

  it('支付宝走同一个端点，渠道由 body 决定', async () => {
    const { api, calls } = recorder();
    await api.createRequest('o2', 'alipay');
    expect(calls[0]!.body).toEqual({ channel: 'alipay' });
  });

  it('不需要 If-Match —— 发起收款不改单据本身', async () => {
    const { api, calls } = recorder();
    await api.createRequest('o1', 'wechat');
    // recorder 不记 header，这里用「没有传 headers 参数」来表达：方法签名上就没有 version。
    expect(api.createRequest.length).toBe(2);
    expect(calls[0]!.body).not.toHaveProperty('version');
  });
});

describe('查待支付单（payment.request.read）', () => {
  it('按待支付单 id 查，不是按订单 id', async () => {
    const { api, calls } = recorder();
    await api.read('p-123');
    expect(calls[0]!.url).toBe('/api/v1/payments/p-123');
    expect(calls[0]!.method).toBe('GET');
  });
});

describe('mock 确认（payment.mock.confirm）', () => {
  it('参数是商户订单号 —— 这个端点模拟第三方平台，平台只认 out_trade_no', async () => {
    const { api, calls } = recorder({ received: true, duplicate: false, receiptId: 'r1' });
    await api.mockConfirm('QD0001202611181234ABCDEF');
    expect(calls[0]!.url).toBe('/api/v1/payments/mock/QD0001202611181234ABCDEF/confirm');
    expect(calls[0]!.method).toBe('POST');
  });

  it('商户订单号里有需要转义的字符时编码，不拼出坏路径', async () => {
    const { api, calls } = recorder();
    await api.mockConfirm('QD/0001 2');
    expect(calls[0]!.url).toBe('/api/v1/payments/mock/QD%2F0001%202/confirm');
  });
});
