import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from './routes.js';
import {
  CUSTOMER_ROUTES,
  CustomerCreateInputSchema,
  CustomerSchema,
  CustomerUpdateInputSchema,
} from './customers.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';

/**
 * 客户资料契约（契约第一批 §2 / masterdata 第二切，照商品样板同构）。
 *
 * 这些断言锁的是「客户契约签名」本身，不是实现：实现（迁移 / repo / usecase）
 * 由 masterdata 负责人按本文件落地，改签名必须先改这里并过评审。
 */
describe('客户契约（masterdata）', () => {
  it('5 条端点全部登记并汇总进 ROUTES，且归属 masterdata', () => {
    expect(CUSTOMER_ROUTES).toHaveLength(5);
    for (const route of CUSTOMER_ROUTES) expect(route.module).toBe('masterdata');

    const masterdataIds = routesOfModule(ROUTES, 'masterdata').map((r) => r.operationId);
    for (const route of CUSTOMER_ROUTES) expect(masterdataIds).toContain(route.operationId);
  });

  it('operationId / 方法 / 路径与契约一致', () => {
    const actual = CUSTOMER_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/customers customer.list.read',
        'POST /api/v1/customers customer.create',
        'GET /api/v1/customers/{id} customer.detail.read',
        'PATCH /api/v1/customers/{id} customer.update',
        'DELETE /api/v1/customers/{id} customer.delete',
      ].sort(),
    );
  });

  it('权限 scope = customer.<动作>，普通读不记审计、写必记（D51/D54）', () => {
    const byId = new Map(CUSTOMER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('customer.list.read')?.scope).toBe('customer.read');
    expect(byId.get('customer.detail.read')?.scope).toBe('customer.read');
    expect(byId.get('customer.create')?.scope).toBe('customer.create');
    expect(byId.get('customer.update')?.scope).toBe('customer.update');
    expect(byId.get('customer.delete')?.scope).toBe('customer.delete');

    expect(byId.get('customer.list.read')?.audit.kind).toBe('none');
    expect(byId.get('customer.detail.read')?.audit.kind).toBe('none');
    for (const id of ['customer.create', 'customer.update', 'customer.delete']) {
      expect(byId.get(id)?.audit).toEqual({ kind: 'write', required: true });
    }
  });

  it('写接口带强 ETag 前置条件；停用禁止 AI（D52①/D60③）', () => {
    const byId = new Map(CUSTOMER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('customer.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('customer.delete')?.requiresIfMatch).toBe(true);
    expect(byId.get('customer.delete')?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(byId.get('customer.create')?.ai.policy).toBe('allow');
    expect(byId.get('customer.update')?.ai.policy).toBe('allow');
  });

  it('实体字段与契约一致，且不挂任何金额字段（客户无看价逻辑）', () => {
    const keys = Object.keys(CustomerSchema.shape).sort();
    expect(keys).toEqual(
      [
        'id',
        'tenantId',
        'companyId',
        'customerNo',
        'name',
        'contactName',
        'contactPhone',
        'creditTermDays',
        'status',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    // 反向锁：客户没有金额/看价逻辑，防止「顺手加列」。
    expect(keys).not.toContain('defaultSalePrice');
    expect(keys).not.toContain('balance');
  });

  it('Customer 实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    expect(ENTITIES.map((e) => e.name)).toContain('Customer');
    expect(z.globalRegistry.has(CustomerSchema)).toBe(true);
    expect(z.globalRegistry.get(CustomerSchema)?.id).toBe('Customer');

    const doc = buildOpenApiDocument(ROUTES);
    const customer = doc.components.schemas.Customer as { properties: Record<string, unknown> };
    expect(customer).toBeDefined();
    expect(customer.properties).toHaveProperty('customerNo');
    expect(customer.properties).toHaveProperty('creditTermDays');
    // 反向锁：客户无金额/看价逻辑，防止「顺手加列」。
    expect(customer.properties).not.toHaveProperty('defaultSalePrice');
  });

  it('customerNo 自由文本可空（D49）；creditTermDays 为整数天、>=0、可空', () => {
    const base = {
      id: 'c1',
      tenantId: 't1',
      companyId: 'co1',
      customerNo: null,
      name: '张三商贸',
      contactName: '张三',
      contactPhone: '13800000000',
      creditTermDays: 30,
      status: '启用',
      version: 1,
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
    };
    expect(CustomerSchema.safeParse(base).success).toBe(true);
    expect(CustomerSchema.safeParse({ ...base, customerNo: '随便填-001' }).success).toBe(true);
    expect(CustomerSchema.safeParse({ ...base, customerNo: null }).success).toBe(true);
    expect(CustomerSchema.safeParse({ ...base, creditTermDays: null }).success).toBe(true);
    expect(CustomerSchema.safeParse({ ...base, creditTermDays: 0 }).success).toBe(true);
    expect(CustomerSchema.safeParse({ ...base, creditTermDays: -1 }).success).toBe(false);
    expect(CustomerSchema.safeParse({ ...base, creditTermDays: 1.5 }).success).toBe(false);
  });

  it('创建必须给公司 + 名称；更新至少改一个字段且不可换公司', () => {
    expect(
      CustomerCreateInputSchema.safeParse({ companyId: '00000000-0000-4000-8000-000000000001', name: '张三商贸' })
        .success,
    ).toBe(true);
    expect(CustomerCreateInputSchema.safeParse({ name: '张三商贸' }).success).toBe(false);
    expect(CustomerUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(CustomerUpdateInputSchema.safeParse({ name: '改名' }).success).toBe(true);
    // companyId 不在更新入参里：换公司 = 新客户。
    expect(Object.keys(CustomerUpdateInputSchema.shape)).not.toContain('companyId');
  });

  it('OpenAPI 发射出客户端点与 x-module / x-scope / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);
    const customers = doc.paths['/api/v1/customers'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(customers).sort()).toEqual(['get', 'post']);
    expect(customers.get?.['x-module']).toBe('masterdata');
    expect(customers.post?.['x-scope']).toBe('customer.create');
    expect(customers.post?.['x-mcp-tool']).toBe('qingdan_customer_create');

    const detail = doc.paths['/api/v1/customers/{id}'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(detail).sort()).toEqual(['delete', 'get', 'patch']);
    expect(detail.patch?.['x-scope']).toBe('customer.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);
    expect(detail.delete?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
  });
});
