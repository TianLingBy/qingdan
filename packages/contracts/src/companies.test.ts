import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from './routes.js';
import {
  COMPANY_ROUTES,
  CompanyCodeSchema,
  CompanyCreateInputSchema,
  CompanySchema,
  CompanyUpdateInputSchema,
} from './companies.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule, validateRegistry } from './registry.js';

/**
 * 公司管理契约。
 *
 * 这些断言锁的是「公司端点契约签名」本身，不是实现：
 * 实现（repo / usecase / HTTP）由平台负责人按本文件落地，改签名必须先改这里并过评审。
 */

describe('公司契约（platform / company 功能域，D16/D44）', () => {
  it('3 条端点全部登记并汇总进 ROUTES，归属 platform、域为 company', () => {
    expect(COMPANY_ROUTES).toHaveLength(3);
    for (const route of COMPANY_ROUTES) {
      expect(route.module).toBe('platform');
      expect(route.domain).toBe('company');
    }

    const platformIds = routesOfModule(ROUTES, 'platform').map((r) => r.operationId);
    for (const route of COMPANY_ROUTES) expect(platformIds).toContain(route.operationId);
    expect(validateRegistry(ROUTES)).toEqual([]);
  });

  it('operationId / 方法 / 路径与契约一致', () => {
    const actual = COMPANY_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/companies platform.company.list',
        'POST /api/v1/companies platform.company.create',
        'PATCH /api/v1/companies/{id} platform.company.update',
      ].sort(),
    );
  });

  it('scope = company.<动作>；写操作必记审计、列表读不记（D51/D54②）', () => {
    const byId = new Map(COMPANY_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('platform.company.list')?.scope).toBe('company.read');
    expect(byId.get('platform.company.create')?.scope).toBe('company.create');
    expect(byId.get('platform.company.update')?.scope).toBe('company.update');

    expect(byId.get('platform.company.list')?.audit).toEqual({ kind: 'none', required: false });
    expect(byId.get('platform.company.create')?.audit).toEqual({ kind: 'write', required: true });
    expect(byId.get('platform.company.update')?.audit).toEqual({ kind: 'write', required: true });
  });

  it('更新带强 ETag；新建默认禁止 AI、改名允许（D54⑥）', () => {
    const byId = new Map(COMPANY_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('platform.company.list')?.requiresIfMatch).toBe(false);
    expect(byId.get('platform.company.update')?.requiresIfMatch).toBe(true);

    expect(byId.get('platform.company.list')?.ai).toEqual({ policy: 'allow', reasonRequired: false });
    expect(byId.get('platform.company.create')?.ai).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(byId.get('platform.company.update')?.ai).toEqual({ policy: 'allow', reasonRequired: false });
  });

  it('创建入参只收 name；公司码由服务端按 D16 发放、不可由客户端传入', () => {
    expect(CompanyCreateInputSchema.safeParse({ name: '北京轻单科技有限公司' }).success).toBe(true);
    expect(CompanyCreateInputSchema.safeParse({}).success).toBe(false);
    expect(CompanyCreateInputSchema.safeParse({ name: '' }).success).toBe(false);

    // D16：公司码服务端发放；strict 让误传直接失败，不静默丢弃。
    expect(CompanyCreateInputSchema.safeParse({ name: '北京公司', code: '0001' }).success).toBe(false);
    expect(CompanyCreateInputSchema.safeParse({ name: '北京公司', id: 'c1' }).success).toBe(false);
    expect(Object.keys(CompanyCreateInputSchema.shape)).not.toContain('code');
    expect(Object.keys(CompanyCreateInputSchema.shape)).not.toContain('id');
  });

  it('更新入参只收 name；公司码不可改', () => {
    expect(CompanyUpdateInputSchema.safeParse({ name: '改名后的公司' }).success).toBe(true);
    expect(CompanyUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(CompanyUpdateInputSchema.safeParse({ code: '0002' }).success).toBe(false);
    expect(CompanyUpdateInputSchema.safeParse({ name: '改名', code: '0002' }).success).toBe(false);
    expect(Object.keys(CompanyUpdateInputSchema.shape)).not.toContain('code');
  });

  it('公司码口径：4 位定长数字（0001~9999），不是任意字符串', () => {
    expect(CompanyCodeSchema.safeParse('0001').success).toBe(true);
    expect(CompanyCodeSchema.safeParse('9999').success).toBe(true);
    expect(CompanyCodeSchema.safeParse('1').success).toBe(false);
    expect(CompanyCodeSchema.safeParse('00001').success).toBe(false);
    expect(CompanyCodeSchema.safeParse('00a1').success).toBe(false);
    expect(CompanyCodeSchema.safeParse(1).success).toBe(false);
  });

  it('Company 实体已登记，含 code / version', () => {
    expect(ENTITIES.map((e) => e.name)).toContain('Company');
    expect(z.globalRegistry.has(CompanySchema)).toBe(true);
    expect(z.globalRegistry.get(CompanySchema)?.id).toBe('Company');

    const keys = Object.keys(CompanySchema.shape).sort();
    expect(keys).toEqual(['id', 'tenantId', 'code', 'name', 'version', 'createdAt', 'updatedAt'].sort());

    const doc = buildOpenApiDocument(ROUTES);
    const company = doc.components.schemas.Company as { properties: Record<string, unknown> };
    expect(company).toBeDefined();
    expect(company.properties).toHaveProperty('code');
    expect(company.properties).toHaveProperty('version');
  });

  it('OpenAPI 发射出公司端点与 x-module / x-scope / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);

    const collection = doc.paths['/api/v1/companies'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(collection).sort()).toEqual(['get', 'post']);
    expect(collection.get?.['x-scope']).toBe('company.read');
    expect(collection.post?.['x-module']).toBe('platform');
    expect(collection.post?.['x-scope']).toBe('company.create');
    expect(collection.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(collection.post?.['x-mcp-tool']).toBe('qingdan_platform_company_create');

    const detail = doc.paths['/api/v1/companies/{id}'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(detail)).toEqual(['patch']);
    expect(detail.patch?.['x-scope']).toBe('company.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);
  });
});
