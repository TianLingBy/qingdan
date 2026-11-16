import type { ScopeMatrix } from '@qingdan/contracts';
import { visibleRoutes } from '../../lib/access';
import {
  ROUTE_TABLE,
  SETTINGS_ROUTE,
  routesByDomain,
  type Domain,
  type RouteSpec,
} from '../../router/routes';

/**
 * 侧边栏导航的**纯数据模型**（不 import React / Router，便于直接断言）。
 *
 * 权限口径（#300 验收第 3 条）：
 * - 菜单项只按后端 `GET /auth/me` 返回的 `scope`（功能域 × 动作）过滤；
 *   这里复用 `lib/access.ts` 的 `visibleRoutes`，底层就是 `allowsScope(...)`，**不写任何角色常量**。
 * - **隐藏 ≠ 授权**：本文件只决定「显不显示」，每个端点仍由后端 `requireScope` 兜底；
 *   直接改 URL 进入也照样会被接口 403 拦下（D4/D15/D27）。
 * - 设置中心是个人页（登录即可），没有业务 scope，所以固定出现在「系统」组首位。
 */

/** 组内路由数 ≤ 该值时默认折叠（「项数少的自动折叠」，点组标题可展开）。 */
export const AUTO_COLLAPSE_MAX = 2;

export interface NavGroupView {
  readonly domain: Domain;
  readonly routes: readonly RouteSpec[];
}

/** 登录前导航不渲染；这里把「登录页」排除掉，与原有行为一致。 */
export function navRoutesForScope(scope: ScopeMatrix | undefined): readonly RouteSpec[] {
  if (!scope) {
    // scope 尚未就绪时铺全量（不含登录页），避免导航先缩成两条再撑开。
    return ROUTE_TABLE.filter((route) => route.path !== '/login');
  }
  return visibleRoutes(scope);
}

/**
 * 组装导航分组：`/settings` 固定插到「系统」组首位，其余按 `ROUTE_TABLE` 的功能域分组。
 * `routes` 必须是已按 scope 过滤后的子集；本函数不再判权限。
 */
export function buildNavGroups(routes: readonly RouteSpec[]): readonly NavGroupView[] {
  return routesByDomain([SETTINGS_ROUTE, ...routes]);
}

/** 当前路径是否落在该菜单项上（给 `activeProps` 用；仅做等值 + 子路径判断）。 */
export function isActiveRoute(path: string, currentPath: string): boolean {
  return currentPath === path || currentPath.startsWith(`${path}/`);
}

/**
 * 默认收起的组：项数少（≤ `AUTO_COLLAPSE_MAX`）且**不包含当前页**的组。
 * 当前页所在的组必须展开，否则刷新后用户会看不见自己所在的菜单。
 */
export function defaultCollapsedDomains(
  groups: readonly NavGroupView[],
  currentPath: string,
): readonly Domain[] {
  return groups
    .filter(
      (group) =>
        group.routes.length <= AUTO_COLLAPSE_MAX &&
        !group.routes.some((route) => isActiveRoute(route.path, currentPath)),
    )
    .map((group) => group.domain);
}
