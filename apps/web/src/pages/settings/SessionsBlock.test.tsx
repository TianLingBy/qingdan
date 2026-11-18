import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { SessionsBlock, formatMoment } from './SessionsBlock';
import { createSettingsApi } from './settings-api';
import { ApiClient } from '../../api/client';

/**
 * 「我的登录设备」的测试。
 *
 * 只测**能测到的两层**：
 * 1. 请求形状（URL / method）—— 用假的 fetch 真发一次，断言发出去的到底是什么；
 * 2. 纯函数（`formatMoment`）—— 时间格式化错一位，用户看到的就是错的时刻。
 *
 * **不测「踢出按钮在不在」**：按钮在 `data-state="filled"` 分支里，而 SSR 首屏渲染时
 * query 还是 `pending`，那个分支整块不输出。用 `renderToStaticMarkup` 硬测只会得到
 * 一个永远绿的假断言（我在 #375 的结算撤销上踩过一次：两条 UI 用例红了，因为
 * 详情面板在 SSR 首屏里根本没渲染）。
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

describe('settings-api 的会话端点', () => {
  it('sessions() 打的是 GET /api/v1/employees/me/sessions', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({ items: [] }));
    const api = createSettingsApi(new ApiClient({ baseUrl: '/api/v1', fetchImpl }));

    await api.sessions();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/employees/me/sessions');
    expect(calls[0]?.method).toBe('GET');
  });

  it('revokeSession(id) 打的是 DELETE /api/v1/employees/me/sessions/{id}', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse({ id: 's-1', revokedAt: '2026-11-18T08:00:00Z' }),
    );
    const api = createSettingsApi(new ApiClient({ baseUrl: '/api/v1', fetchImpl }));

    await api.revokeSession('s-1');

    expect(calls).toHaveLength(1);
    // 路径里带的是会话 id，不带员工 id —— 契约只有 {id}，「只限本人」由服务端从会话身份判
    expect(calls[0]?.url).toBe('/api/v1/employees/me/sessions/s-1');
    expect(calls[0]?.method).toBe('DELETE');
  });
});

describe('formatMoment', () => {
  it('null 显示成占位符而不是 "Invalid Date"', () => {
    // lastSeenAt 就可能是 null（签发后从未使用过）
    expect(formatMoment(null)).toBe('—');
  });

  it('非法时间串退回占位符，不抛也不显示 NaN', () => {
    expect(formatMoment('这不是时间')).toBe('—');
  });

  it('按 YYYY-MM-DD HH:mm 显示，补零', () => {
    // 构造本地时间而非 UTC 串，避免断言依赖运行机器的时区
    const local = new Date(2026, 0, 5, 9, 7).toISOString();
    expect(formatMoment(local)).toBe('2026-01-05 09:07');
  });
});

describe('SessionsBlock 首屏', () => {
  function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SessionsBlock />
      </QueryClientProvider>,
    );
  }

  it('首屏输出「正在读取登录设备」而不是空白', () => {
    // 空白会让人以为没有设备，而实际是还没拉到 —— 这两件事必须区分
    const html = render();
    expect(html).toContain('我的登录设备');
    expect(html).toContain('正在读取登录设备');
  });

  it('首屏是 loading 态，不是 filled 或 error', () => {
    const html = render();
    expect(html).toContain('data-state="loading"');
    expect(html).not.toContain('data-state="filled"');
  });
});
