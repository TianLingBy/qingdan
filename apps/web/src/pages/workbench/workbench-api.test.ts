import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../api/client';
import { createWorkbenchApi } from './workbench-api';

/**
 * 只测请求形状。
 *
 * 页面层（`WorkbenchPage.test.tsx`）用 `renderToStaticMarkup` 测版式，测不到「请求发给了谁」；
 * 这里补上那一层。两层加起来才覆盖「点开工作台会拉什么」。
 */

function recorder(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? 'GET' });
    return Promise.resolve(respond(url, init ?? {}));
  };
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('workbench-api', () => {
  it('todos() 打的是 GET /api/v1/todos', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({ items: [] }));
    const api = createWorkbenchApi(new ApiClient({ baseUrl: '/api/v1', fetchImpl }));

    await api.todos();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/todos');
    expect(calls[0]?.method).toBe('GET');
  });

  it('返回体按契约解出 items，且不假设条数固定', async () => {
    // 后端按权限逐条过滤：有 7 类定义的域，实际可能只回 1 条，也可能一条都不回。
    // 前端拿 items.length 当「一共几类」用就会出错，所以这条断言两头的形状都过一遍。
    const one = recorder(() =>
      jsonResponse({
        items: [{ kind: 'inventory_alert', title: '低库存批次', count: 2, hint: '撑不到 8 天', routeId: 'inventory' }],
      }),
    );
    const a = createWorkbenchApi(new ApiClient({ baseUrl: '/api/v1', fetchImpl: one.fetchImpl }));
    const got = await a.todos();
    expect(got.items).toHaveLength(1);
    // TodoItem 没有 id 字段 —— 页面里 key 用的是 kind
    expect(got.items[0]).not.toHaveProperty('id');
    expect(got.items[0]?.kind).toBe('inventory_alert');

    const none = recorder(() => jsonResponse({ items: [] }));
    const b = createWorkbenchApi(new ApiClient({ baseUrl: '/api/v1', fetchImpl: none.fetchImpl }));
    expect((await b.todos()).items).toEqual([]);
  });
});
