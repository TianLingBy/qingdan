import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { BROWSER_BASELINE_LABEL } from '../browser-baseline';
import { visibleRoutes } from '../lib/access';
import { authApi, authKeys } from '../pages/auth/auth-api';
import { ROUTE_TABLE, routesByDomain, type Domain, type RouteEntry } from '../router/routes';
import { clearSessionCache } from '../router/session-guard';

/**
 * AppLayout：左侧按功能域分组的导航 + 顶栏（公司切换占位 / 当前登录人 / 退出）。
 *
 * 两件事都在 #5 一起收了这个口：
 * - **导航按 `me.scope` 过滤**（D15/D27）。之前是 22 页全量铺开，工作台又按 scope 显示入口卡片，
 *   两处口径不一致会让人以为「卡片藏了但侧面还能进」。工作台和业务全流程图常显（D44）。
 *   过滤只影响显示，**改 URL 直接进仍然由接口判定**。
 * - **≤768px 走抽屉导航**：400px 宽下 240px 的固定侧栏会把内容挤没，改成顶栏「菜单」展开。
 *
 * 公司切换只有 `me.companyIds` 的数量，没有公司名接口，所以是禁用态占位（见 title 上的 TODO）。
 */

interface NavGroupsProps {
  readonly groups: readonly { domain: Domain; routes: readonly RouteEntry[] }[];
  readonly onNavigate?: () => void;
}

function NavGroups({ groups, onNavigate }: NavGroupsProps) {
  return (
    <nav className="space-y-4 px-2 py-3 text-sm">
      {groups.map((group) => (
        <div key={group.domain}>
          <div className="px-2 pb-1 text-xs font-medium text-slate-400">{group.domain}</div>
          <ul className="space-y-0.5">
            {group.routes.map((route) => (
              <li key={route.id}>
                <Link
                  to={route.path}
                  onClick={onNavigate}
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
  );
}

export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me() });

  const groups = useMemo(() => {
    // me 尚未就绪时先铺全量（不含登录页），避免导航先缩成两条再撑开。
    const routes = me.data ? visibleRoutes(me.data.scope) : ROUTE_TABLE.filter((r) => r.path !== '/login');
    return routesByDomain(routes);
  }, [me.data]);

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

  const companyCount = me.data?.companyIds.length ?? 0;

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:block">
        <div className="border-b border-slate-200 px-4 py-4">
          <div className="text-lg font-semibold tracking-tight">轻单</div>
          <div className="mt-0.5 text-xs text-slate-500">集团内部交易与成本归集</div>
        </div>
        <NavGroups groups={groups} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              onClick={() => setMenuOpen((open) => !open)}
              className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700 md:hidden"
            >
              {menuOpen ? '收起' : '菜单'}
            </button>
            <p className="min-w-0 truncate text-sm text-slate-600">
              {me.data ? (
                <>
                  你好，<span className="font-medium text-slate-900">{me.data.displayName}</span>
                  {companyCount > 0 && (
                    <span className="ml-2 text-xs text-slate-400">可访问 {companyCount} 家公司</span>
                  )}
                </>
              ) : me.isError ? (
                '登录信息读取失败'
              ) : (
                '正在确认登录状态…'
              )}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <label className="hidden items-center gap-1.5 text-xs text-slate-500 sm:flex">
              <span className="text-slate-400">公司</span>
              <select
                aria-label="公司切换"
                disabled
                title="公司切换待接口：TODO(接口待做) GET /api/v1/companies + 会话内切换"
                className="max-w-[9.5rem] rounded-lg border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-600"
              >
                <option>{me.data ? `全部公司（${companyCount} 家）` : '全部公司'}</option>
              </select>
            </label>
            {logout.isError && <span className="text-xs text-red-600">退出失败，请重试</span>}
            <span className="hidden text-xs text-slate-400 lg:inline" title={BROWSER_BASELINE_LABEL}>
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

          {menuOpen && (
            <div
              id="mobile-nav"
              className="absolute inset-x-0 top-full z-30 max-h-[70vh] overflow-y-auto border-b border-slate-200 bg-white shadow-lg md:hidden"
            >
              <NavGroups groups={groups} onNavigate={() => setMenuOpen(false)} />
            </div>
          )}
        </header>

        <main className="min-w-0 flex-1 px-4 py-4 md:px-6 md:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
