/**
 * 路由会话门禁。
 *
 * `requireSession`：受保护路由的 beforeLoad 用——未登录跳 /login；
 * `ensureSession`：登录页 beforeLoad 用——已登录跳工作台。
 * 权限与数据可见性由服务端判定（D15/D50），门禁只回答「有没有会话」。
 */

import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import type { SessionUser } from '../api/auth';
// ensureSession 单一实现放 session.ts（登录页 beforeLoad 与这里共用），此处只 re-export。
import { ensureSession } from '../session/session';

export { ensureSession };

/** 受保护路由门禁：未登录 → 重定向 /login。 */
export async function requireSession(queryClient: QueryClient): Promise<SessionUser> {
  const session = await ensureSession(queryClient);
  if (!session) {
    throw redirect({ to: '/login' });
  }
  return session;
}
