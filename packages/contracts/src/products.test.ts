import { describe, expect, it } from 'vitest';
import { ROUTES } from './routes.js';
import { PRODUCT_ROUTES, ProductSchema } from './products.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';

/**
 * 商品资料契约（Issue #15 / masterdata 首切）。
 *
 * 这些断言锁的是「主数据契约签名」本身，不是实现：实现（迁移 / repo / usecase）
 * 由 masterdata 负责人按本文件落地，改签名必须先改这里并过评审。
 */
describe('商品契约（masterdata）', () => {
  it('5 条端点全部登记，且归属 masterdata', () => {
    expect(PRODUCT_ROUTES).toHaveLength(5);
    for (const route of PRODUCT_ROUTES) expect(route.module).toBe('masterdata');
    expect(routesOfModule(ROUTES, 'masterdata')).toHaveLength(5);
  });

  it('operationId / 方法 / 路径与契约一致', () => {
    const actual = PRODUCT_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/products product.list.read',
        'POST /api/v1/products product.create',
        'GET /api/v1/products/{id} product.detail.read',
        'PATCH /api/v1/products/{id} product.update',
        'DELETE /api/v1/products/{id} product.delete',
      ].sort(),
    );
  });

  it('权限 scope = product.<动作>，普通读不记审计、写必记（D51/D54）', () => {
    const byId = new Map(PRODUCT_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('product.list.read')?.scope).toBe('product.read');
    expect(byId.get('product.detail.read')?.scope).toBe('product.read');
    expect(byId.get('product.create')?.scope).toBe('product.create');
    expect(byId.get('product.update')?.scope).toBe('product.update');
    expect(byId.get('product.delete')?.scope).toBe('product.delete');

    expect(byId.get('product.list.read')?.audit.kind).toBe('none');
    expect(byId.get('product.detail.read')?.audit.kind).toBe('none');
    for (const id of ['product.create', 'product.update', 'product.delete']) {
      expect(byId.get(id)?.audit).toEqual({ kind: 'write', required: true });
    }
  });

  it('写接口带强 ETag 前置条件；停用禁止 AI（D52①/D60③）', () => {
    const byId = new Map(PRODUCT_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('product.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('product.delete')?.requiresIfMatch).toBe(true);
    expect(byId.get('product.delete')?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(byId.get('product.create')?.ai.policy).toBe('allow');
    expect(byId.get('product.update')?.ai.policy).toBe('allow');
  });

  it('Product 实体已登记（OpenAPI components.schemas 与 ENTITIES 一一对应）', () => {
    expect(ENTITIES.map((e) => e.name)).toContain('Product');
    const doc = buildOpenApiDocument(ROUTES);
    const product = doc.components.schemas.Product as { properties: Record<string, unknown> };
    expect(product.properties).toHaveProperty('defaultSalePrice');
    expect(product.properties).toHaveProperty('productNo');
    // D5：成本不挂商品，只能在批次上——这里做反向锁，防止「顺手加列」。
    expect(product.properties).not.toHaveProperty('cost');
    expect(product.properties).not.toHaveProperty('costPrice');
  });

  it('默认售价是 decimal 字符串且可为 null（无看价权限时置 null，D54/D27）', () => {
    const parsed = ProductSchema.safeParse({
      id: 'p1',
      tenantId: 't1',
      companyId: 'c1',
      productNo: null,
      name: '五花肉',
      aliases: ['三层肉'],
      specification: '20kg/箱',
      unit: '箱',
      status: '启用',
      defaultSalePrice: null,
      version: 1,
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    const product = parsed.success ? parsed.data : undefined;
    // number 不是合法金额：金额一律 decimal 字符串（D54），防止前端把 12.5 直接塞进来。
    expect(ProductSchema.safeParse({ ...product, defaultSalePrice: 12.5 }).success).toBe(false);
  });

  it('OpenAPI 发射出商品端点与 x-module / x-scope 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);
    const products = doc.paths['/api/v1/products'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(products).sort()).toEqual(['get', 'post']);
    expect(products.get?.['x-module']).toBe('masterdata');
    expect(products.post?.['x-scope']).toBe('product.create');
    expect(products.post?.['x-mcp-tool']).toBe('qingdan_product_create');
  });
});
