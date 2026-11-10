import { allowsScope, type ScopeMatrix } from '@qingdan/contracts';
import { ROUTE_TABLE, type RouteEntry } from '../router/routes';

/**
 * 页面 × 权限域对照表（#5 验收第 1 条：入口按 `scope` 显隐，**不写死角色名**）。
 *
 * `GET /auth/me` 只回「功能域 × 动作」的 scope，不回页面清单、也不回岗位名，
 * 所以「这一页要不要给这个人看见」只能由 scope 推导。前端推导结果**只决定显不显示**，
 * 真正的判定一律在后端（D4/D15/D27）；藏起来不等于拦住，改 URL 直接进也由接口兜住。
 *
 * 取值必须对齐 `packages/contracts/src/authz.ts` 的 `ScopeEntrySchema`，前端不自造域。
 */

export type ScopeDomain = ScopeMatrix[number]['domain'];
export type ScopeAction = ScopeMatrix[number]['actions'][number];

/** 该页需要哪些功能域（命中任一即可见）。空数组 = 对所有登录员工常显（D44）。 */
export const PAGE_SCOPE = {
  login: [],
  // D44：工作台与业务全流程图对全部登录员工开放。
  workbench: [],
  flow: [],
  'purchase-orders': ['purchase'],
  'processing-orders': ['processing'],
  'sales-orders': ['sales'],
  'internal-trades': ['internal_trade'],
  // 结算单页含提成（prototype-v0 §2 把提成并进 C 单），只给提成权限也要能进。
  settlements: ['settlement', 'commission'],
  // R / S / I 三栏同页，任一冲正域可见即显示整页，页内分栏再按各自域收窄。
  reversals: ['customer_return', 'supplier_return', 'stocktake'],
  products: ['product'],
  customers: ['customer'],
  suppliers: ['supplier'],
  processors: ['processor'],
  inventory: ['inventory_qty'],
  'inventory-flows': ['inventory_flow'],
  // 盘点页本身走 stocktake_page；只持「盘盈盘亏」域的（如经理/D47 审批）也放进来。
  stocktakes: ['stocktake_page', 'stocktake'],
  employees: ['employee'],
  permissions: ['permission'],
  companies: ['company'],
  'profit-report': ['profit_report'],
  'audit-logs': ['audit'],
  'api-integration': ['api_integration'],
} as const satisfies Record<RouteEntry['id'], readonly ScopeDomain[]>;

/** 是否持有某域的某个动作。`scope` 缺省视为「什么都没授权」。 */
export function allows(scope: ScopeMatrix | undefined, domain: ScopeDomain, action: ScopeAction): boolean {
  return allowsScope(scope ?? [], domain, action);
}

/** 单页可见性。 */
export function canAccessPage(
  scope: ScopeMatrix | undefined,
  routeId: RouteEntry['id'],
  action: ScopeAction = 'read',
): boolean {
  const domains = PAGE_SCOPE[routeId] as readonly ScopeDomain[];
  if (domains.length === 0) return true;
  return domains.some((domain) => allows(scope, domain, action));
}

/** 按权限过滤后的可见页面（含 `/login` 以外的全部，顺序与路由表一致）。 */
export function visibleRoutes(scope: ScopeMatrix | undefined): readonly RouteEntry[] {
  return ROUTE_TABLE.filter((entry) => entry.path !== '/login' && canAccessPage(scope, entry.id));
}

/**
 * 工作台入口卡片：去掉「登录页」与「工作台自己」——
 * 首页不需要给自己一个回首页的入口。
 */
export function workbenchEntries(scope: ScopeMatrix | undefined): readonly RouteEntry[] {
  return visibleRoutes(scope).filter((entry) => entry.id !== 'workbench');
}
