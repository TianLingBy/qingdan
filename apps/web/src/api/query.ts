import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

/**
 * TanStack Query 全局配置。
 * - 4xx（ApiError.status 4xx）不重试：客户端错误重试无意义；
 * - 5xx / 网络错误最多重试 2 次（指数退避由 TanStack Query 默认实现）；
 * - 不主动轮询（一期没有实时看板，D7/D45 推二期）。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient = createQueryClient();
