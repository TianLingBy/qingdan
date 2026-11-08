import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { BROWSER_BASELINE_LABEL } from '../browser-baseline';
import { authApi, authKeys } from '../pages/auth/auth-api';
import { routesByDomain } from '../router/routes';
import { clearSessionCache } from '../router/session-guard';

/**
 * AppLayout：左侧按功能域分组的导航 + 顶栏（当前登录人 / 退出）。
 *
 * 顶栏的姓名与「退出登录」来自 `GET /auth/me`；导航仍是全量 22 页，
 * 入口显隐按 `me.scope` 做的前端过滤留到各业务页落地时统一处理（D15/D27：判定以后端为准）。
 */
export function AppLayout() {
  const groups = routesByDomain();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me() });

  const logout = useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: async () => {
      // 必须先丢掉缓存的 me：否则 /login 的守卫会读到旧的「已登录」会话，把人又弹回应用内，
      // 表现为「点了退出没反应」。
      queryClient.removeQueries({ queryKey: authKeys.me });
      await navigate({ to: '/login' });
      clearSessionCache();
    },
  });

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <aside className="w-60 shrink-0 border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-4">
          <div className="text-lg font-semibold tracking-tight">轻单</div>
          <div className="mt-0.5 text-xs text-slate-500">集团内部交易与成本归集</div>
        </div>

        <nav className="space-y-4 px-2 py-3 text-sm">
          {groups.map((group) => (
            <div key={group.domain}>
              <div className="px-2 pb-1 text-xs font-medium text-slate-400">{group.domain}</div>
              <ul className="space-y-0.5">
                {group.routes.map((route) => (
                  <li key={route.id}>
                    <Link
                      to={route.path}
                      activeProps={{ className: 'bg-slate-100 font-medium text-slate-900' }}
                      className="block rounded px-2 py-1.5 text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                    >
                      {route.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white px-6">
          <p className="min-w-0 truncate text-sm text-slate-600">
            {me.data ? (
              <>
                你好，<span className="font-medium text-slate-900">{me.data.displayName}</span>
                {me.data.companyIds.length > 0 && (
                  <span className="ml-2 text-xs text-slate-400">
                    可访问 {me.data.companyIds.length} 家公司
                  </span>
                )}
              </>
            ) : me.isError ? (
              '登录信息读取失败'
            ) : (
              '正在确认登录状态…'
            )}
          </p>

          <div className="flex shrink-0 items-center gap-3">
            {logout.isError && <span className="text-xs text-red-600">退出失败，请重试</span>}
            <span className="hidden text-xs text-slate-400 sm:inline" title={BROWSER_BASELINE_LABEL}>
              浏览器基线：{BROWSER_BASELINE_LABEL}
            </span>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50"
            >
              {logout.isPending ? '退出中…' : '退出登录'}
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
