import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { MeResponse } from '../pages/auth/auth-api';
import { clearSessionCache, isUnauthorized, readSession } from './session-guard';

const ME: MeResponse = {
  employeeId: 'e1',
  tenantId: 't1',
  displayName: '张明',
  companyIds: ['c1'],
  scope: [{ domain: 'product', actions: ['read'] }],
};

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('会话判定（GET /auth/me 为唯一依据）', () => {
  it('200 → 已登录，并复用缓存（同一次导航不重复打接口）', async () => {
    const client = freshClient();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return ME;
    };
    const queryKey = ['auth', 'me', 'test-ok'] as const;

    const first = await readSession({ load, client, queryKey });
    const second = await readSession({ load, client, queryKey });

    expect(first?.displayName).toBe('张明');
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it('401 → 未登录（返回 null，而不是抛错）', async () => {
    const client = freshClient();
    const load = async (): Promise<MeResponse> => {
      throw new ApiError({ code: 'UNAUTHENTICATED', message: '未登录', status: 401 });
    };

    const me = await readSession({ load, client, queryKey: ['auth', 'me', 'test-401'] });
    expect(me).toBeNull();
  });

  it('网络错误继续抛，避免把已登录用户误踢回登录页', async () => {
    const client = freshClient();
    const load = async (): Promise<MeResponse> => {
      throw new ApiError({ code: 'NETWORK_ERROR', message: '网络请求失败', status: 0 });
    };

    await expect(
      readSession({ load, client, queryKey: ['auth', 'me', 'test-network'] }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('isUnauthorized 只认 401 / UNAUTHENTICATED', () => {
    expect(
      isUnauthorized(new ApiError({ code: 'UNAUTHENTICATED', message: 'x', status: 401 })),
    ).toBe(true);
    expect(isUnauthorized(new ApiError({ code: 'FORBIDDEN', message: 'x', status: 403 }))).toBe(
      false,
    );
    expect(isUnauthorized(new Error('boom'))).toBe(false);
  });

  it('登出清缓存，避免下一个会话读到上一个人的数据', async () => {
    const client = freshClient();
    client.setQueryData(['auth', 'me'], ME);
    client.setQueryData(['masterdata', 'products'], { items: [1] });

    clearSessionCache(client);

    expect(client.getQueryData(['auth', 'me'])).toBeUndefined();
    expect(client.getQueryData(['masterdata', 'products'])).toBeUndefined();
  });

  it('退出登录必须先让 me 失效：否则 /login 守卫会拿旧会话把人弹回应用内', async () => {
    const client = freshClient();
    const queryKey = ['auth', 'me', 'test-logout'] as const;
    let calls = 0;

    // 登录态：第一次读会话命中缓存外的真实接口
    const loggedIn = await readSession({
      load: async () => {
        calls += 1;
        return ME;
      },
      client,
      queryKey,
    });
    expect(loggedIn).not.toBeNull();

    // 退出登录：只清 me 缓存，下一次读会话必须重新打接口并拿到 401
    client.removeQueries({ queryKey });
    const afterLogout = await readSession({
      load: async () => {
        calls += 1;
        throw new ApiError({ code: 'UNAUTHENTICATED', message: '未登录', status: 401 });
      },
      client,
      queryKey,
    });

    expect(afterLogout).toBeNull();
    expect(calls).toBe(2);
  });
});
