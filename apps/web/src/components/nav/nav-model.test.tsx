import type { ScopeMatrix } from '@qingdan/contracts';
import { describe, expect, it } from 'vitest';
import { SETTINGS_ROUTE } from '../../router/routes';
import {
  AUTO_COLLAPSE_MAX,
  buildNavGroups,
  defaultCollapsedDomains,
  isActiveRoute,
  navRoutesForScope,
} from './nav-model';

/**
 * 侧边栏导航模型（#300）：
 * - 按域分组、设置中心固定进「系统」组首位；
 * - 无权限项**不渲染**（依据后端 `scope` + `allowsScope`，不写角色常量）；
 * - 项数少的组默认折叠，当前页所在组必须展开。
 */

const DOMAINS = [
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

/** 老板：全部域 × 全部动作。 */
const OWNER_SCOPE: ScopeMatrix = DOMAINS.map((domain) => ({ domain, actions: [...ALL_ACTIONS] }));

/** 销售：只持有自己那几页的 read。 */
const SALES_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'update', 'view_price'] },
  { domain: 'customer', actions: ['read', 'create', 'update'] },
  { domain: 'product', actions: ['read'] },
  { domain: 'inventory_qty', actions: ['read'] },
  { domain: 'settlement', actions: ['read'] },
];

function flatTitles(groups: ReturnType<typeof buildNavGroups>): string[] {
  return groups.flatMap((group) => group.routes.map((route) => route.title));
}

describe('设置中心入口', () => {
  it('路由元数据固定为 /settings、系统域、登录后常显', () => {
    expect(SETTINGS_ROUTE.path).toBe('/settings');
    expect(SETTINGS_ROUTE.domain).toBe('系统');
    expect(SETTINGS_ROUTE.title).toBe('设置中心');
  });

  it('固定在「系统」组首位，且只出现一次', () => {
    const groups = buildNavGroups(navRoutesForScope(OWNER_SCOPE));
    const system = groups.find((group) => group.domain === '系统');
    expect(system).toBeDefined();
    expect(system!.routes[0]?.id).toBe('settings');
    expect(flatTitles(groups).filter((title) => title === '设置中心')).toHaveLength(1);
  });

  it('空 scope 只剩常显页 + 设置中心；登录页不出现在导航里', () => {
    const groups = buildNavGroups(navRoutesForScope([]));
    expect(flatTitles(groups)).toEqual(['工作台', '业务全流程图', '设置中心']);
    expect(flatTitles(groups)).not.toContain('登录 / 入企');
  });
});

describe('无权限的菜单项不渲染', () => {
  it('销售看不到采购 / 加工 / 权限设置 / 员工等未授权页', () => {
    const titles = flatTitles(buildNavGroups(navRoutesForScope(SALES_SCOPE)));

    expect(titles).toContain('销售单 E');
    expect(titles).toContain('客户');
    expect(titles).not.toContain('采购单 A');
    expect(titles).not.toContain('加工单 B');
    expect(titles).not.toContain('权限设置');
    expect(titles).not.toContain('员工');
    expect(titles).not.toContain('操作日志');
  });

  it('销售的系统组只剩设置中心（审计 / API 无权限不渲染）', () => {
    const groups = buildNavGroups(navRoutesForScope(SALES_SCOPE));
    const system = groups.find((group) => group.domain === '系统');
    expect(system?.routes.map((route) => route.title)).toEqual(['设置中心']);
  });

  it('老板能看到除登录页外的全部业务页 + 设置中心', () => {
    const titles = flatTitles(buildNavGroups(navRoutesForScope(OWNER_SCOPE)));
    expect(titles).not.toContain('登录 / 入企');
    expect(titles).toContain('采购单 A');
    expect(titles).toContain('权限设置');
    expect(titles).toContain('设置中心');
  });
});

describe('组内项数少的自动折叠', () => {
  it('阈值是 2：项数 ≤2 的组默认收起，当前页所在组除外', () => {
    expect(AUTO_COLLAPSE_MAX).toBe(2);
    const groups = buildNavGroups(navRoutesForScope(OWNER_SCOPE));
    const collapsed = defaultCollapsedDomains(groups, '/workbench');

    expect(collapsed).toContain('冲正');
    expect(collapsed).toContain('报表');
    // 公共组在导航里只有工作台 + 全流程图（登录页被排除），但当前页就是工作台，必须展开。
    expect(collapsed).not.toContain('公共');
    expect(collapsed).not.toContain('单据与结算');
    expect(collapsed).not.toContain('主数据');
    expect(collapsed).not.toContain('库存');
    expect(collapsed).not.toContain('组织');
    expect(collapsed).not.toContain('系统');

    // 换到设置中心时，公共组（2 项）就该收起了。
    expect(defaultCollapsedDomains(groups, '/settings')).toContain('公共');
  });

  it('当前页所在的组即使项数少也强制展开', () => {
    const groups = buildNavGroups(navRoutesForScope(OWNER_SCOPE));
    expect(defaultCollapsedDomains(groups, '/reversals')).not.toContain('冲正');
    expect(defaultCollapsedDomains(groups, '/profit-report')).not.toContain('报表');
  });

  it('活动路径按等值 + 子路径判断，不做前缀误伤', () => {
    expect(isActiveRoute('/reversals', '/reversals')).toBe(true);
    expect(isActiveRoute('/reversals', '/reversals/detail')).toBe(true);
    expect(isActiveRoute('/reversals', '/reversals-other')).toBe(false);
    expect(isActiveRoute('/settings', '/workbench')).toBe(false);
  });
});
