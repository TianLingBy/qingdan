import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { BROWSER_BASELINE_LABEL } from '../browser-baseline';
import { logout } from '../api/auth';
import { queryClient } from '../api/query';
import { routesByDomain } from '../router/routes';
import { useSession, clearSessionCache } from '../session/session';

/**
 * AppLayout：左侧按功能域分组的导航 + 顶栏。
 * 会话由路由门禁保证（未登录到不了这里）；权限过滤不做（服务端判定，D15/D27；前端隐藏不算数）。
 */
export function AppLayout() {
  const groups = routesByDomain();
  const navigate = useNavigate();
  const { status, user } = useSession();

  async function handleLogout() {
    try {
      await logout();
    } finally {
      // 即使登出请求失败（网络断/超时）也清本地会话缓存并回登录页；
      // Cookie 若仍在，下次访问受保护页时门禁会再校验一次。
      clearSessionCache(queryClient);
      await navigate({ to: '/login' });
    }
  }

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
        <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
          <div className="text-sm text-slate-500">
            {status === 'authenticated' && user ? `当前登录：${user.displayName}` : ''}
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-slate-400" title={BROWSER_BASELINE_LABEL}>
              浏览器基线：{BROWSER_BASELINE_LABEL}
            </div>
            {status === 'authenticated' ? (
              <button
                type="button"
                onClick={handleLogout}
                className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              >
                登出
              </button>
            ) : null}
          </div>
        </header>

        <main className="min-w-0 flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
