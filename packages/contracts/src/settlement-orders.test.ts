import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEADER_STATES } from './documents.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';
import { ROUTES } from './routes.js';
import {
  SETTLEMENT_ORDER_ROUTES,
  SETTLEMENT_ORDER_STATES,
  SETTLEMENT_SOURCE_DOC_TYPES,
  SettlementConfirmableSchema,
  SettlementOrderDetailSchema,
  SettlementOrderListQuerySchema,
  SettlementOrderSchema,
  SettlementOrderSourceDocTypeSchema,
  SettlementOrderStatusSchema,
  settlementConfirmable,
} from './settlement-orders.js';

/**
 * C 结算单契约（契约第一批 §3.4；D2③ / D5 / D11 / D19 / D29 / D33 / D35 / D36 / D52 / D54）。
 *
 * 这些断言锁的是「契约签名」本身，不是实现：生成 / 确认 / 重算的实现
 * 由 settlement 负责人按本文件落地，改签名必须先改这里并过评审。
 */

const COMPANY_ID = '00000000-0000-4000-8000-000000000050';
const SALES_ORDER_ID = '00000000-0000-4000-8000-000000000060';

const ORDER = {
  id: 'ct-1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  orderNo: 'C-0001-20261105-0001',
  sourceDocType: 'E',
  sourceDocId: SALES_ORDER_ID,
  status: '待确认',
  totalSaleAmount: '100',
  totalCostAmount: '70',
  grossProfit: '30',
  grossMarginRate: '0.3',
  relatedLossAmount: '5',
  netProfit: '25',
  commissionRateSnapshot: '0.05',
  commissionAmount: '1.5',
  commissionOwnerId: '00000000-0000-4000-8000-000000000088',
  version: 1,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
} as const;

const DETAIL = {
  ...ORDER,
  confirmable: { allowed: true, reason: null },
} as const;

/** 金额字段（D54）：服务端计算值也必须是 decimal 字符串。 */
const AMOUNT_FIELDS = [
  'totalSaleAmount',
  'totalCostAmount',
  'grossProfit',
  'grossMarginRate',
  'relatedLossAmount',
  'netProfit',
  'commissionRateSnapshot',
  'commissionAmount',
] as const;

/** 可为负的字段：毛利 / 毛利率 / 净毛利（负毛利记 0 只约束提成金额，D5④）。 */
const SIGNED_AMOUNT_FIELDS = new Set(['grossProfit', 'grossMarginRate', 'netProfit']);

