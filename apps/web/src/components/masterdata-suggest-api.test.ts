import { describe, expect, it } from 'vitest';
import { ApiClient } from '../api/client.js';
import {
  createMasterdataSuggestApi,
  type SuggestKind,
} from './masterdata-suggest-api.js';

/**
 * 联想接口的请求形状（#374 的 suggest×4）。
 *
 * 为什么测这个而不是测组件：`SuggestHint` 的候选要等异步请求回来才有，
 * SSR 静态渲染永远拿不到（首屏 `candidates.length === 0` → 返回 null）。
 * 所以「请求发得对不对」在这一层验，「什么时候不该渲染」在组件测试里验。
 */

function recorder() {
  const calls: { url: string; method: string }[] = [];
  const client = new ApiClient({
    baseUrl: '/api/v1',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { api: createMasterdataSuggestApi(client), calls };
}

const COMPANY_ID = '01900000-0000-7000-8000-000000000002';

describe('主数据联想（D99 / #302 块 B）', () => {
  const PATHS: Record<SuggestKind, string> = {
    customer: '/customers/suggest',
    supplier: '/suppliers/suggest',
    processor: '/processors/suggest',
    product: '/products/suggest',
  };

  it.each(Object.keys(PATHS) as SuggestKind[])('四个域各自的路径：%s', async (kind) => {
    const { api, calls } = recorder();
    await api.suggest(kind, { name: '张记', companyId: COMPANY_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain(PATHS[kind]);
  });

  it('name 与 companyId 都进 query，且 name 做 URL 编码', async () => {
    const { api, calls } = recorder();
    await api.suggest('customer', { name: '张记 & 建材', companyId: COMPANY_ID });
    const url = new URL(calls[0]!.url, 'http://x');
    // URLSearchParams 会把空格编成 +，解码回来应等于原值
    expect(url.searchParams.get('name')).toBe('张记 & 建材');
    expect(url.searchParams.get('companyId')).toBe(COMPANY_ID);
  });

  it('不传 limit 就不带这个参数 —— 让服务端用它的默认值', async () => {
    const { api, calls } = recorder();
    await api.suggest('customer', { name: '张记', companyId: COMPANY_ID });
    const url = new URL(calls[0]!.url, 'http://x');
    expect(url.searchParams.has('limit')).toBe(false);
  });

  it('传了 limit 才带', async () => {
    const { api, calls } = recorder();
    await api.suggest('product', { name: '水泥', companyId: COMPANY_ID, limit: 10 });
    const url = new URL(calls[0]!.url, 'http://x');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});
