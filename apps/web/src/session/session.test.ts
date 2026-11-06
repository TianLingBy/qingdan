/**
 * 会话态测试（对应 `session/session.ts`）。
 *
 * 真源是服务端 /auth/me：401 = 未登录（正常信号，返回 null 并清缓存），
 * 其它错误如实上抛由路由错误页承接。
 */

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { SessionUser } from '../api/auth';
import {
  SESSION_QUERY_KEY,
  clearSessionCache,
  isUnauthenticated,
  sessionQueryOptions,
} from './session';

const demoUser: SessionUser = {
  employeeId: 'e1',
  tenantId: 't1',
  displayName: '张明',
  companyIds: ['c1'],
  scope: [],
};

describe('isUnauthenticated', () => {
  it('401 或 UNAUTHENTICATED 错误码都算未登录信号', () => {
    expect(
      isUnauthenticated(new ApiError({ code: 'OTHER', message: 'x', status: 401 })),
    ).toBe(true);
    expect(
      isUnauthenticated(new ApiError({ code: 'UNAUTHENTICATED', message: 'x', status: 400 })),
    ).toBe(true);
  });

  it('其它 4xx/5xx 与非 ApiError 都不算', () => {
    expect(isUnauthenticated(new ApiError({ code: 'INTERNAL', message: 'x', status: 500 }))).toBe(
      false,
    );
    expect(isUnauthenticated(new Error('network'))).toBe(false);
    expect(isUnauthenticated(null)).toBe(false);
  });
});

describe('ensureSession（经 sessionQueryOptions 的 queryFn 注入模拟 /auth/me）', () => {
  it('已登录返回会话', async () => {
    const queryClient = new QueryClient();
    const session = await queryClient.ensureQueryData(
      sessionQueryOptions(() => Promise.resolve(demoUser)),
    );
    expect(session).toEqual(demoUser);
  });

  it('401 未登录返回 null，且错误态不留在缓存里', async () => {
    const queryClient = new QueryClient();
    await expect(
      queryClient.ensureQueryData(
        sessionQueryOptions(() =>
          Promise.reject(new ApiError({ code: 'UNAUTHENTICATED', message: 'x', status: 401 })),
        ),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
  });

  it('5xx / 网络错误如实上抛（不是未登录信号）', async () => {
    const queryClient = new QueryClient();
    await expect(
      queryClient.ensureQueryData(
        sessionQueryOptions(() =>
          Promise.reject(new ApiError({ code: 'INTERNAL', message: '服务内部错误', status: 500 })),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });
  });
});

describe('clearSessionCache', () => {
  it('只清会话键，不动其它查询缓存', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['other', 'key'], { hello: 1 });
    await queryClient.ensureQueryData(sessionQueryOptions(() => Promise.resolve(demoUser)));

    clearSessionCache(queryClient);

    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(['other', 'key'])).toEqual({ hello: 1 });
  });
});
