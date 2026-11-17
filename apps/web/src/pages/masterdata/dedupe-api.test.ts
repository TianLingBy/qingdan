import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../api/client';
import { createDedupeApi } from './dedupe-api';

/**
 * 去重审核台接口的请求形状测试。
 *
 * 为什么只测形状、不测业务：队列怎么排序、`readableKinds` 放行哪几类都是服务端的事（D102）；
 * 前端唯一可能写错的是「发到哪个 URL、带什么 body」——尤其 `merge` 的 body 是 `.strict()`，
 * 多一个键就是 422，所以这里把「body 有且只有 direction」单独钉一条。
 */

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const PAIR_ID = '01a1bf69-545e-7265-b209-ff4f133e169e';

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function makeApi(responseBody: unknown) {
  const calls: RecordedCall[] = [];
  const client = new ApiClient({
    baseUrl: '/api/v1',
    newRequestId: () => 'req-dedupe-test',
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-dedupe-test' },
      });
    }) as unknown as typeof fetch,
  });
  return { api: createDedupeApi(client), calls };
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

describe('dedupe API', () => {
  it('列表带 companyId，未筛类型时不带 kind（undefined 会被跳过，不能发空串）', async () => {
    const { api, calls } = makeApi({ items: [] });

    await api.list({ companyId: COMPANY_ID, state: 'pending' });

    const [call] = calls;
    expect(call?.init?.method).toBe('GET');
    expect(call?.url).toContain('/api/v1/masterdata/dedupe?');
    expect(call?.url).toContain(`companyId=${COMPANY_ID}`);
    expect(call?.url).toContain('state=pending');
    expect(call?.url).not.toContain('kind=');
  });

  it('列表带 kind 时按真实类型筛选（服务端据此决定返回哪几类）', async () => {
    const { api, calls } = makeApi({ items: [] });

    await api.list({ companyId: COMPANY_ID, kind: 'supplier', state: 'kept' });

    expect(calls[0]?.url).toContain('kind=supplier');
    expect(calls[0]?.url).toContain('state=kept');
  });

  it('判为不同：POST /masterdata/dedupe/{id}/keep-separate，body 只有 reason', async () => {
    const { api, calls } = makeApi({ id: PAIR_ID, state: 'kept', decidedAt: '2026-11-18T01:00:00.000Z' });

    await api.keepSeparate(PAIR_ID, '两家是夫妻店，电话一样但不是同一个客户');

    const [call] = calls;
    expect(call?.init?.method).toBe('POST');
    expect(call?.url).toBe(`/api/v1/masterdata/dedupe/${PAIR_ID}/keep-separate`);
    expect(bodyOf(call as RecordedCall)).toEqual({
      reason: '两家是夫妻店，电话一样但不是同一个客户',
    });
  });

  it('撤销判定：POST /masterdata/dedupe/{id}/reopen，body 只有 reason', async () => {
    const { api, calls } = makeApi({ id: PAIR_ID, state: 'pending', decidedAt: null });

    await api.reopen(PAIR_ID, '判错了，其实是同一家');

    const [call] = calls;
    expect(call?.init?.method).toBe('POST');
    expect(call?.url).toBe(`/api/v1/masterdata/dedupe/${PAIR_ID}/reopen`);
    expect(bodyOf(call as RecordedCall)).toEqual({ reason: '判错了，其实是同一家' });
  });

  it('合并：body 有且只有 direction（.strict() 多一个键就 422）', async () => {
    const { api, calls } = makeApi({
      keptId: 'k1',
      mergedId: 'm1',
      movedReferences: [{ table: 'sales_order_items', column: 'customer_id', rows: 3 }],
    });

    const result = await api.merge(PAIR_ID, 'left_into_right');

    const [call] = calls;
    expect(call?.init?.method).toBe('POST');
    expect(call?.url).toBe(`/api/v1/masterdata/dedupe/${PAIR_ID}/merge`);
    const body = bodyOf(call as RecordedCall);
    expect(Object.keys(body)).toEqual(['direction']);
    expect(body).toEqual({ direction: 'left_into_right' });
    expect(result.movedReferences[0]?.rows).toBe(3);
  });
});
