import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from './routes.js';
import {
  PROCESSOR_ROUTES,
  ProcessorCreateInputSchema,
  ProcessorQuoteCreateInputSchema,
  ProcessorQuoteSchema,
  ProcessorSchema,
  ProcessorUpdateInputSchema,
} from './processors.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';

/**
 * 加工厂 + 加工厂报价记录契约（契约第一批 §2 / D64 / masterdata 第四切）。
 *
 * 这些断言锁的是「契约签名」本身，不是实现：实现（迁移 / repo / usecase）
 * 由 masterdata 负责人按本文件落地，改签名必须先改这里并过评审。
 */
describe('加工厂契约（masterdata）', () => {
  it('7 条端点全部登记并汇总进 ROUTES，且归属 masterdata', () => {
    expect(PROCESSOR_ROUTES).toHaveLength(7);
    for (const route of PROCESSOR_ROUTES) expect(route.module).toBe('masterdata');

    const masterdataIds = routesOfModule(ROUTES, 'masterdata').map((r) => r.operationId);
    for (const route of PROCESSOR_ROUTES) expect(masterdataIds).toContain(route.operationId);
  });

  it('operationId / 方法 / 路径与契约一致', () => {
    const actual = PROCESSOR_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/processors processor.list.read',
        'POST /api/v1/processors processor.create',
        'GET /api/v1/processors/{id} processor.detail.read',
        'PATCH /api/v1/processors/{id} processor.update',
        'DELETE /api/v1/processors/{id} processor.delete',
        'GET /api/v1/processor-quotes processor.quote.read',
        'POST /api/v1/processor-quotes processor.quote.create',
      ].sort(),
    );
  });

  it('权限 scope = processor.<动作>，普通读不记审计、写必记（D51/D54）', () => {
    const byId = new Map(PROCESSOR_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('processor.list.read')?.scope).toBe('processor.read');
    expect(byId.get('processor.detail.read')?.scope).toBe('processor.read');
    expect(byId.get('processor.quote.read')?.scope).toBe('processor.read');
    expect(byId.get('processor.create')?.scope).toBe('processor.create');
    expect(byId.get('processor.update')?.scope).toBe('processor.update');
    expect(byId.get('processor.delete')?.scope).toBe('processor.delete');
    expect(byId.get('processor.quote.create')?.scope).toBe('processor.create');

    expect(byId.get('processor.list.read')?.audit.kind).toBe('none');
    expect(byId.get('processor.detail.read')?.audit.kind).toBe('none');
    expect(byId.get('processor.quote.read')?.audit.kind).toBe('none');
    for (const id of ['processor.create', 'processor.update', 'processor.delete', 'processor.quote.create']) {
      expect(byId.get(id)?.audit).toEqual({ kind: 'write', required: true });
    }
  });

  it('写接口带强 ETag 前置条件；停用禁止 AI（D52①/D60③）', () => {
    const byId = new Map(PROCESSOR_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('processor.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('processor.delete')?.requiresIfMatch).toBe(true);
    expect(byId.get('processor.delete')?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(byId.get('processor.create')?.ai.policy).toBe('allow');
    expect(byId.get('processor.update')?.ai.policy).toBe('allow');
    expect(byId.get('processor.quote.create')?.ai.policy).toBe('allow');
  });

  it('报价记录只提供 list + create，不提供 update / delete（D64 ④ 只增不改）', () => {
    const quoteRoutes = PROCESSOR_ROUTES.filter((r) => r.path === '/api/v1/processor-quotes');
    expect(quoteRoutes.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    expect(quoteRoutes.map((r) => r.operationId).sort()).toEqual([
      'processor.quote.create',
      'processor.quote.read',
    ]);
    // 反向锁：不能出现任何改/删报价历史的端点。
    expect(PROCESSOR_ROUTES.some((r) => r.path.startsWith('/api/v1/processor-quotes/'))).toBe(false);
  });

  it('Processor 主表只存基础资料（D64 ①），不挂历史价/比价字段', () => {
    const keys = Object.keys(ProcessorSchema.shape).sort();
    expect(keys).toEqual(
      [
        'id',
        'tenantId',
        'companyId',
        'processorNo',
        'name',
        'contactName',
        'status',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    // 反向锁：历史加工价 / 比价记录由 processor_quote 承载，主表不得顺手加列。
    expect(keys).not.toContain('historyPrice');
    expect(keys).not.toContain('lastPrice');
    expect(keys).not.toContain('quotes');
  });

  it('ProcessorQuote 字段与 D64 一致，单价 decimal 最多 6 位、日期为 yyyy-mm-dd', () => {
    const keys = Object.keys(ProcessorQuoteSchema.shape).sort();
    expect(keys).toEqual(
      [
        'id',
        'tenantId',
        'companyId',
        'processorId',
        'quoteDate',
        'processName',
        'unitPrice',
        'remark',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );

    const base = {
      id: 'q1',
      tenantId: 't1',
      companyId: 'co1',
      processorId: 'p1',
      quoteDate: '2026-11-05',
      processName: '切割',
      unitPrice: '12.5',
      remark: null,
      version: 1,
      createdAt: '2026-11-05T00:00:00.000Z',
      updatedAt: '2026-11-05T00:00:00.000Z',
    };
    expect(ProcessorQuoteSchema.safeParse(base).success).toBe(true);
    expect(ProcessorQuoteSchema.safeParse({ ...base, unitPrice: '12' }).success).toBe(true);
    expect(ProcessorQuoteSchema.safeParse({ ...base, unitPrice: '12.345678' }).success).toBe(true);
    expect(ProcessorQuoteSchema.safeParse({ ...base, unitPrice: '12.3456789' }).success).toBe(false);
    expect(ProcessorQuoteSchema.safeParse({ ...base, unitPrice: '-1' }).success).toBe(false);
    expect(ProcessorQuoteSchema.safeParse({ ...base, unitPrice: 'abc' }).success).toBe(false);
    expect(ProcessorQuoteSchema.safeParse({ ...base, quoteDate: '2026/11/05' }).success).toBe(false);
    expect(ProcessorQuoteSchema.safeParse({ ...base, quoteDate: '2026-13-01' }).success).toBe(false);
    expect(ProcessorQuoteSchema.safeParse({ ...base, remark: '备注' }).success).toBe(true);
  });

  it('Processor / ProcessorQuote 均登记（ENTITIES / globalRegistry / components.schemas）', () => {
    const names = ENTITIES.map((e) => e.name);
    expect(names).toContain('Processor');
    expect(names).toContain('ProcessorQuote');

    expect(z.globalRegistry.has(ProcessorSchema)).toBe(true);
    expect(z.globalRegistry.get(ProcessorSchema)?.id).toBe('Processor');
    expect(z.globalRegistry.has(ProcessorQuoteSchema)).toBe(true);
    expect(z.globalRegistry.get(ProcessorQuoteSchema)?.id).toBe('ProcessorQuote');

    const doc = buildOpenApiDocument(ROUTES);
    const processor = doc.components.schemas.Processor as { properties: Record<string, unknown> };
    const quote = doc.components.schemas.ProcessorQuote as { properties: Record<string, unknown> };
    expect(processor).toBeDefined();
    expect(quote).toBeDefined();
    expect(processor.properties).toHaveProperty('processorNo');
    expect(processor.properties).not.toHaveProperty('historyPrice');
    expect(quote.properties).toHaveProperty('processorId');
    expect(quote.properties).toHaveProperty('quoteDate');
    expect(quote.properties).toHaveProperty('unitPrice');
  });

  it('创建必须给公司 + 名称；更新至少改一个字段且不可换公司；报价入参必填工序/日期/单价', () => {
    const companyId = '00000000-0000-4000-8000-000000000001';
    expect(ProcessorCreateInputSchema.safeParse({ companyId, name: '王五加工厂' }).success).toBe(true);
    expect(ProcessorCreateInputSchema.safeParse({ name: '王五加工厂' }).success).toBe(false);
    expect(ProcessorCreateInputSchema.safeParse({ companyId, name: '' }).success).toBe(false);

    expect(ProcessorUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(ProcessorUpdateInputSchema.safeParse({ name: '改名' }).success).toBe(true);
    // companyId 不在更新入参里：换公司 = 新加工厂。
    expect(Object.keys(ProcessorUpdateInputSchema.shape)).not.toContain('companyId');

    const quote = {
      companyId,
      processorId: 'p1',
      quoteDate: '2026-11-05',
      processName: '切割',
      unitPrice: '12.5',
    };
    expect(ProcessorQuoteCreateInputSchema.safeParse(quote).success).toBe(true);
    for (const key of ['processorId', 'quoteDate', 'processName', 'unitPrice'] as const) {
      const missing = { ...quote } as Record<string, unknown>;
      delete missing[key];
      expect(ProcessorQuoteCreateInputSchema.safeParse(missing).success, key).toBe(false);
    }
  });

  it('OpenAPI 发射出加工厂 / 报价端点与 x-module / x-scope / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);
    const processors = doc.paths['/api/v1/processors'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(processors).sort()).toEqual(['get', 'post']);
    expect(processors.get?.['x-module']).toBe('masterdata');
    expect(processors.post?.['x-scope']).toBe('processor.create');
    expect(processors.post?.['x-mcp-tool']).toBe('qingdan_processor_create');

    const detail = doc.paths['/api/v1/processors/{id}'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(detail).sort()).toEqual(['delete', 'get', 'patch']);
    expect(detail.patch?.['x-scope']).toBe('processor.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);
    expect(detail.delete?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });

    const quotes = doc.paths['/api/v1/processor-quotes'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(quotes).sort()).toEqual(['get', 'post']);
    expect(quotes.post?.['x-scope']).toBe('processor.create');
    expect(quotes.post?.['x-mcp-tool']).toBe('qingdan_processor_quote_create');
    const queryNames = (quotes.get?.parameters as Array<{ name: string }>).map((p) => p.name).sort();
    expect(queryNames).toEqual(['cursor', 'from', 'limit', 'processName', 'processorId', 'to']);
  });
});
