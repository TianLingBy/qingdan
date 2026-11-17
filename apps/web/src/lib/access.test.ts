import type { ScopeMatrix } from '@qingdan/contracts';
import { describe, expect, it } from 'vitest';
import { ROUTE_TABLE } from '../router/routes';
import { PAGE_SCOPE, allows, canAccessPage, visibleRoutes, workbenchEntries } from './access';

/**
 * 前端权限只做显隐（D4/D15/D27）。这里锁的是「scope → 哪些页面可见」的口径，
 * 尤其是 #5 验收第 1 条：老板与销售看到的入口数量不同，且不靠角色名写死。
 */

const ALL_DOMAINS = [
  'purchase',
  'processing',
  'sales',
  'internal_trade',
  'settlement',
  'commission',
  'customer_return',
  'supplier_return',
  'stocktake',
  'product',
  'customer',
  'supplier',
  'processor',
  'inventory_qty',
  'inventory_flow',
  'stocktake_page',
  'employee',
  'permission',
  'company',
  'profit_report',
  'audit',
  'api_integration',
  'payment',
  'billing',
] as const satisfies readonly ScopeMatrix[number]['domain'][];

const ALL_ACTIONS = [
  'read',
  'create',
  'update',
  'approve',
  'ship',
  'delete',
  'view_price',
  'export',
] as const satisfies readonly ScopeMatrix[number]['actions'][number][];

/** 种子里的「老板」：全部域 × 全部动作（apps/api/src/platform/db/seed.ts）。 */
const OWNER_SCOPE: ScopeMatrix = ALL_DOMAINS.map((domain) => ({ domain, actions: [...ALL_ACTIONS] }));

/** 种子里的「销售」：销售单读写 + 看价、客户、商品只读、库存数量、结算单只读。 */
const SALES_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'update', 'view_price'] },
  { domain: 'customer', actions: ['read', 'create', 'update'] },
  { domain: 'product', actions: ['read'] },
  { domain: 'inventory_qty', actions: ['read'] },
  { domain: 'settlement', actions: ['read'] },
];

function titles(scope: ScopeMatrix): string[] {
  return visibleRoutes(scope).map((route) => route.title);
}

describe('页面 × 权限域对照表', () => {
  it('22 条路由都有对照项（漏一页会让那页永远不显示）', () => {
    expect(Object.keys(PAGE_SCOPE).sort()).toEqual(ROUTE_TABLE.map((route) => route.id).sort());
  });

  it('工作台与业务全流程图常显（D44），其余页面都要域权限', () => {
    for (const route of ROUTE_TABLE) {
      const needs = PAGE_SCOPE[route.id] as readonly string[];
      if (route.id === 'login' || route.id === 'workbench' || route.id === 'flow') {
        expect(needs).toHaveLength(0);
      } else {
        expect(needs.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('scope → 可见页面', () => {
  it('空 scope 只剩常显的两页（工作台 / 业务全流程图）', () => {
    expect(titles([])).toEqual(['工作台', '业务全流程图']);
  });

  it('老板看得到除登录页外的全部 21 页', () => {
    expect(visibleRoutes(OWNER_SCOPE)).toHaveLength(ROUTE_TABLE.length - 1);
    expect(titles(OWNER_SCOPE)).not.toContain('登录 / 入企');
  });

  it('销售只看到自己那 7 页，采购 / 加工 / 权限设置一律不出现', () => {
    expect(titles(SALES_SCOPE)).toEqual([
      '工作台',
      '业务全流程图',
      '销售单 E',
      '结算单 C',
      '商品资料',
      '客户',
      '库存数量',
    ]);
    expect(titles(SALES_SCOPE)).not.toContain('采购单 A');
    expect(titles(SALES_SCOPE)).not.toContain('加工单 B');
    expect(titles(SALES_SCOPE)).not.toContain('权限设置');
    expect(titles(SALES_SCOPE)).not.toContain('员工');
  });

  it('同一页可以接受多个域（结算含提成、冲正 R/S/I 任一即可进）', () => {
    const commissionOnly: ScopeMatrix = [{ domain: 'commission', actions: ['read'] }];
    expect(titles(commissionOnly)).toContain('结算单 C');

    const returnOnly: ScopeMatrix = [{ domain: 'supplier_return', actions: ['read'] }];
    expect(titles(returnOnly)).toContain('冲正单据');
  });

  it('按动作收窄：销售没有销售单 approve，审批类入口判定为无权', () => {
    expect(canAccessPage(SALES_SCOPE, 'sales-orders', 'read')).toBe(true);
    expect(canAccessPage(SALES_SCOPE, 'sales-orders', 'approve')).toBe(false);
    expect(canAccessPage(OWNER_SCOPE, 'sales-orders', 'approve')).toBe(true);
  });

  it('工作台入口卡片不含「登录页」和「工作台自己」', () => {
    const entries = workbenchEntries(OWNER_SCOPE);
    expect(entries).toHaveLength(ROUTE_TABLE.length - 2);
    expect(entries.map((entry) => entry.id)).not.toContain('workbench');
    expect(entries.map((entry) => entry.id)).not.toContain('login');
  });

  it('allows 对未授权域与空 scope 都返回 false', () => {
    expect(allows(SALES_SCOPE, 'purchase', 'read')).toBe(false);
    expect(allows(undefined, 'sales', 'read')).toBe(false);
    expect(allows(SALES_SCOPE, 'sales', 'view_price')).toBe(true);
  });
});
