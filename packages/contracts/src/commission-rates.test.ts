import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  COMMISSION_RATE_ROUTES,
  CommissionRateCreateInputSchema,
  CommissionRateListQuerySchema,
  CommissionRateSchema,
} from './commission-rates.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { ROUTES } from './routes.js';
import { allowsScope } from './authz.js';

/**
 * 提成比例配置契约测试（D5④ / D36 / D77）。
 * 只断言契约层事实：端点签名、权限、审计、AI 门禁、字段校验。
 */

const sampleRate = {
  id: '0190f0aa-1111-7000-8000-000000000001',
  tenantId: '0190f0aa-2222-7000-8000-000000000002',
  companyId: '0190f0aa-3333-7000-8000-000000000003',
  employeeId: '0190f0aa-4444-7000-8000-000000000004',
  rate: '0.05',
  effectiveFrom: '2026-11-01',
  createdBy: '0190f0aa-5555-7000-8000-000000000005',
  createdAt: '2026-11-07T10:00:00.000Z',
  updatedAt: '2026-11-07T10:00:00.000Z',
};

describe('提成比例配置：端点登记', () => {
  it('3 条端点，operationId 以 commission 开头，module 归 settlement', () => {
    expect(COMMISSION_RATE_ROUTES).toHaveLength(3);
    for (const route of COMMISSION_RATE_ROUTES) {
      expect(route.operationId.startsWith('commission.')).toBe(true);
      expect(route.module).toBe('settlement');
      expect(route.domain).toBe('commission');
    }
  });

  it('端点清单与路径固定', () => {
    const actual = COMMISSION_RATE_ROUTES.map(
      (route) => `${route.method} ${route.path} ${route.operationId}`,
    );
    expect(actual).toEqual([
      'GET /api/v1/commission-rates commission.rate.list.read',
      'POST /api/v1/commission-rates commission.rate.create',
      'DELETE /api/v1/commission-rates/{id} commission.rate.delete',
    ]);
  });

  it('已进入全局路由注册表，且不与其他端点重名', () => {
    const ids = ROUTES.map((route) => route.operationId);
    for (const route of COMMISSION_RATE_ROUTES) {
      expect(ids).toContain(route.operationId);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('权限：读 commission.read / 建 commission.create / 删 commission.delete', () => {
    const byId = new Map(COMMISSION_RATE_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('commission.rate.list.read')?.action).toBe('read');
    expect(byId.get('commission.rate.create')?.action).toBe('create');
    expect(byId.get('commission.rate.delete')?.action).toBe('delete');

    expect(allowsScope([{ domain: 'commission', actions: ['read'] }], 'commission', 'read')).toBe(
      true,
    );
    expect(
      allowsScope([{ domain: 'commission', actions: ['read'] }], 'commission', 'create'),
    ).toBe(false);
  });

  it('审计：读不记，建 / 删记 write（D51 / D54②）', () => {
    const byId = new Map(COMMISSION_RATE_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('commission.rate.list.read')?.audit).toMatchObject({ kind: 'none' });
    expect(byId.get('commission.rate.create')?.audit).toMatchObject({ kind: 'write' });
    expect(byId.get('commission.rate.delete')?.audit).toMatchObject({ kind: 'write' });
  });

  it('AI：配置直接决定钱，写操作默认禁止且必须给原因（D52①）', () => {
    for (const id of ['commission.rate.create', 'commission.rate.delete']) {
      const route = COMMISSION_RATE_ROUTES.find((r) => r.operationId === id);
      expect(route?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
    }
  });

  it('一期不做按岗（D77①）：只有 employeeId，没有 positionId', () => {
    const keys = Object.keys(CommissionRateCreateInputSchema.shape);
    expect(keys.sort()).toEqual(['companyId', 'effectiveFrom', 'employeeId', 'rate']);
    expect(keys).not.toContain('positionId');
  });
});

describe('提成比例配置：字段校验', () => {
  it('合法比例可通过（0 与 1 是边界）', () => {
    expect(CommissionRateSchema.safeParse(sampleRate).success).toBe(true);
    expect(CommissionRateSchema.safeParse({ ...sampleRate, rate: '0' }).success).toBe(true);
    expect(CommissionRateSchema.safeParse({ ...sampleRate, rate: '1' }).success).toBe(true);
    expect(CommissionRateSchema.safeParse({ ...sampleRate, rate: '0.123456' }).success).toBe(true);
  });

  it('比例必须落在 [0, 1]，负数与大于 1 都拒绝', () => {
    for (const rate of ['-0.01', '1.000001', '1.5']) {
      expect(CommissionRateSchema.safeParse({ ...sampleRate, rate }).success).toBe(false);
    }
  });

  it('比例最多 6 位小数（D54 amount 域）', () => {
    expect(CommissionRateSchema.safeParse({ ...sampleRate, rate: '0.1234567' }).success).toBe(
      false,
    );
  });

  it('生效日必须是 YYYY-MM-DD', () => {
    expect(
      CommissionRateCreateInputSchema.safeParse({
        companyId: sampleRate.companyId,
        employeeId: sampleRate.employeeId,
        rate: '0.05',
        effectiveFrom: '2026/11/01',
      }).success,
    ).toBe(false);
    expect(
      CommissionRateCreateInputSchema.safeParse({
        companyId: sampleRate.companyId,
        employeeId: sampleRate.employeeId,
        rate: '0.05',
        effectiveFrom: '2026-11-01',
      }).success,
    ).toBe(true);
  });

  it('列表查询的公司 / 员工都是可选的', () => {
    expect(CommissionRateListQuerySchema.safeParse({}).success).toBe(true);
    expect(
      CommissionRateListQuerySchema.safeParse({
        companyId: sampleRate.companyId,
        employeeId: sampleRate.employeeId,
      }).success,
    ).toBe(true);
    expect(CommissionRateListQuerySchema.safeParse({ companyId: 'not-a-uuid' }).success).toBe(
      false,
    );
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    expect(ENTITIES.map((entity) => entity.name)).toContain('CommissionRate');
    expect(z.globalRegistry.get(CommissionRateSchema)?.id).toBe('CommissionRate');
    const doc = buildOpenApiDocument(ROUTES);
    expect(doc.components.schemas.CommissionRate).toBeDefined();
  });
});
