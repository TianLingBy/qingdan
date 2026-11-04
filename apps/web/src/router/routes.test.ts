import { describe, expect, it } from 'vitest';
import { WEB_API_PROXY_PREFIX } from '../../vite.config';
import { DEFAULT_ROUTE_PATH, NAV_DOMAINS, ROUTE_TABLE, routesByDomain, type Domain } from './routes';

/**
 * 22 页 IA 是 `docs/prototype-v0.md` §2 的硬约束：
 * 本测试锁住「22 条齐全、路径唯一、kebab-case、功能域合法」。
 */
const EXPECTED_PATHS = [
  '/login',
  '/workbench',
  '/flow',
  '/purchase-orders',
  '/processing-orders',
  '/sales-orders',
  '/internal-trades',
  '/settlements',
  '/reversals',
  '/products',
  '/customers',
  '/suppliers',
  '/processors',
  '/inventory',
  '/inventory-flows',
  '/stocktakes',
  '/employees',
  '/permissions',
  '/companies',
  '/profit-report',
  '/audit-logs',
  '/api-integration',
] as const;

const KEBAB_PATH = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('22 页路由表', () => {
  it('恰好 22 条页面路由', () => {
    expect(ROUTE_TABLE).toHaveLength(22);
    expect(EXPECTED_PATHS).toHaveLength(22);
  });

  it('路径与 prototype-v0 §2 的页面清单一一对应且无重复', () => {
    const paths = ROUTE_TABLE.map((route) => route.path);
    expect(paths).toEqual([...EXPECTED_PATHS]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('id 与页名唯一', () => {
    const ids = ROUTE_TABLE.map((route) => route.id);
    const pages = ROUTE_TABLE.map((route) => route.page);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it('路径全部是 kebab-case 且以 / 开头', () => {
    for (const route of ROUTE_TABLE) {
      expect(route.path).toMatch(KEBAB_PATH);
    }
  });

  it('功能域取值都在 NAV_DOMAINS 里', () => {
    for (const route of ROUTE_TABLE) {
      expect(NAV_DOMAINS).toContain(route.domain);
    }
  });

  it('按功能域分组不丢页面、不重复页面', () => {
    const grouped = routesByDomain().flatMap((group) => group.routes.map((route) => route.path));
    expect(grouped).toHaveLength(22);
    expect(new Set(grouped).size).toBe(22);
    for (const group of routesByDomain()) {
      expect(NAV_DOMAINS).toContain(group.domain as Domain);
    }
  });

  it('默认落地页在工作台', () => {
    expect(DEFAULT_ROUTE_PATH).toBe('/workbench');
    expect(ROUTE_TABLE.map((route) => route.path)).toContain(DEFAULT_ROUTE_PATH);
  });

  it('页面路由不会被 dev/preview 的 /api 代理吃掉', () => {
    expect(WEB_API_PROXY_PREFIX).toBe('/api/');
    for (const route of ROUTE_TABLE) {
      expect(route.path.startsWith(WEB_API_PROXY_PREFIX)).toBe(false);
    }
  });
});
