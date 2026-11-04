/**
 * 22 页 IA 路由表（唯一真源）
 *
 * 页面清单逐条对齐 `docs/prototype-v0.md` §2「页面清单（重排后 22 页 + 全局能力）」，
 * 路径一律 kebab-case；本文件是纯数据，不 import React / Router，
 * 便于 `src/router/routes.test.ts` 直接断言「22 条齐全、无重复」。
 *
 * 页号 → path 对照（页号取自 prototype-v0 §2 表格）：
 *   1 登录/企业注册/入企      → /login
 *   2 工作台                  → /workbench
 *   3 采购单 A                → /purchase-orders
 *   4 加工单 B                → /processing-orders
 *   5 销售单 E                → /sales-orders
 *   6 内部交易单 N            → /internal-trades
 *   7 结算单 C（含提成）      → /settlements
 *   8 冲正单据 R/S/I          → /reversals（客户退货 R / 供应商退货 S / 盘点盈亏 I 为页内分栏）
 *   9 商品资料                → /products
 *  10 客户                    → /customers
 *  11 供应商                  → /suppliers
 *  12 加工厂档案              → /processors
 *  13 库存数量（含委外在途）  → /inventory
 *  14 库存流水                → /inventory-flows
 *  15 盘点                    → /stocktakes
 *  16 员工                    → /employees
 *  17 权限设置                → /permissions
 *  18 公司管理                → /companies
 *  19 业务全流程图            → /flow
 *  20 利润报表                → /profit-report
 *  21 操作日志                → /audit-logs
 *  22 API 与集成              → /api-integration
 *
 * 为什么没有 /commissions、/customer-returns、/supplier-returns：
 *   prototype-v0 §2 把「提成」并入 C 单（第二批）、把 R/S/I 合并为第 8 页「冲正单据」，
 *   因此这三项都是页内分栏而不是独立页，才能保持 IA 为 22 页。
 */

/** 一期功能域分组（对齐 docs/prototype-v0.md §3.3「一期功能域清单」D44）。 */
export type Domain =
  | '公共'
  | '单据与结算'
  | '冲正'
  | '主数据'
  | '库存'
  | '组织'
  | '报表'
  | '系统';

export const NAV_DOMAINS: readonly Domain[] = [
  '公共',
  '单据与结算',
  '冲正',
  '主数据',
  '库存',
  '组织',
  '报表',
  '系统',
];

export interface RouteSpec {
  /** 稳定 id，用于测试与埋点 */
  readonly id: string;
  /** kebab-case 路径 */
  readonly path: string;
  /** 页面名（与 docs/prototype-v0.md §2 对齐） */
  readonly page: string;
  /** 所属功能域 */
  readonly domain: Domain;
  /** 左侧导航里的标题（比 page 短） */
  readonly title: string;
}

export const ROUTE_TABLE = [
  { id: 'login', path: '/login', page: '登录 / 企业注册 / 入企', domain: '公共', title: '登录 / 入企' },
  { id: 'workbench', path: '/workbench', page: '工作台', domain: '公共', title: '工作台' },
  { id: 'flow', path: '/flow', page: '业务全流程图', domain: '公共', title: '业务全流程图' },

  { id: 'purchase-orders', path: '/purchase-orders', page: '采购单 A', domain: '单据与结算', title: '采购单 A' },
  { id: 'processing-orders', path: '/processing-orders', page: '加工单 B', domain: '单据与结算', title: '加工单 B' },
  { id: 'sales-orders', path: '/sales-orders', page: '销售单 E', domain: '单据与结算', title: '销售单 E' },
  { id: 'internal-trades', path: '/internal-trades', page: '内部交易单 N', domain: '单据与结算', title: '内部交易单 N' },
  { id: 'settlements', path: '/settlements', page: '结算单 C（含提成）', domain: '单据与结算', title: '结算单 C' },

  { id: 'reversals', path: '/reversals', page: '冲正单据 R / S / I', domain: '冲正', title: '冲正单据' },

  { id: 'products', path: '/products', page: '商品资料', domain: '主数据', title: '商品资料' },
  { id: 'customers', path: '/customers', page: '客户', domain: '主数据', title: '客户' },
  { id: 'suppliers', path: '/suppliers', page: '供应商', domain: '主数据', title: '供应商' },
  { id: 'processors', path: '/processors', page: '加工厂档案', domain: '主数据', title: '加工厂档案' },

  { id: 'inventory', path: '/inventory', page: '库存数量（含委外在途量）', domain: '库存', title: '库存数量' },
  { id: 'inventory-flows', path: '/inventory-flows', page: '库存流水', domain: '库存', title: '库存流水' },
  { id: 'stocktakes', path: '/stocktakes', page: '盘点（盘盈盘亏冲正）', domain: '库存', title: '盘点' },

  { id: 'employees', path: '/employees', page: '员工', domain: '组织', title: '员工' },
  { id: 'permissions', path: '/permissions', page: '权限设置', domain: '组织', title: '权限设置' },
  { id: 'companies', path: '/companies', page: '公司管理', domain: '组织', title: '公司管理' },

  { id: 'profit-report', path: '/profit-report', page: '利润报表', domain: '报表', title: '利润报表' },

  { id: 'audit-logs', path: '/audit-logs', page: '操作日志', domain: '系统', title: '操作日志' },
  { id: 'api-integration', path: '/api-integration', page: 'API 与集成', domain: '系统', title: 'API 与集成' },
] as const satisfies readonly RouteSpec[];

export type RouteEntry = (typeof ROUTE_TABLE)[number];
export type RoutePath = RouteEntry['path'];

/** 按功能域分组，供左侧导航渲染。 */
export function routesByDomain(): readonly { domain: Domain; routes: readonly RouteEntry[] }[] {
  return NAV_DOMAINS.map((domain) => ({
    domain,
    routes: ROUTE_TABLE.filter((route) => route.domain === domain),
  })).filter((group) => group.routes.length > 0);
}

/** 默认落地页（工作台）。 */
export const DEFAULT_ROUTE_PATH: RoutePath = '/workbench';
