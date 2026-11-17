import type { RouteEntry } from './routes';

/**
 * 已落地页面清单（唯一真源）。
 *
 * 两处消费它，所以必须是纯数据、不 import 任何页面组件（否则会和 `router.tsx` 形成环）：
 *   - `router.tsx`：用它约束「id ↔ 组件」必须一一对应，漏写组件编译期报错；
 *   - 工作台：用它给还没做的页面打「待实现」标记，避免把占位页当成已上线功能。
 *
 * **新页面落地时必须在这里加一行 id，否则 `router.tsx` 的穷尽映射会编译报错。**
 * 主线 #171（员工 / 权限覆盖）与 #172（权限设置 / 公司 / 操作日志 / API）已落地的 5 页
 * 本来没登记（那时这个文件还没进主干），这里一并补齐——不然工作台会把它们误标「待实现」。
 */
export const IMPLEMENTED_PAGE_IDS = [
  'workbench',
  'flow',
  'products',
  'customers',
  'suppliers',
  'processors',
  // 库存（#143）
  'inventory',
  'inventory-flows',
  'stocktakes',
  'profit-report',
  'purchase-orders',
  'processing-orders',
  'sales-orders',
  'internal-trades',
  'settlements',
  'reversals',
  // 组织（#171 / #172 已落地，补登记）
  'employees',
  'permissions',
  'companies',
  // 系统（#172 已落地，补登记）
  'audit-logs',
  'api-integration',
] as const satisfies readonly RouteEntry['id'][];

export type ImplementedPageId = (typeof IMPLEMENTED_PAGE_IDS)[number];

export function isImplementedPage(routeId: RouteEntry['id']): boolean {
  return (IMPLEMENTED_PAGE_IDS as readonly RouteEntry['id'][]).includes(routeId);
}
