import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import type { Domain, RouteSpec } from '../../router/routes';
import { buildNavGroups, defaultCollapsedDomains, isActiveRoute } from './nav-model';

/**
 * 侧边栏导航：按功能域分组 + 组内项数少的默认折叠 + 无权限项不渲染。
 *
 * - `routes` 必须已经按后端 scope 过滤（见 `navRoutesForScope`）；本组件**不判权限**。
 * - 菜单显隐只是观感：**隐藏 ≠ 授权**，改 URL 直进仍由路由守卫与后端 403 兜底。
 * - 折叠状态只放内存（`useState`），不写 `localStorage`——这里没有需要持久化的业务数据。
 */
export interface SidebarNavProps {
  /** 已按 scope 过滤的可见路由（登录页已在外部剔除）。 */
  readonly routes: readonly RouteSpec[];
  /** 当前路径；用于默认展开「我所在的组」。 */
  readonly currentPath: string;
  /** 移动端点完菜单后收起抽屉。 */
  readonly onNavigate?: () => void;
}

export function SidebarNav({ routes, currentPath, onNavigate }: SidebarNavProps) {
  const groups = useMemo(() => buildNavGroups(routes), [routes]);
  // 初始化就按「项数少的组自动折叠」；当前页所在的组强制展开。
  const [collapsed, setCollapsed] = useState<ReadonlySet<Domain>>(
    () => new Set(defaultCollapsedDomains(groups, currentPath)),
  );

  // 直接改 URL / 点外部链接进入某个折叠组时，把它展开，避免用户看不到自己在哪。
  useEffect(() => {
    const active = groups.find((group) =>
      group.routes.some((route) => isActiveRoute(route.path, currentPath)),
    );
    if (!active) return;
    setCollapsed((previous) => {
      if (!previous.has(active.domain)) return previous;
      const next = new Set(previous);
      next.delete(active.domain);
      return next;
    });
  }, [currentPath, groups]);

  function toggle(domain: Domain) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(domain)) {
        next.delete(domain);
      } else {
        next.add(domain);
      }
      return next;
    });
  }

  return (
    <nav className="space-y-2 px-2 py-3 text-sm" aria-label="主导航">
      {groups.map((group, index) => {
        const isCollapsed = collapsed.has(group.domain);
        const panelId = `nav-group-${index}`;
        return (
          <div key={group.domain}>
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-controls={panelId}
              onClick={() => toggle(group.domain)}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
            >
              <span>{group.domain}</span>
              <span className="flex items-center gap-1">
                <span className="tabular-nums">{group.routes.length}</span>
                <span aria-hidden>{isCollapsed ? '▸' : '▾'}</span>
              </span>
            </button>
            {!isCollapsed && (
              <ul id={panelId} className="mt-0.5 space-y-0.5">
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
            )}
          </div>
        );
      })}
    </nav>
  );
}
