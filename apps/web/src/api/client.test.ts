import { describe, expect, it } from 'vitest';
import {
  ApiClient,
  ApiError,
  DEFAULT_API_BASE_URL,
  buildRequestUrl,
  joinUrl,
  parseApiErrorBody,
} from './client';

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('URL 拼接', () => {
  it('默认基址是 /api/v1', () => {
    expect(DEFAULT_API_BASE_URL).toBe('/api/v1');
  });

  it('baseUrl + path 只保留一个斜杠', () => {
    expect(joinUrl('/api/v1', '/products')).toBe('/api/v1/products');
    expect(joinUrl('/api/v1/', '/products')).toBe('/api/v1/products');
    expect(joinUrl('/api/v1', 'products')).toBe('/api/v1/products');
    expect(joinUrl('/api/v1///', '///products')).toBe('/api/v1/products');
  });

  it('支持绝对基址（直连 api:3000）', () => {
    expect(joinUrl('http://127.0.0.1:3000/api/v1', '/purchase-orders')).toBe(
      'http://127.0.0.1:3000/api/v1/purchase-orders',
    );
  });

  it('query 跳过 null/undefined，数组展开为重复键', () => {
    expect(
      buildRequestUrl('/api/v1', '/sales-orders', {
        page: 1,
        keyword: '张三',
        empty: '',
        skipped: undefined,
        alsoSkipped: null,
        status: ['draft', 'done'],
      }),
    ).toBe(
      '/api/v1/sales-orders?page=1&keyword=%E5%BC%A0%E4%B8%89&empty=&status=draft&status=done',
    );
  });

  it('path 已带 query 时用 & 追加', () => {
    expect(buildRequestUrl('/api/v1', '/audit-logs?sort=desc', { page: 2 })).toBe(
      '/api/v1/audit-logs?sort=desc&page=2',
    );
  });

  it('无 query 时不加 ?', () => {
    expect(buildRequestUrl('/api/v1', '/employees')).toBe('/api/v1/employees');
  });
});

describe('统一错误体解析', () => {
  it('{code,message,details,requestId} → ApiError', () => {
    const error = parseApiErrorBody(
      {
        code: 'PERMISSION_DENIED',
        message: '缺少 sales_order:read 权限',
        details: { scope: 'sales_order:read' },
        requestId: 'req-001',
      },
      403,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.message).toBe('缺少 sales_order:read 权限');
    expect(error.status).toBe(403);
    expect(error.details).toEqual({ scope: 'sales_order:read' });
    expect(error.requestId).toBe('req-001');
  });

  it('错误体缺 requestId 时回落到响应头/本次请求 id', () => {
    const error = parseApiErrorBody({ code: 'NOT_FOUND', message: '单据不存在' }, 404, 'req-header');
    expect(error.requestId).toBe('req-header');
  });

  it('非统一错误体（HTML / 空体）兜底为 UNEXPECTED_RESPONSE', () => {
    const error = parseApiErrorBody('<html>502 Bad Gateway</html>', 502, 'req-x');
    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.status).toBe(502);
    expect(error.message).toContain('502');
    expect(error.requestId).toBe('req-x');
  });
});

describe('ApiClient 请求行为', () => {
  it('发送 X-Request-Id / Accept，成功时返回解析后的 JSON', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new ApiClient({
      baseUrl: '/api/v1',
      newRequestId: () => 'req-fixed',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse({ items: [] }, 200);
      },
    });

    const result = await client.get<{ items: unknown[] }>('/products', { query: { page: 1 } });

    expect(result).toEqual({ items: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/products?page=1');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('x-request-id')).toBe('req-fixed');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBeNull();
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('有 token 时带 Authorization，写操作带 Idempotency-Key', async () => {
    let captured: HeadersInit | undefined;
    const client = new ApiClient({
      baseUrl: '/api/v1',
      getToken: () => 'token-123',
      newRequestId: () => 'req-2',
      fetchImpl: async (_input, init) => {
        captured = init?.headers;
        return jsonResponse({ ok: true }, 201);
      },
    });

    await client.post('/purchase-orders', { supplierId: 's1' }, { idempotencyKey: 'k-1' });

    const headers = new Headers(captured);
    expect(headers.get('authorization')).toBe('Bearer token-123');
    expect(headers.get('idempotency-key')).toBe('k-1');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('每个请求都带 X-Client: web（审计来源 D51/D54）', async () => {
    let captured: HeadersInit | undefined;
    const client = new ApiClient({
      baseUrl: '/api/v1',
      fetchImpl: async (_input, init) => {
        captured = init?.headers;
        return jsonResponse({ items: [] }, 200);
      },
    });

    await client.get('/products');

    expect(new Headers(captured).get('x-client')).toBe('web');
  });

  it('调用方 headers 不能覆盖保留头（大小写不敏感）', async () => {
    let captured: HeadersInit | undefined;
    const client = new ApiClient({
      baseUrl: '/api/v1',
      getToken: () => 'token-real',
      newRequestId: () => 'req-reserved',
      fetchImpl: async (_input, init) => {
        captured = init?.headers;
        return jsonResponse({ ok: true }, 201);
      },
    });

    await client.post(
      '/purchase-orders',
      { supplierId: 's1' },
      {
        idempotencyKey: 'k-1',
        reason: 'manual',
        headers: {
          authorization: 'Bearer forged',
          'x-request-id': 'forged',
          'X-Client': 'cli',
          'Content-Type': 'text/plain',
          'Idempotency-Key': 'forged',
          'X-Reason': 'forged',
        },
      },
    );

    const headers = new Headers(captured);
    expect(headers.get('authorization')).toBe('Bearer token-real');
    expect(headers.get('x-request-id')).toBe('req-reserved');
    expect(headers.get('x-client')).toBe('web');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('idempotency-key')).toBe('k-1');
    expect(headers.get('x-reason')).toBe('manual');
  });

  it('超时抛出统一 ApiError，不漏出原生错误', async () => {
    const client = new ApiClient({
      baseUrl: '/api/v1',
      newRequestId: () => 'req-timeout',
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });

    await expect(client.get('/slow', { timeoutMs: 10 })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'TIMEOUT',
      status: 0,
      requestId: 'req-timeout',
    });
  });

  it('非 2xx 抛 ApiError，并保留统一错误体', async () => {
    const client = new ApiClient({
      baseUrl: '/api/v1',
      newRequestId: () => 'req-3',
      fetchImpl: async () =>
        jsonResponse({ code: 'VALIDATION_FAILED', message: '数量必须大于 0', details: { field: 'qty' } }, 422),
    });

    await expect(client.post('/stocktakes', { qty: -1 })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'VALIDATION_FAILED',
      status: 422,
      message: '数量必须大于 0',
      requestId: 'req-3',
    });
  });

  it('204 返回 undefined', async () => {
    const client = new ApiClient({
      baseUrl: '/api/v1',
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    await expect(client.delete('/api-tokens/t1')).resolves.toBeUndefined();
  });
});
