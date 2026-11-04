import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from './routes.js';
import {
  SUPPLIER_ROUTES,
  SupplierCreateInputSchema,
  SupplierSchema,
  SupplierUpdateInputSchema,
} from './suppliers.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';

/**
 * 供应商资料契约（契约第一批 §2 / masterdata 第三切，照客户样板同构）。
 *
 * 这些断言锁的是「供应商契约签名」本身，不是实现：实现（迁移 / repo / usecase）
 * 由 masterdata 负责人按本文件落地，改签名必须先改这里并过评审。
 */
describe('供应商契约（masterdata）', () => {
  it('5 条端点全部登记并汇总进 ROUTES，且归属 masterdata', () => {
    expect(SUPPLIER_ROUTES).toHaveLength(5);
    for (const route of SUPPLIER_ROUTES) expect(route.module).toBe('masterdata');

    const masterdataIds = routesOfModule(ROUTES, 'masterdata').map((r) => r.operationId);
    for (const route of SUPPLIER_ROUTES) expect(masterdataIds).toContain(route.operationId);
  });

  it('operationId / 方法 / 路径与契约一致', () => {
    const actual = SUPPLIER_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/suppliers supplier.list.read',
        'POST /api/v1/suppliers supplier.create',
        'GET /api/v1/suppliers/{id} supplier.detail.read',
        'PATCH /api/v1/suppliers/{id} supplier.update',
        'DELETE /api/v1/suppliers/{id} supplier.delete',
      ].sort(),
    );
  });

  it('权限 scope = supplier.<动作>，普通读不记审计、写必记（D51/D54）', () => {
    const byId = new Map(SUPPLIER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('supplier.list.read')?.scope).toBe('supplier.read');
    expect(byId.get('supplier.detail.read')?.scope).toBe('supplier.read');
    expect(byId.get('supplier.create')?.scope).toBe('supplier.create');
    expect(byId.get('supplier.update')?.scope).toBe('supplier.update');
    expect(byId.get('supplier.delete')?.scope).toBe('supplier.delete');

    expect(byId.get('supplier.list.read')?.audit.kind).toBe('none');
    expect(byId.get('supplier.detail.read')?.audit.kind).toBe('none');
    for (const id of ['supplier.create', 'supplier.update', 'supplier.delete']) {
      expect(byId.get(id)?.audit).toEqual({ kind: 'write', required: true });
    }
  });

  it('写接口带强 ETag 前置条件；停用禁止 AI（D52①/D60③）', () => {
    const byId = new Map(SUPPLIER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('supplier.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('supplier.delete')?.requiresIfMatch).toBe(true);
    expect(byId.get('supplier.delete')?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(byId.get('supplier.create')?.ai.policy).toBe('allow');
    expect(byId.get('supplier.update')?.ai.policy).toBe('allow');
  });

  it('实体字段与契约一致，且不挂任何金额字段（供应商无金额字段）', () => {
    const keys = Object.keys(SupplierSchema.shape).sort();
    expect(keys).toEqual(
      [
        'id',
        'tenantId',
        'companyId',
        'supplierNo',
        'name',
        'contactName',
        'contactPhone',
        'suppliedMaterials',
        'status',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    // 反向锁：供应商档案不带金额/欠款，防止「顺手加列」。
    expect(keys).not.toContain('balance');
    expect(keys).not.toContain('payable');
  });

  it('Supplier 实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    expect(ENTITIES.map((e) => e.name)).toContain('Supplier');
    expect(z.globalRegistry.has(SupplierSchema)).toBe(true);
    expect(z.globalRegistry.get(SupplierSchema)?.id).toBe('Supplier');

    const doc = buildOpenApiDocument(ROUTES);
    const supplier = doc.components.schemas.Supplier as { properties: Record<string, unknown> };
    expect(supplier).toBeDefined();
    expect(supplier.properties).toHaveProperty('supplierNo');
    expect(supplier.properties).toHaveProperty('suppliedMaterials');
    // 反向锁：供应商无金额字段，防止「顺手加列」。
    expect(supplier.properties).not.toHaveProperty('balance');
  });

  it('supplierNo 自由文本可空（D49）；suppliedMaterials 最多 20 项、每项 1-64 字', () => {
    const base = {
      id: 's1',
      tenantId: 't1',
      companyId: 'co1',
      supplierNo: null,
      name: '李四原料',
      contactName: '李四',
      contactPhone: '13900000000',
      suppliedMaterials: ['面粉', '白糖'],
      status: '启用',
      version: 1,
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
    };
    expect(SupplierSchema.safeParse(base).success).toBe(true);
    expect(SupplierSchema.safeParse({ ...base, supplierNo: '随便填-S001' }).success).toBe(true);
    expect(SupplierSchema.safeParse({ ...base, supplierNo: null }).success).toBe(true);
    expect(SupplierSchema.safeParse({ ...base, suppliedMaterials: [] }).success).toBe(true);

    expect(
      SupplierSchema.safeParse({
        ...base,
        suppliedMaterials: Array.from({ length: 20 }, (_, i) => `物料${i}`),
      }).success,
    ).toBe(true);
    expect(
      SupplierSchema.safeParse({
        ...base,
        suppliedMaterials: Array.from({ length: 21 }, (_, i) => `物料${i}`),
      }).success,
    ).toBe(false);
    expect(SupplierSchema.safeParse({ ...base, suppliedMaterials: [''] }).success).toBe(false);
    expect(SupplierSchema.safeParse({ ...base, suppliedMaterials: ['x'.repeat(65)] }).success).toBe(false);
  });

  it('创建必须给公司 + 名称（供货物料默认空数组）；更新至少改一个字段且不可换公司', () => {
    const companyId = '00000000-0000-4000-8000-000000000001';
    const created = SupplierCreateInputSchema.safeParse({ companyId, name: '李四原料' });
    expect(created.success).toBe(true);
    expect(created.success && created.data.suppliedMaterials).toEqual([]);
    expect(SupplierCreateInputSchema.safeParse({ name: '李四原料' }).success).toBe(false);
    expect(SupplierUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(SupplierUpdateInputSchema.safeParse({ name: '改名' }).success).toBe(true);
    // companyId 不在更新入参里：换公司 = 新供应商。
    expect(Object.keys(SupplierUpdateInputSchema.shape)).not.toContain('companyId');
  });

  it('OpenAPI 发射出供应商端点与 x-module / x-scope / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);
    const suppliers = doc.paths['/api/v1/suppliers'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(suppliers).sort()).toEqual(['get', 'post']);
    expect(suppliers.get?.['x-module']).toBe('masterdata');
    expect(suppliers.post?.['x-scope']).toBe('supplier.create');
    expect(suppliers.post?.['x-mcp-tool']).toBe('qingdan_supplier_create');

    const detail = doc.paths['/api/v1/suppliers/{id}'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(detail).sort()).toEqual(['delete', 'get', 'patch']);
    expect(detail.patch?.['x-scope']).toBe('supplier.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);
    expect(detail.delete?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
  });
});
