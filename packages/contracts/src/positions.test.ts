import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from './routes.js';
import {
  POSITION_PRESET_KEYS,
  POSITION_ROUTES,
  PositionActionsSchema,
  PositionCreateInputSchema,
  PositionListQuerySchema,
  PositionSchema,
  PositionUpdateInputSchema,
} from './positions.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule, validateRegistry } from './registry.js';

/**
 * 岗位（权限模板）契约。
 *
 * 这些断言锁的是「岗位端点契约签名」本身，不是实现：
 * 实现（repo / usecase / HTTP）由平台负责人按本文件落地，改签名必须先改这里并过评审。
 */

const ID = '00000000-0000-4000-8000-000000000002';

const validActions = [{ domain: 'sales', actions: ['read', 'create'] }];

const validCreate = { name: '销售', actions: validActions };

describe('岗位契约（platform / permission 功能域，D4/D44/D60②）', () => {
  it('4 条端点全部登记并汇总进 ROUTES，归属 platform、域为 permission', () => {
    expect(POSITION_ROUTES).toHaveLength(4);
    for (const route of POSITION_ROUTES) {
      expect(route.module).toBe('platform');
      expect(route.domain).toBe('permission');
    }

    const platformIds = routesOfModule(ROUTES, 'platform').map((r) => r.operationId);
    for (const route of POSITION_ROUTES) expect(platformIds).toContain(route.operationId);
    expect(validateRegistry(ROUTES)).toEqual([]);
  });

  it('operationId / 方法 / 路径与契约一致', () => {
    const actual = POSITION_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/positions platform.position.list',
        'POST /api/v1/positions platform.position.create',
        'PATCH /api/v1/positions/{id} platform.position.update',
        'DELETE /api/v1/positions/{id} platform.position.delete',
      ].sort(),
    );
  });

  it('scope = permission.<动作>；写操作必记审计、列表读不记（D51/D54②）', () => {
    const byId = new Map(POSITION_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('platform.position.list')?.scope).toBe('permission.read');
    expect(byId.get('platform.position.create')?.scope).toBe('permission.create');
    expect(byId.get('platform.position.update')?.scope).toBe('permission.update');
    expect(byId.get('platform.position.delete')?.scope).toBe('permission.delete');

    expect(byId.get('platform.position.list')?.audit).toEqual({ kind: 'none', required: false });
    for (const id of ['platform.position.create', 'platform.position.update', 'platform.position.delete']) {
      expect(byId.get(id)?.audit).toEqual({ kind: 'write', required: true });
    }
  });

  it('更新/停用带强 ETag；权限模板变更默认禁止 AI，停用必须带 reason（D54⑥）', () => {
    const byId = new Map(POSITION_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('platform.position.list')?.requiresIfMatch).toBe(false);
    expect(byId.get('platform.position.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('platform.position.delete')?.requiresIfMatch).toBe(true);

    expect(byId.get('platform.position.list')?.ai).toEqual({ policy: 'allow', reasonRequired: false });
    expect(byId.get('platform.position.create')?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(byId.get('platform.position.update')?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(byId.get('platform.position.delete')?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
  });

  it('权限模板 actions 只用 domains.ts 词表，且「看价」不进勾选表（D4）', () => {
    expect(PositionActionsSchema.safeParse(validActions).success).toBe(true);
    expect(PositionActionsSchema.safeParse([{ domain: 'permission', actions: ['read', 'delete'] }]).success).toBe(true);

    // 不自造词：未知功能域 / 未知动作直接失败。
    expect(PositionActionsSchema.safeParse([{ domain: 'not_a_domain', actions: ['read'] }]).success).toBe(false);
    expect(PositionActionsSchema.safeParse([{ domain: 'sales', actions: ['approve_forever'] }]).success).toBe(false);
    // D4：看价是数据可见性开关、不属于操作，不进入勾选表。
    expect(PositionActionsSchema.safeParse([{ domain: 'product', actions: ['read', 'view_price'] }]).success).toBe(false);
    // 同一功能域只能出现一次；每行至少一个动作。
    expect(
      PositionActionsSchema.safeParse([
        { domain: 'sales', actions: ['read'] },
        { domain: 'sales', actions: ['create'] },
      ]).success,
    ).toBe(false);
    expect(PositionActionsSchema.safeParse([{ domain: 'sales', actions: [] }]).success).toBe(false);
    expect(PositionActionsSchema.safeParse([]).success).toBe(false);
  });

  it('presetKey 白名单 = D60② 八个预设，或 null（自定义岗位）', () => {
    expect([...POSITION_PRESET_KEYS]).toEqual([
      'owner',
      'manager',
      'finance',
      'sales',
      'purchase',
      'quality',
      'picking',
      'warehouse',
    ]);
    for (const presetKey of POSITION_PRESET_KEYS) {
      expect(PositionCreateInputSchema.safeParse({ ...validCreate, presetKey }).success).toBe(true);
    }
    expect(PositionCreateInputSchema.safeParse({ ...validCreate, presetKey: null }).success).toBe(true);
    expect(PositionCreateInputSchema.safeParse(validCreate).success).toBe(true);
    expect(PositionCreateInputSchema.safeParse({ ...validCreate, presetKey: 'superadmin' }).success).toBe(false);
    expect(PositionCreateInputSchema.safeParse({ ...validCreate, presetKey: '老板' }).success).toBe(false);
  });

  it('创建入参：name / actions 必填，越权字段（id / tenantId / status）不可传入', () => {
    expect(PositionCreateInputSchema.safeParse(validCreate).success).toBe(true);
    expect(PositionCreateInputSchema.safeParse({ name: '销售' }).success).toBe(false);
    expect(PositionCreateInputSchema.safeParse({ name: '', actions: validActions }).success).toBe(false);
    expect(PositionCreateInputSchema.safeParse({ ...validCreate, id: ID }).success).toBe(false);
    expect(PositionCreateInputSchema.safeParse({ ...validCreate, tenantId: ID }).success).toBe(false);
    expect(PositionCreateInputSchema.safeParse({ ...validCreate, status: '停用' }).success).toBe(false);
    expect(Object.keys(PositionCreateInputSchema.shape)).not.toContain('id');
    expect(Object.keys(PositionCreateInputSchema.shape)).not.toContain('tenantId');
  });

  it('更新入参：全字段可选、至少改一个；presetKey / 越权字段不可改', () => {
    expect(PositionUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(PositionUpdateInputSchema.safeParse({ name: '销售改' }).success).toBe(true);
    expect(PositionUpdateInputSchema.safeParse({ actions: validActions }).success).toBe(true);
    expect(PositionUpdateInputSchema.safeParse({ presetKey: 'manager' }).success).toBe(false);
    expect(PositionUpdateInputSchema.safeParse({ id: ID }).success).toBe(false);
    expect(Object.keys(PositionUpdateInputSchema.shape)).not.toContain('presetKey');
    expect(Object.keys(PositionUpdateInputSchema.shape)).not.toContain('id');
  });

  it('列表查询：分页 + presetKey 过滤只接受白名单值', () => {
    expect(PositionListQuerySchema.safeParse({}).success).toBe(true);
    expect(PositionListQuerySchema.safeParse({ limit: 20, presetKey: 'finance' }).success).toBe(true);
    expect(PositionListQuerySchema.safeParse({ presetKey: 'bogus' }).success).toBe(false);
  });

  it('Position 实体已登记，含 presetKey / actions / status / version', () => {
    expect(ENTITIES.map((e) => e.name)).toContain('Position');
    expect(z.globalRegistry.has(PositionSchema)).toBe(true);
    expect(z.globalRegistry.get(PositionSchema)?.id).toBe('Position');

    const keys = Object.keys(PositionSchema.shape).sort();
    expect(keys).toEqual(
      ['id', 'tenantId', 'name', 'presetKey', 'actions', 'status', 'version', 'createdAt', 'updatedAt'].sort(),
    );

    const doc = buildOpenApiDocument(ROUTES);
    const position = doc.components.schemas.Position as { properties: Record<string, unknown> };
    expect(position).toBeDefined();
    expect(position.properties).toHaveProperty('presetKey');
    expect(position.properties).toHaveProperty('version');
  });

  it('OpenAPI 发射出岗位端点与 x-module / x-scope / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);

    const collection = doc.paths['/api/v1/positions'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(collection).sort()).toEqual(['get', 'post']);
    expect(collection.get?.['x-scope']).toBe('permission.read');
    expect(collection.post?.['x-module']).toBe('platform');
    expect(collection.post?.['x-scope']).toBe('permission.create');
    expect(collection.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(collection.post?.['x-mcp-tool']).toBe('qingdan_platform_position_create');

    const detail = doc.paths['/api/v1/positions/{id}'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(detail).sort()).toEqual(['delete', 'patch']);
    expect(detail.patch?.['x-scope']).toBe('permission.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);
    expect(detail.delete?.['x-scope']).toBe('permission.delete');
    expect(detail.delete?.['x-requires-if-match']).toBe(true);
    expect(detail.delete?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
  });
});
