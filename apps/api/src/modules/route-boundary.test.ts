import { MODULE_KEYS, ROUTES, modulesOf, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { testConfig } from '../platform/config.js';
import { MOUNTED_MODULE_KEYS } from './index.js';

/** D70 静态边界：跨模块 import 的落点必须仍在 `src/modules/<模块>/` 下。 */
const OTHER_MODULE_RE = /[\\/]modules[\\/]([a-z-]+)[\\/]/;

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

/**
 * 路由挂载边界（Issue #15 / D62）。
 *
 * 核心不变量：**注册表里出现的每个模块都必须已接线**；platform 只挂自己的路由，
 * 业务模块（masterdata）的端点不得被 platform 的循环顺手接管。
 */

const PRODUCT_CASES = [
  { method: 'GET', url: '/api/v1/products', operationId: 'product.list.read' },
  { method: 'POST', url: '/api/v1/products', operationId: 'product.create', payload: { name: '测试商品' } },
  { method: 'GET', url: '/api/v1/products/prod-1', operationId: 'product.detail.read' },
  {
    method: 'PATCH',
    url: '/api/v1/products/prod-1',
    operationId: 'product.update',
    payload: { name: '改名' },
  },
  { method: 'DELETE', url: '/api/v1/products/prod-1', operationId: 'product.delete' },
] as const;

const INVENTORY_CASES = [
  { method: 'GET', url: '/api/v1/inventory/batches', operationId: 'inventory.batch.list.read' },
  {
    method: 'GET',
    url: '/api/v1/inventory/batches/batch-1',
    operationId: 'inventory.batch.detail.read',
  },
  { method: 'GET', url: '/api/v1/inventory/flows', operationId: 'inventory.flow.read' },
] as const;

const SALES_CASES = [
  { method: 'GET', url: '/api/v1/sales-orders', operationId: 'sales.order.list.read' },
  { method: 'POST', url: '/api/v1/sales-orders', operationId: 'sales.order.create' },
  { method: 'GET', url: '/api/v1/sales-orders/so-1', operationId: 'sales.order.detail.read' },
  { method: 'PATCH', url: '/api/v1/sales-orders/so-1', operationId: 'sales.order.update' },
  { method: 'POST', url: '/api/v1/sales-orders/so-1/cancel', operationId: 'sales.order.cancel' },
] as const;

const PURCHASE_CASES = [
  { method: 'GET', url: '/api/v1/purchase-orders', operationId: 'purchase.order.list.read' },
  { method: 'POST', url: '/api/v1/purchase-orders', operationId: 'purchase.order.create' },
  { method: 'GET', url: '/api/v1/purchase-orders/po-1', operationId: 'purchase.order.detail.read' },
  { method: 'PATCH', url: '/api/v1/purchase-orders/po-1', operationId: 'purchase.order.update' },
  {
    method: 'POST',
    url: '/api/v1/purchase-orders/po-1/cancel',
    operationId: 'purchase.order.cancel',
  },
] as const;

const PROCESSING_CASES = [
  { method: 'GET', url: '/api/v1/processing-orders', operationId: 'processing.order.list.read' },
  { method: 'POST', url: '/api/v1/processing-orders', operationId: 'processing.order.create' },
  {
    method: 'GET',
    url: '/api/v1/processing-orders/bo-1',
    operationId: 'processing.order.detail.read',
  },
  { method: 'PATCH', url: '/api/v1/processing-orders/bo-1', operationId: 'processing.order.update' },
  {
    method: 'POST',
    url: '/api/v1/processing-orders/bo-1/cancel',
    operationId: 'processing.order.cancel',
  },
] as const;

const INTERNAL_TRADE_CASES = [
  { method: 'GET', url: '/api/v1/internal-trade-orders', operationId: 'internal_trade.order.list.read' },
  { method: 'POST', url: '/api/v1/internal-trade-orders', operationId: 'internal_trade.order.create' },
  {
    method: 'GET',
    url: '/api/v1/internal-trade-orders/nt-1',
    operationId: 'internal_trade.order.detail.read',
  },
  {
    method: 'PATCH',
    url: '/api/v1/internal-trade-orders/nt-1',
    operationId: 'internal_trade.order.update',
  },
  {
    method: 'POST',
    url: '/api/v1/internal-trade-orders/nt-1/cancel',
    operationId: 'internal_trade.order.cancel',
  },
] as const;

const SETTLEMENT_CASES = [
  { method: 'GET', url: '/api/v1/settlement-orders', operationId: 'settlement.order.list.read' },
  {
    method: 'GET',
    url: '/api/v1/settlement-orders/ct-1',
    operationId: 'settlement.order.detail.read',
  },
  {
    method: 'POST',
    url: '/api/v1/settlement-orders/ct-1/confirm',
    operationId: 'settlement.order.confirm',
  },
] as const;

describe('路由挂载边界（platform / masterdata / inventory / sales / purchase / processing / internal-trade / settlement）', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp({ config: testConfig(), version: '9.9.9' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('ROUTES 里的每个 module 都已接线（无孤儿路由），并列出其余未接线模块', () => {
    const mounted = new Set<string>(MOUNTED_MODULE_KEYS);
    const registered = modulesOf(ROUTES);
    const orphans = registered.filter((module) => !mounted.has(module));

    expect(orphans, `ROUTES 里出现但未接线的模块：${orphans.join(', ') || '（无）'}`).toEqual([]);

    // 契约登记的全部模块中，尚未接线的模块（随模块开发逐项减少，改动时请显式更新）。
    const notYetMounted = MODULE_KEYS.filter((module) => !mounted.has(module));
    expect(notYetMounted).toEqual(['test']);
  });

  it('3 个 inventory 只读端点全部由 inventory 骨架挂载 → 501 NOT_IMPLEMENTED', async () => {
    for (const testCase of INVENTORY_CASES) {
      const response = await app.inject({ method: testCase.method, url: testCase.url });

      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(501);
      const body = response.json() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe('NOT_IMPLEMENTED');
      expect(body.message).toContain(testCase.operationId);
      expect(body.details).toMatchObject({ operationId: testCase.operationId });
    }
  });

  it('5 个 sales 端点全部由 sales 骨架挂载 → 501 NOT_IMPLEMENTED', async () => {
    for (const testCase of SALES_CASES) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: { 'if-match': '"1"' },
      });

      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(501);
      const body = response.json() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe('NOT_IMPLEMENTED');
      expect(body.message).toContain(testCase.operationId);
      expect(body.details).toMatchObject({ operationId: testCase.operationId });
    }
  });

  it('5 个 purchase 端点全部由 purchase 骨架挂载 → 501 NOT_IMPLEMENTED', async () => {
    for (const testCase of PURCHASE_CASES) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: { 'if-match': '"1"' },
      });

      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(501);
      const body = response.json() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe('NOT_IMPLEMENTED');
      expect(body.message).toContain(testCase.operationId);
      expect(body.details).toMatchObject({ operationId: testCase.operationId });
    }
  });

  it('5 个 processing 端点全部由 processing 骨架挂载 → 501 NOT_IMPLEMENTED', async () => {
    for (const testCase of PROCESSING_CASES) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: { 'if-match': '"1"' },
      });

      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(501);
      const body = response.json() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe('NOT_IMPLEMENTED');
      expect(body.message).toContain(testCase.operationId);
      expect(body.details).toMatchObject({ operationId: testCase.operationId });
    }
  });

  it('5 个 internal-trade 端点全部由 internal-trade 骨架挂载 → 501 NOT_IMPLEMENTED', async () => {
    for (const testCase of INTERNAL_TRADE_CASES) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: { 'if-match': '"1"' },
      });

      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(501);
      const body = response.json() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe('NOT_IMPLEMENTED');
      expect(body.message).toContain(testCase.operationId);
      expect(body.details).toMatchObject({ operationId: testCase.operationId });
    }
  });

  it('3 个 settlement 端点全部由 settlement 骨架挂载 → 501 NOT_IMPLEMENTED', async () => {
    for (const testCase of SETTLEMENT_CASES) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: { 'if-match': '"1"' },
      });

      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(501);
      const body = response.json() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe('NOT_IMPLEMENTED');
      expect(body.message).toContain(testCase.operationId);
      expect(body.details).toMatchObject({ operationId: testCase.operationId });
    }
  });

  it('5 个商品端点全部由 masterdata 挂载 → 501 NOT_IMPLEMENTED，operationId 正确', async () => {
    for (const testCase of PRODUCT_CASES) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: { 'if-match': '"1"' },
        ...('payload' in testCase ? { payload: testCase.payload } : {}),
      });

      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(501);
      const body = response.json() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe('NOT_IMPLEMENTED');
      expect(body.message).toContain(testCase.operationId);
      expect(body.details).toMatchObject({ operationId: testCase.operationId });
    }
  });

  it("routesOfModule(ROUTES, 'platform') 不含任何 product.* 路由", () => {
    const platformRoutes = routesOfModule(ROUTES, 'platform');
    expect(platformRoutes.map((route) => route.operationId).filter((id) => id.startsWith('product.'))).toEqual(
      [],
    );
    expect(platformRoutes.every((route) => route.module === 'platform')).toBe(true);
  });

  it('GET /api/v1/openapi.json 的商品操作带 x-module=masterdata', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(response.statusCode).toBe(200);

    const document = response.json() as {
      paths: Record<string, Record<string, { operationId: string; 'x-module'?: string }>>;
    };
    const products = document.paths['/api/v1/products'];
    expect(products?.get?.operationId).toBe('product.list.read');
    expect(products?.get?.['x-module']).toBe('masterdata');
    expect(products?.post?.operationId).toBe('product.create');
    expect(products?.post?.['x-module']).toBe('masterdata');
  });

  it('platform 端点仍正常挂载：GET /api/v1/health → 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: '9.9.9' });
  });

  it('D70 边界：业务模块不跨模块 import 对方的 repo / schema', () => {
    const modulesRoot = fileURLToPath(new URL('.', import.meta.url));
    const violations: string[] = [];

    for (const moduleName of MOUNTED_MODULE_KEYS) {
      if (moduleName === 'platform') continue;
      const moduleDir = path.join(modulesRoot, moduleName);
      for (const file of listSourceFiles(moduleDir)) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/from '([^']+)'/g)) {
          const specifier = match[1]!;
          if (!specifier.startsWith('.')) continue;
          const resolved = path.resolve(path.dirname(file), specifier);
          const other = OTHER_MODULE_RE.exec(resolved);
          if (!other) continue;
          const targetModule = other[1]!;
          if (targetModule === moduleName || targetModule === 'platform') continue;
          if (/(?:^|\/)(?:repo|schema)(?:\.js)?$/.test(
            resolved.replace(/\\/g, '/').replace(new RegExp(`^.*/modules/${targetModule}/`), ''),
          )) {
            violations.push(`${path.relative(modulesRoot, file)} → ${targetModule}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
