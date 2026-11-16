import { ROUTES } from '@qingdan/contracts';

/**
 * 动作在本域有没有端点支撑（#255）。
 *
 * - `has-endpoint`：契约路由表里登记过 `(domain, action)` 的端点，勾选后马上有意义；
 * - `preauth-only`：契约里没有这个组合，勾了只是预授权，等功能上线才生效。
 */
export type ActionSupport = 'has-endpoint' | 'preauth-only';

/**
 * 契约里真实登记过的 `domain.action` 集合。
 *
 * 真源是 `packages/contracts/src/routes.ts` 的 `ROUTES`：每条路由（`RouteDef`，
 * 见 `packages/contracts/src/registry.ts` 的 `domain` / `action` 字段）都带结构化的
 * 功能域与动作，所以这里只做集合投影，页面不维护任何手写映射表——手写映射会漂移，
 * 也正是 #255 要避免的。
 *
 * 判断依据是「契约里有没有这条端点」，不是「handler 是否已经实现」：
 * 契约登记过的端点，实现接上后自动从预授权变为可用。
 */
const ROUTE_SCOPES: ReadonlySet<string> = new Set(
  ROUTES.map((route) => `${route.domain}.${route.action}`),
);

export function actionSupport(domain: string, action: string): ActionSupport {
  return ROUTE_SCOPES.has(`${domain}.${action}`) ? 'has-endpoint' : 'preauth-only';
}
