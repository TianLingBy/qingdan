import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEADER_STATES } from './documents.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule, validateRegistry } from './registry.js';
import { ROUTES } from './routes.js';
import {
  STOCKTAKE_APPROVE_BLOCK_REASONS,
  STOCKTAKE_ROUTES,
  STOCKTAKE_STATUSES,
  StocktakeApprovableSchema,
  StocktakeCreateInputSchema,
  StocktakeDecreaseInputSchema,
  StocktakeDetailSchema,
  StocktakeIncreaseInputSchema,
  StocktakeListQuerySchema,
  StocktakeSchema,
  StocktakeStatusSchema,
  stocktakeApprovable,
} from './stocktakes.js';

/**
 * 盘点调整 I 契约（契约第一批 §4 / §8；D2① / D15 / D16 / D47 / D51 / D52 / D54 / D67）。
 *
 * 这些断言锁的是契约签名与冲正口径本身，不是实现：
 * 端点实现由 inventory 负责人后续落地，改签名必须先改这里并过评审。
 */

const COMPANY_ID = '00000000-0000-4000-8000-000000000050';
const BATCH_ID = '00000000-0000-4000-8000-000000000020';

const STOCKTAKE = {
  id: 'st-1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  stocktakeNo: 'I-0001-20261105-0001',
  batchId: BATCH_ID,
  bookQty: '100',
  actualQty: '95.5',
  diffQty: '-4.5',
  status: '待审批',
  applicantId: 'emp-1',
  approverId: null,
  remark: '盘亏',
  version: 1,
  createdAt: '2026-11-05T03:00:00.000Z',
  updatedAt: '2026-11-05T03:00:00.000Z',
} as const;

const DETAIL = {
  ...STOCKTAKE,
  approvable: { allowed: true, reason: null },
} as const;

const CREATE = {
  companyId: COMPANY_ID,
  batchId: BATCH_ID,
  bookQty: '100',
  actualQty: '95.5',
  remark: '盘亏',
} as const;

const byId = new Map(STOCKTAKE_ROUTES.map((route) => [route.operationId, route]));

