import type { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { queryClient } from '../api/query';
import { authApi, authKeys, type MeResponse } from '../pages/auth/auth-api';

/**
 * 登录态判定（验收标准第 4 条）：刷新页面先打 `GET /auth/me`，
 * 200 = 已登录（直接进工作台），401 = 未登录（回登录页）。
 *
 * 判定一律以后端为准（D4/D15/D27）：前端不缓存「谁有什么权限」的结论，
 * `me.scope` 只用于入口显隐。
 */

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.code === 'UNAUTHENTICATED');
}

export interface SessionProbe {
  /** 取当前登录人；测试可注入。 */
  readonly load?: () => Promise<MeResponse>;
  /** 默认用全局 QueryClient，与页面缓存同源。 */
  readonly client?: QueryClient;
  /** 缓存键；测试用独立 key 避免互相污染。 */
  readonly queryKey?: readonly unknown[];
}

/**
 * 读当前会话：401 → null（未登录），其他错误继续抛（网络问题不该被当成未登录，
 * 否则会把已登录用户误踢回登录页）。
 */
export async function readSession(probe: SessionProbe = {}): Promise<MeResponse | null> {
  const load = probe.load ?? (() => authApi.me());
  const client = probe.client ?? queryClient;
  const queryKey = probe.queryKey ?? authKeys.me;

  try {
    return await client.ensureQueryData({
      queryKey,
      queryFn: load,
      // 4xx 重试无意义；首次校验要真打接口，所以这里不让缓存「过期重取」失效。
      retry: false,
    });
  } catch (error) {
    if (isUnauthorized(error)) {
      return null;
    }
    throw error;
  }
}

/** 登出后清缓存，避免把上一个人的 me / 列表数据带进下一个会话。 */
export function clearSessionCache(client: QueryClient = queryClient): void {
  client.clear();
}
