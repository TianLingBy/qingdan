import { allowsScope, type ScopeMatrix, type WorkbenchEntry } from '@qingdan/contracts';

/**
 * 工作台入口清单（Issue #227）——后端单点维护，前端不再自行推导。
 *
 * 数据来自两处原前端真源的对齐合并：
 *   - `apps/web/src/router/routes.ts` 的 `ROUTE_TABLE`（id / path / page / title / domain）；
 *   - `apps/web/src/lib/access.ts` 的 `PAGE_SCOPE`（页面 × 所需功能域，命中任一 `read` 即可见）。
 *
 * 口径与前端 `workbenchEntries()` 完全一致：去掉「登录页」与「工作台自己」，
 * 共 20 个入口；员工能看到的入口是其 scope 收窄后的自然子集（老板 = 全 20）。
 * 隐藏不等于拦截——能不能真正打开仍由各端点按 scope 判定（session-guard 兜底）。
 */

interface WorkbenchEntryDef {
  readonly id: WorkbenchEntry['id'];
  readonly path: WorkbenchEntry['path'];
  readonly page: WorkbenchEntry['page'];
  readonly title: WorkbenchEntry['title'];
  readonly domain: WorkbenchEntry['domain'];
  /** 该页需要哪些功能域（命中任一 `read` 即可见）；空 = 对所有登录员工常显（D44）。 */
  readonly domains: readonly ScopeMatrix[number]['domain'][];
}

const ENTRIES: readonly WorkbenchEntryDef[] = [
  { id: 'flow', path: '/flow', page: '业务全流程图', title: '业务全流程图', domain: '公共', domains: [] },

  { id: 'purchase-orders', path: '/purchase-orders', page: '采购单 A', title: '采购单 A', domain: '单据与结算', domains: ['purchase'] },
  { id: 'processing-orders', path: '/processing-orders', page: '加工单 B', title: '加工单 B', domain: '单据与结算', domains: ['processing'] },
  { id: 'sales-orders', path: '/sales-orders', page: '销售单 E', title: '销售单 E', domain: '单据与结算', domains: ['sales'] },
  { id: 'internal-trades', path: '/internal-trades', page: '内部交易单 N', title: '内部交易单 N', domain: '单据与结算', domains: ['internal_trade'] },
  { id: 'settlements', path: '/settlements', page: '结算单 C（含提成）', title: '结算单 C', domain: '单据与结算', domains: ['settlement', 'commission'] },

  { id: 'reversals', path: '/reversals', page: '冲正单据 R / S / I', title: '冲正单据', domain: '冲正', domains: ['customer_return', 'supplier_return', 'stocktake'] },

  { id: 'products', path: '/products', page: '商品资料', title: '商品资料', domain: '主数据', domains: ['product'] },
  { id: 'customers', path: '/customers', page: '客户', title: '客户', domain: '主数据', domains: ['customer'] },
  { id: 'suppliers', path: '/suppliers', page: '供应商', title: '供应商', domain: '主数据', domains: ['supplier'] },
  { id: 'processors', path: '/processors', page: '加工厂档案', title: '加工厂档案', domain: '主数据', domains: ['processor'] },

  { id: 'inventory', path: '/inventory', page: '库存数量（含委外在途量）', title: '库存数量', domain: '库存', domains: ['inventory_qty'] },
  { id: 'inventory-flows', path: '/inventory-flows', page: '库存流水', title: '库存流水', domain: '库存', domains: ['inventory_flow'] },
  { id: 'stocktakes', path: '/stocktakes', page: '盘点（盘盈盘亏冲正）', title: '盘点', domain: '库存', domains: ['stocktake_page', 'stocktake'] },

  { id: 'employees', path: '/employees', page: '员工', title: '员工', domain: '组织', domains: ['employee'] },
  { id: 'permissions', path: '/permissions', page: '权限设置', title: '权限设置', domain: '组织', domains: ['permission'] },
  { id: 'companies', path: '/companies', page: '公司管理', title: '公司管理', domain: '组织', domains: ['company'] },

  { id: 'profit-report', path: '/profit-report', page: '利润报表', title: '利润报表', domain: '报表', domains: ['profit_report'] },

  { id: 'audit-logs', path: '/audit-logs', page: '操作日志', title: '操作日志', domain: '系统', domains: ['audit'] },
  { id: 'api-integration', path: '/api-integration', page: 'API 与集成', title: 'API 与集成', domain: '系统', domains: ['api_integration'] },
];

/** 单入口可见性：无所需域 = 常显；否则命中任一 `read` 即可见（与前端 canAccessPage 同一口径）。 */
function isEntryVisible(
  scope: ScopeMatrix | undefined,
  entry: WorkbenchEntryDef,
): boolean {
  if (entry.domains.length === 0) return true;
  return entry.domains.some((domain) => allowsScope(scope ?? [], domain, 'read'));
}

/** 按账号 scope 现算可见入口清单（老板 = 全 20，员工 = 收窄子集）。 */
export function computeWorkbenchEntries(scope: ScopeMatrix | undefined): readonly WorkbenchEntry[] {
  return ENTRIES.filter((entry) => isEntryVisible(scope, entry)).map(
    ({ domains: _domains, ...entry }) => entry,
  );
}

/** 全量入口（不含登录 / 工作台），供测试断言总数。 */
export const WORKBENCH_ENTRY_COUNT = ENTRIES.length;
