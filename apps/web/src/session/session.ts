/**
 * 会话态（React Query）。
 *
 * 真源是服务端：会话 Cookie 是否有效以 `GET /auth/me` 的结果为准，
 * 前端不做本地缓存之外的存在性判断（前端隐藏不算数，权限一律服务端判定）。
 * 401 `UNAUTHENTICATED` 是「未登录」的正常信号，不是异常；
 * 其它错误（5xx / 网络不通）如实抛出，由路由错误页承接。
 */

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { fetchMe, type SessionUser } from '../api/auth';

/** 全局唯一会话查询键。 */
export const SESSION_QUERY_KEY = ['auth', 'me'] as const;

/**
 * 会话查询配置。`queryFn` 可注入，便于测试与门禁复用。
 * - `staleTime` 内不重复请求（切换页面不会每次打 /auth/me）；
 * - 401 属 4xx，`queryClient` 默认配置已不重试。
 */
export function sessionQueryOptions(queryFn: () => Promise<SessionUser> = fetchMe) {
  return {
    queryKey: SESSION_QUERY_KEY,
    queryFn,
    staleTime: 60_000,
  };
}

/** 是否为「未登录」错误（401 或统一错误体 `UNAUTHENTICATED`）。 */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.code === 'UNAUTHENTICATED');
}

/**
 * 取当前会话；未登录返回 null（不抛错），供路由门禁与登录页判断。
 * 网络层失败等其它错误如实向上抛。
 */
export async function ensureSession(queryClient: QueryClient): Promise<SessionUser | null> {
  try {
    return await queryClient.ensureQueryData(sessionQueryOptions());
  } catch (error) {
    if (isUnauthenticated(error)) {
      // 清掉缓存中的错误态，登录成功后门禁会重新拉取。
      queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
      return null;
    }
    throw error;
  }
}

/** 组件内使用的会话读取。 */
export function useSession(): {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: SessionUser | null;
} {
  const { isPending, data, error } = useQuery(sessionQueryOptions());
  if (isPending) {
    return { status: 'loading', user: null };
  }
  if (error || !data) {
    return { status: 'anonymous', user: null };
  }
  return { status: 'authenticated', user: data };
}

/** 登出后清理本地会话缓存（Cookie 的清除由服务端完成）。 */
export function clearSessionCache(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
}

/** 便利封装：取 queryClient 的会话清理（组件内用）。 */
export function useClearSession(): () => void {
  const queryClient = useQueryClient();
  return () => clearSessionCache(queryClient);
}