describe('结算单契约（settlement）', () => {
  it('3 条端点全部登记并汇总进 ROUTES，且归属 settlement', () => {
    expect(SETTLEMENT_ORDER_ROUTES).toHaveLength(3);
    for (const route of SETTLEMENT_ORDER_ROUTES) expect(route.module).toBe('settlement');

    const settlementIds = routesOfModule(ROUTES, 'settlement').map((r) => r.operationId);
    for (const route of SETTLEMENT_ORDER_ROUTES) {
      expect(settlementIds).toContain(route.operationId);
    }
  });

  it('operationId / 方法 / 路径 / scope 与契约一致（confirm 用 settlement.approve）', () => {
    const actual = SETTLEMENT_ORDER_ROUTES.map(
      (r) => `${r.method} ${r.path} ${r.operationId}`,
    ).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/settlement-orders settlement.order.list.read',
        'GET /api/v1/settlement-orders/{id} settlement.order.detail.read',
        'POST /api/v1/settlement-orders/{id}/confirm settlement.order.confirm',
      ].sort(),
    );

    const byId = new Map(SETTLEMENT_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('settlement.order.list.read')?.scope).toBe('settlement.read');
    expect(byId.get('settlement.order.detail.read')?.scope).toBe('settlement.read');
    // 确认结算属审批动作（D44），不是 update。
    expect(byId.get('settlement.order.confirm')?.scope).toBe('settlement.approve');

    for (const route of SETTLEMENT_ORDER_ROUTES) expect(route.domain).toBe('settlement');
  });

  it('普通读不记审计；确认结算 audit=write（D51）', () => {
    const byId = new Map(SETTLEMENT_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('settlement.order.list.read')?.audit).toEqual({
      kind: 'none',
      required: false,
    });
    expect(byId.get('settlement.order.detail.read')?.audit).toEqual({
      kind: 'none',
      required: false,
    });
    expect(byId.get('settlement.order.confirm')?.audit).toEqual({
      kind: 'write',
      required: true,
    });
  });

  it('确认结算：AI 禁止 + 必须给原因（D52），强 ETag，响应 200（不是创建 201）', () => {
    const confirm = SETTLEMENT_ORDER_ROUTES.find(
      (r) => r.operationId === 'settlement.order.confirm',
    );
    expect(confirm?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(confirm?.requiresIfMatch).toBe(true);
    expect(confirm?.response?.status).toBe(200);

    const list = SETTLEMENT_ORDER_ROUTES.find(
      (r) => r.operationId === 'settlement.order.list.read',
    );
    expect(list?.response?.status).toBe(200);
  });

  it('状态是独立两态 `待确认 / 已结算`，不复用 HEADER_STATES（D19）', () => {
    expect([...SettlementOrderStatusSchema.options]).toEqual([...SETTLEMENT_ORDER_STATES]);
    expect([...SettlementOrderStatusSchema.options]).toEqual(['待确认', '已结算']);
    expect([...SettlementOrderStatusSchema.options]).not.toEqual([...HEADER_STATES]);

    for (const valid of ['待确认', '已结算']) {
      expect(SettlementOrderStatusSchema.safeParse(valid).success, valid).toBe(true);
    }
    // C 单没有「进行中 / 已取消」，也不接受英文枚举。
    for (const invalid of ['进行中', '已完成', '已取消', 'pending', 'settled', '草稿']) {
      expect(SettlementOrderStatusSchema.safeParse(invalid).success, invalid).toBe(false);
    }

    expect(SettlementOrderSchema.safeParse(ORDER).success).toBe(true);
    expect(SettlementOrderSchema.safeParse({ ...ORDER, status: '已结算' }).success).toBe(true);
    expect(SettlementOrderSchema.safeParse({ ...ORDER, status: '进行中' }).success).toBe(false);
  });

  it('来源单类型只有 E / N（D19 / D29），不接受其它单据类型', () => {
    expect([...SettlementOrderSourceDocTypeSchema.options]).toEqual([
      ...SETTLEMENT_SOURCE_DOC_TYPES,
    ]);
    expect([...SettlementOrderSourceDocTypeSchema.options]).toEqual(['E', 'N']);
    for (const valid of ['E', 'N']) {
      expect(SettlementOrderSchema.safeParse({ ...ORDER, sourceDocType: valid }).success).toBe(
        true,
      );
    }
    for (const invalid of ['A', 'B', 'C', 'R', 'S', 'I', 'e', 'n']) {
      expect(
        SettlementOrderSchema.safeParse({ ...ORDER, sourceDocType: invalid }).success,
        invalid,
      ).toBe(false);
    }
  });

  it('金额字段一律 decimal 字符串（D54），服务端计算值不接收 number', () => {
    expect(Object.keys(SettlementOrderSchema.shape).sort()).toEqual(
      [
        'id',
        'tenantId',
        'companyId',
        'orderNo',
        'sourceDocType',
        'sourceDocId',
        'status',
        'totalSaleAmount',
        'totalCostAmount',
        'grossProfit',
        'grossMarginRate',
        'relatedLossAmount',
        'netProfit',
        'commissionRateSnapshot',
        'commissionAmount',
        'commissionOwnerId',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );

    for (const field of AMOUNT_FIELDS) {
      expect(
        SettlementOrderSchema.safeParse({ ...ORDER, [field]: 1 }).success,
        `${field} 不接受 number`,
      ).toBe(false);
      expect(
        SettlementOrderSchema.safeParse({ ...ORDER, [field]: '1.2345678' }).success,
        `${field} 最多 6 位小数`,
      ).toBe(false);
      expect(
        SettlementOrderSchema.safeParse({ ...ORDER, [field]: 'abc' }).success,
        `${field} 必须是数字串`,
      ).toBe(false);
      expect(
        SettlementOrderSchema.safeParse({ ...ORDER, [field]: '1.234567' }).success,
        `${field} 合法 decimal`,
      ).toBe(true);
    }

    // 毛利 / 毛利率 / 净毛利可为负；售价 / 成本 / 损失 / 提成必须非负（D5④）。
    for (const field of AMOUNT_FIELDS) {
      const accepted = SettlementOrderSchema.safeParse({ ...ORDER, [field]: '-0.01' }).success;
      expect(accepted, field).toBe(SIGNED_AMOUNT_FIELDS.has(field));
    }
  });

  it('详情内嵌 confirmable：待确认可确认、已结算不可再确认（D19）', () => {
    expect(SettlementOrderDetailSchema.safeParse(DETAIL).success).toBe(true);
    expect(
      SettlementOrderDetailSchema.safeParse({ ...DETAIL, confirmable: undefined }).success,
    ).toBe(false);
    expect(Object.keys(SettlementOrderDetailSchema.shape)).toContain('confirmable');

    expect(settlementConfirmable('待确认')).toEqual({ allowed: true, reason: null });
    expect(settlementConfirmable('已结算')).toEqual({
      allowed: false,
      reason: 'already_settled',
    });
    expect(SettlementConfirmableSchema.safeParse(settlementConfirmable('待确认')).success).toBe(
      true,
    );
    expect(SettlementConfirmableSchema.safeParse(settlementConfirmable('已结算')).success).toBe(
      true,
    );
    expect(
      SettlementConfirmableSchema.safeParse({ allowed: false, reason: 'unknown' }).success,
    ).toBe(false);
    expect(
      SettlementConfirmableSchema.safeParse({ allowed: false, reason: 'already_cancelled' })
        .success,
    ).toBe(false);

    expect(
      SettlementOrderDetailSchema.safeParse({
        ...DETAIL,
        status: '已结算',
        confirmable: settlementConfirmable('已结算'),
      }).success,
    ).toBe(true);
  });

  it('列表查询：公司 / 状态 / 来源单类型 / 关键字 + 游标分页', () => {
    expect(
      SettlementOrderListQuerySchema.safeParse({
        companyId: COMPANY_ID,
        status: '待确认',
        sourceDocType: 'E',
        keyword: 'C-0001',
        cursor: 'abc',
        limit: 50,
      }).success,
    ).toBe(true);
    expect(SettlementOrderListQuerySchema.safeParse({}).success).toBe(true);
    expect(SettlementOrderListQuerySchema.safeParse({ status: '进行中' }).success).toBe(false);
    expect(SettlementOrderListQuerySchema.safeParse({ sourceDocType: 'A' }).success).toBe(false);
    expect(SettlementOrderListQuerySchema.safeParse({ companyId: 'co-1' }).success).toBe(false);
    expect(SettlementOrderListQuerySchema.safeParse({ keyword: 'k'.repeat(65) }).success).toBe(
      false,
    );

    const queryNames = Object.keys(SettlementOrderListQuerySchema.shape).sort();
    expect(queryNames).toEqual([
      'companyId',
      'cursor',
      'keyword',
      'limit',
      'sourceDocType',
      'status',
    ]);
  });

  it('本批不做 create / 取消 / 冲正 / 部分结算 / 提成规则 / 利润报表端点', () => {
    const ids = SETTLEMENT_ORDER_ROUTES.map((r) => r.operationId);
    expect(ids.some((id) => /create|cancel|reverse|partial|multi|commission|report/.test(id))).toBe(
      false,
    );
    expect(ids.some((id) => id.includes('profit_report'))).toBe(false);
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    const names = ENTITIES.map((e) => e.name);
    for (const name of ['SettlementOrder', 'SettlementOrderDetail']) {
      expect(names, name).toContain(name);
    }

    expect(z.globalRegistry.get(SettlementOrderSchema)?.id).toBe('SettlementOrder');
    expect(z.globalRegistry.get(SettlementOrderDetailSchema)?.id).toBe('SettlementOrderDetail');

    const doc = buildOpenApiDocument(ROUTES);
    for (const name of ['SettlementOrder', 'SettlementOrderDetail']) {
      expect(doc.components.schemas[name], name).toBeDefined();
    }
    const detail = doc.components.schemas.SettlementOrderDetail as {
      properties: Record<string, unknown>;
    };
    expect(detail.properties).toHaveProperty('confirmable');
    const order = doc.components.schemas.SettlementOrder as {
      properties: Record<string, unknown>;
    };
    for (const field of [
      'sourceDocType',
      'sourceDocId',
      'totalSaleAmount',
      'totalCostAmount',
      'grossProfit',
      'grossMarginRate',
      'relatedLossAmount',
      'netProfit',
      'commissionRateSnapshot',
      'commissionAmount',
    ]) {
      expect(order.properties).toHaveProperty(field);
    }
  });

  it('OpenAPI 发射出 settlement 端点与 x-module / x-scope / x-audit / x-ai-policy 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);

    const orders = doc.paths['/api/v1/settlement-orders'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(orders).sort()).toEqual(['get']);
    expect(orders.get?.['operationId']).toBe('settlement.order.list.read');
    expect(orders.get?.['x-module']).toBe('settlement');
    expect(orders.get?.['x-scope']).toBe('settlement.read');
    expect(orders.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    expect(orders.get?.['x-mcp-tool']).toBe('qingdan_settlement_order_list_read');
    const queryNames = (orders.get?.parameters as Array<{ name: string }>)
      .map((p) => p.name)
      .sort();
    expect(queryNames).toEqual([
      'companyId',
      'cursor',
      'keyword',
      'limit',
      'sourceDocType',
      'status',
    ]);

    const detail = doc.paths['/api/v1/settlement-orders/{id}'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(detail).sort()).toEqual(['get']);
    expect(detail.get?.['x-scope']).toBe('settlement.read');
    expect(detail.get?.['x-mcp-tool']).toBe('qingdan_settlement_order_detail_read');

    const confirm = doc.paths['/api/v1/settlement-orders/{id}/confirm'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(confirm).sort()).toEqual(['post']);
    expect(confirm.post?.['x-module']).toBe('settlement');
    expect(confirm.post?.['x-scope']).toBe('settlement.approve');
    expect(confirm.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(confirm.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(confirm.post?.['x-requires-if-match']).toBe(true);
    expect(confirm.post?.['x-mcp-tool']).toBe('qingdan_settlement_order_confirm');
    expect(confirm.post?.responses).toHaveProperty('200');
    expect(confirm.post?.responses).not.toHaveProperty('201');
  });
});