describe('盘点调整契约（stocktake）', () => {
  it('5 条端点全部登记并汇总进 ROUTES，且归属 inventory（D71 拆盘盈/盘亏）', () => {
    expect(STOCKTAKE_ROUTES).toHaveLength(5);
    for (const route of STOCKTAKE_ROUTES) expect(route.module).toBe('inventory');

    const inventoryIds = routesOfModule(ROUTES, 'inventory').map((r) => r.operationId);
    for (const route of STOCKTAKE_ROUTES) expect(inventoryIds).toContain(route.operationId);
    expect(validateRegistry(ROUTES)).toEqual([]);
  });

  it('operationId / 方法 / 路径 / scope 与契约一致（审批用 stocktake.approve）', () => {
    const actual = STOCKTAKE_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/stocktakes stocktake.list.read',
        'POST /api/v1/stocktakes/increases stocktake.increase.create',
        'POST /api/v1/stocktakes/decreases stocktake.decrease.create',
        'GET /api/v1/stocktakes/{id} stocktake.detail.read',
        'POST /api/v1/stocktakes/{id}/approve stocktake.approve',
      ].sort(),
    );

    expect(byId.get('stocktake.list.read')?.scope).toBe('stocktake.read');
    expect(byId.get('stocktake.detail.read')?.scope).toBe('stocktake.read');
    // D71：盘盈 = create（入账增加）、盘亏 = delete（「仅删减」）。
    expect(byId.get('stocktake.increase.create')?.scope).toBe('stocktake.create');
    expect(byId.get('stocktake.decrease.create')?.scope).toBe('stocktake.delete');
    // 审批是 approve 动作，不是 update（D44 / D47）。
    expect(byId.get('stocktake.approve')?.scope).toBe('stocktake.approve');
    for (const route of STOCKTAKE_ROUTES) expect(route.domain).toBe('stocktake');
    // 盘点调整的功能域是 stocktake；stocktake_page 只是页面权限域，别混。
    expect(STOCKTAKE_ROUTES.some((route) => route.domain === ('stocktake_page' as never))).toBe(
      false,
    );
  });

  it('响应码：发起 201、审批 200、读 200', () => {
    expect(byId.get('stocktake.increase.create')?.response?.status).toBe(201);
    expect(byId.get('stocktake.decrease.create')?.response?.status).toBe(201);
    expect(byId.get('stocktake.approve')?.response?.status).toBe(200);
    expect(byId.get('stocktake.list.read')?.response?.status).toBe(200);
    expect(byId.get('stocktake.detail.read')?.response?.status).toBe(200);
  });

  it('普通读不记审计；发起 / 审批 audit=write（D51 / D54 ②）', () => {
    expect(byId.get('stocktake.list.read')?.audit).toEqual({ kind: 'none', required: false });
    expect(byId.get('stocktake.detail.read')?.audit).toEqual({ kind: 'none', required: false });
    expect(byId.get('stocktake.increase.create')?.audit).toEqual({ kind: 'write', required: true });
    expect(byId.get('stocktake.decrease.create')?.audit).toEqual({ kind: 'write', required: true });
    expect(byId.get('stocktake.approve')?.audit).toEqual({ kind: 'write', required: true });
  });

  it('AI 边界：发起默认禁止；审批只能人类 → forbid + 必须给原因（D52 / D54 ⑥）', () => {
    expect(byId.get('stocktake.increase.create')?.ai).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(byId.get('stocktake.decrease.create')?.ai).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(byId.get('stocktake.approve')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: true,
    });
  });

  it('审批强制 If-Match 强 ETag', () => {
    expect(byId.get('stocktake.approve')?.requiresIfMatch).toBe(true);
    expect(byId.get('stocktake.increase.create')?.requiresIfMatch).toBe(false);
    expect(byId.get('stocktake.decrease.create')?.requiresIfMatch).toBe(false);
  });

  it('状态是审批流三态 `待审批 / 已批准 / 已驳回`，不复用 HEADER_STATES', () => {
    expect([...StocktakeStatusSchema.options]).toEqual([...STOCKTAKE_STATUSES]);
    expect([...StocktakeStatusSchema.options]).toEqual(['待审批', '已批准', '已驳回']);
    expect([...StocktakeStatusSchema.options]).not.toEqual([...HEADER_STATES]);

    for (const valid of ['待审批', '已批准', '已驳回']) {
      expect(StocktakeStatusSchema.safeParse(valid).success, valid).toBe(true);
    }
    for (const invalid of ['进行中', '已完成', '已取消', 'pending', 'approved', '草稿']) {
      expect(StocktakeStatusSchema.safeParse(invalid).success, invalid).toBe(false);
    }

    expect(StocktakeSchema.safeParse(STOCKTAKE).success).toBe(true);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, status: '已批准' }).success).toBe(true);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, status: '已驳回' }).success).toBe(true);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, status: '进行中' }).success).toBe(false);
  });

  it('差异量由服务端计算：入参不含 diffQty，服务端字段一律不进 shape', () => {
    const keys = Object.keys(StocktakeCreateInputSchema.shape).sort();
    expect(keys).toEqual(['actualQty', 'batchId', 'bookQty', 'companyId', 'remark'].sort());
    for (const serverField of [
      'id',
      'tenantId',
      'stocktakeNo',
      'diffQty',
      'status',
      'applicantId',
      'approverId',
      'version',
      'createdAt',
      'updatedAt',
    ]) {
      expect(keys, serverField).not.toContain(serverField);
    }
  });

  it('无差异（actualQty === bookQty）拒绝创建，提示「无差异不需要盘点单」', () => {
    expect(StocktakeCreateInputSchema.safeParse(CREATE).success).toBe(true);
    // 盘盈 / 盘亏都允许。
    expect(
      StocktakeCreateInputSchema.safeParse({ ...CREATE, actualQty: '104.5', bookQty: '100' })
        .success,
    ).toBe(true);
    // 18 位有效数字超出 double 精度，必须按字符串归一化比较才算得出差异。
    expect(
      StocktakeCreateInputSchema.safeParse({
        ...CREATE,
        bookQty: '999999999999.999999',
        actualQty: '999999999999.999998',
      }).success,
    ).toBe(true);
    // 前导零 / 末尾零只是写法差异，仍视为无差异。
    expect(
      StocktakeCreateInputSchema.safeParse({ ...CREATE, bookQty: '0100.000', actualQty: '100' })
        .success,
    ).toBe(false);

    for (const [bookQty, actualQty] of [
      ['100', '100'],
      ['100', '100.000000'],
      ['0', '0'],
    ] as const) {
      const result = StocktakeCreateInputSchema.safeParse({ ...CREATE, bookQty, actualQty });
      expect(result.success, `${bookQty} / ${actualQty}`).toBe(false);
      expect(result.error?.issues[0]?.message).toBe('无差异不需要盘点单');
    }
  });

  it('盘盈 / 盘亏方向锁死在各自的入参 schema 上（D71）', () => {
    const surplus = { ...CREATE, bookQty: '100', actualQty: '104.5' };
    const shortage = { ...CREATE, bookQty: '100', actualQty: '95.5' };

    expect(StocktakeIncreaseInputSchema.safeParse(surplus).success).toBe(true);
    expect(StocktakeIncreaseInputSchema.safeParse(shortage).success).toBe(false);
    expect(StocktakeIncreaseInputSchema.safeParse(shortage).error?.issues[0]?.message).toBe(
      '盘盈单要求实盘量大于账面量',
    );

    expect(StocktakeDecreaseInputSchema.safeParse(shortage).success).toBe(true);
    expect(StocktakeDecreaseInputSchema.safeParse(surplus).success).toBe(false);
    expect(StocktakeDecreaseInputSchema.safeParse(surplus).error?.issues[0]?.message).toBe(
      '盘亏单要求实盘量小于账面量',
    );

    // 相等（含写法差异）两个方向都拒绝。
    for (const schema of [StocktakeIncreaseInputSchema, StocktakeDecreaseInputSchema]) {
      expect(schema.safeParse({ ...CREATE, bookQty: '100', actualQty: '100.000' }).success).toBe(
        false,
      );
    }
  });

  it('数量一律 decimal 字符串（D54），可负的只有服务端 diffQty', () => {
    for (const invalid of [100, 'abc', '-1', '1.2345678']) {
      expect(
        StocktakeCreateInputSchema.safeParse({ ...CREATE, bookQty: invalid }).success,
        `bookQty=${String(invalid)}`,
      ).toBe(false);
      expect(
        StocktakeCreateInputSchema.safeParse({ ...CREATE, actualQty: invalid }).success,
        `actualQty=${String(invalid)}`,
      ).toBe(false);
    }

    // 实体：账面量 / 实盘量非负；差异量可正可负。
    expect(StocktakeSchema.safeParse(STOCKTAKE).success).toBe(true);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, diffQty: '4.5' }).success).toBe(true);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, diffQty: '0' }).success).toBe(true);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, bookQty: '-1' }).success).toBe(false);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, actualQty: '-1' }).success).toBe(false);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, diffQty: '1.2345678' }).success).toBe(false);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, diffQty: -4.5 }).success).toBe(false);
  });

  it('实体字段齐全，approverId / remark 可空，stocktakeNo 服务端生成', () => {
    expect(Object.keys(StocktakeSchema.shape).sort()).toEqual(
      [
        'id',
        'tenantId',
        'companyId',
        'stocktakeNo',
        'batchId',
        'bookQty',
        'actualQty',
        'diffQty',
        'status',
        'applicantId',
        'approverId',
        'remark',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );

    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, approverId: 'emp-2' }).success).toBe(true);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, remark: null }).success).toBe(true);
    expect(StocktakeSchema.safeParse({ ...STOCKTAKE, remark: 'x'.repeat(201) }).success).toBe(false);

    for (const field of [
      'id',
      'tenantId',
      'companyId',
      'stocktakeNo',
      'batchId',
      'bookQty',
      'actualQty',
      'diffQty',
      'status',
      'applicantId',
      'approverId',
      'remark',
      'version',
      'createdAt',
      'updatedAt',
    ] as const) {
      const { [field]: _removed, ...rest } = STOCKTAKE;
      expect(StocktakeSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it('详情内嵌 approvable：待审批可批、已批准 / 已驳回不可再批', () => {
    expect(StocktakeDetailSchema.safeParse(DETAIL).success).toBe(true);
    expect(StocktakeDetailSchema.safeParse({ ...DETAIL, approvable: undefined }).success).toBe(
      false,
    );
    expect(Object.keys(StocktakeDetailSchema.shape)).toContain('approvable');

    expect(stocktakeApprovable('待审批')).toEqual({ allowed: true, reason: null });
    expect(stocktakeApprovable('已批准')).toEqual({
      allowed: false,
      reason: 'already_approved',
    });
    expect(stocktakeApprovable('已驳回')).toEqual({
      allowed: false,
      reason: 'already_rejected',
    });
    for (const status of STOCKTAKE_STATUSES) {
      expect(StocktakeApprovableSchema.safeParse(stocktakeApprovable(status)).success, status).toBe(
        true,
      );
    }
    expect([...STOCKTAKE_APPROVE_BLOCK_REASONS]).toEqual(['already_approved', 'already_rejected']);
    expect(
      StocktakeApprovableSchema.safeParse({ allowed: false, reason: 'unknown' }).success,
    ).toBe(false);
    expect(
      StocktakeApprovableSchema.safeParse({ allowed: false, reason: 'already_cancelled' }).success,
    ).toBe(false);
  });

  it('列表查询：公司 / 状态 / 关键字 + 游标分页', () => {
    expect(
      StocktakeListQuerySchema.safeParse({
        companyId: COMPANY_ID,
        status: '待审批',
        keyword: 'I-0001',
        cursor: 'abc',
        limit: 50,
      }).success,
    ).toBe(true);
    expect(StocktakeListQuerySchema.safeParse({}).success).toBe(true);
    expect(StocktakeListQuerySchema.safeParse({ status: '进行中' }).success).toBe(false);
    expect(StocktakeListQuerySchema.safeParse({ companyId: 'co-1' }).success).toBe(false);
    expect(StocktakeListQuerySchema.safeParse({ keyword: 'k'.repeat(65) }).success).toBe(false);

    expect(Object.keys(StocktakeListQuerySchema.shape).sort()).toEqual([
      'companyId',
      'cursor',
      'keyword',
      'limit',
      'status',
    ]);
  });

  it('本批不做：驳回端点 / 批量盘点 / 盘点明细表', () => {
    const ids = STOCKTAKE_ROUTES.map((route) => route.operationId);
    expect(ids.some((id) => /reject|batch|line|detail-line/.test(id))).toBe(false);
    expect(StocktakeSchema.shape).not.toHaveProperty('lines');
    expect(StocktakeCreateInputSchema.shape).not.toHaveProperty('lines');
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    const names = ENTITIES.map((entry) => entry.name);
    for (const name of ['Stocktake', 'StocktakeDetail']) expect(names, name).toContain(name);

    expect(z.globalRegistry.get(StocktakeSchema)?.id).toBe('Stocktake');
    expect(z.globalRegistry.get(StocktakeDetailSchema)?.id).toBe('StocktakeDetail');

    const doc = buildOpenApiDocument(ROUTES);
    const stocktake = doc.components.schemas.Stocktake as { properties: Record<string, unknown> };
    const detail = doc.components.schemas.StocktakeDetail as {
      properties: Record<string, unknown>;
    };
    expect(stocktake).toBeDefined();
    expect(detail).toBeDefined();
    for (const field of ['stocktakeNo', 'batchId', 'bookQty', 'actualQty', 'diffQty', 'approverId']) {
      expect(stocktake.properties).toHaveProperty(field);
    }
    expect(detail.properties).toHaveProperty('approvable');
  });

  it('OpenAPI 发射出盘点端点与 x-module / x-scope / x-audit / x-ai-policy 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);

    const list = doc.paths['/api/v1/stocktakes'] as Record<string, Record<string, unknown>>;
    expect(list.get?.['operationId']).toBe('stocktake.list.read');
    expect(list.get?.['x-module']).toBe('inventory');
    expect(list.get?.['x-scope']).toBe('stocktake.read');
    expect(list.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    expect(list.get?.['x-mcp-tool']).toBe('qingdan_stocktake_list_read');
    const queryNames = (list.get?.parameters as Array<{ name: string }>)
      .map((p) => p.name)
      .sort();
    expect(queryNames).toEqual(['companyId', 'cursor', 'keyword', 'limit', 'status']);

    const increases = doc.paths['/api/v1/stocktakes/increases'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(increases.post?.['operationId']).toBe('stocktake.increase.create');
    expect(increases.post?.['x-module']).toBe('inventory');
    expect(increases.post?.['x-scope']).toBe('stocktake.create');
    expect(increases.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(increases.post?.['x-ai-policy']).toEqual({
      policy: 'forbid',
      reasonRequired: false,
    });
    expect(increases.post?.['x-mcp-tool']).toBe('qingdan_stocktake_increase_create');
    expect(increases.post?.responses).toHaveProperty('201');

    const decreases = doc.paths['/api/v1/stocktakes/decreases'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(decreases.post?.['operationId']).toBe('stocktake.decrease.create');
    // D71：盘亏用 delete 动作（＝「仅删减」），权限据此区分盘盈。
    expect(decreases.post?.['x-scope']).toBe('stocktake.delete');
    expect(decreases.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(decreases.post?.['x-mcp-tool']).toBe('qingdan_stocktake_decrease_create');
    expect(decreases.post?.responses).toHaveProperty('201');

    const detail = doc.paths['/api/v1/stocktakes/{id}'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(detail.get?.['x-scope']).toBe('stocktake.read');
    expect(detail.get?.['x-mcp-tool']).toBe('qingdan_stocktake_detail_read');

    const approve = doc.paths['/api/v1/stocktakes/{id}/approve'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(approve.post?.['x-module']).toBe('inventory');
    expect(approve.post?.['x-scope']).toBe('stocktake.approve');
    expect(approve.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(approve.post?.['x-ai-policy']).toEqual({
      policy: 'forbid',
      reasonRequired: true,
    });
    expect(approve.post?.['x-requires-if-match']).toBe(true);
    expect(approve.post?.['x-mcp-tool']).toBe('qingdan_stocktake_approve');
    expect(approve.post?.responses).toHaveProperty('200');
    expect(approve.post?.responses).not.toHaveProperty('201');
  });
});
