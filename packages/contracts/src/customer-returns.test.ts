import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule, validateRegistry } from './registry.js';
import { ROUTES } from './routes.js';
import {
  CUSTOMER_RETURN_ROUTES,
  CustomerReturnCreateInputSchema,
  CustomerReturnLineSchema,
  CustomerReturnSchema,
  CustomerReturnTypeSchema,
  OnlyRefundKindSchema,
  RefundModeSchema,
} from './customer-returns.js';

/**
 * R 客户退货契约（契约第一批 §4；D36 / D40 / D47 / D51 / D54）。
 *
 * 这些断言锁的是契约签名与冲正口径本身，不是实现：
 * 端点实现由 sales 负责人后续落地，改签名必须先改这里并过评审。
 */

const COMPANY_ID = '00000000-0000-4000-8000-000000000050';
const SALES_ORDER_ID = '00000000-0000-4000-8000-000000000070';
const SETTLEMENT_ID = '00000000-0000-4000-8000-000000000080';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000010';
const BATCH_ID = '00000000-0000-4000-8000-000000000020';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_ID],
  qty: '2',
  unitPrice: '12.5',
  amount: '25',
} as const;

const RETURN_REFUND = {
  id: 'cr-1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  returnNo: 'R-0001-20261105-0001',
  originalSalesOrderId: SALES_ORDER_ID,
  originalSettlementOrderId: SETTLEMENT_ID,
  returnType: '退货退款',
  onlyRefundKind: null,
  refundMode: '原路退款',
  status: '进行中',
  refundAmount: '25',
  lines: [LINE],
  remark: '客户退货',
  version: 1,
  createdAt: '2026-11-05T02:00:00.000Z',
  updatedAt: '2026-11-05T02:00:00.000Z',
} as const;

const ONLY_REFUND = {
  ...RETURN_REFUND,
  id: 'cr-2',
  originalSettlementOrderId: null,
  returnType: '仅退款',
  onlyRefundKind: '纠收款',
  refundMode: '冲抵应收',
  refundAmount: '10',
  lines: [],
  remark: null,
} as const;

const CREATE_ONLY_REFUND = {
  companyId: COMPANY_ID,
  originalSalesOrderId: SALES_ORDER_ID,
  returnType: '仅退款',
  refundMode: '冲抵应收',
  onlyRefundKind: '纠收款',
  refundAmount: '10',
} as const;

const CREATE_RETURN_REFUND = {
  companyId: COMPANY_ID,
  originalSalesOrderId: SALES_ORDER_ID,
  returnType: '退货退款',
  refundMode: '原路退款',
  lines: [LINE],
  refundAmount: '25',
} as const;

const byId = new Map(CUSTOMER_RETURN_ROUTES.map((route) => [route.operationId, route]));

describe('客户退货契约（customer_return）', () => {
  it('3 条端点全部登记并汇总进 ROUTES，且归属 sales', () => {
    expect(CUSTOMER_RETURN_ROUTES).toHaveLength(3);
    for (const route of CUSTOMER_RETURN_ROUTES) expect(route.module).toBe('sales');

    const salesIds = routesOfModule(ROUTES, 'sales').map((r) => r.operationId);
    for (const route of CUSTOMER_RETURN_ROUTES) expect(salesIds).toContain(route.operationId);
    expect(validateRegistry(ROUTES)).toEqual([]);
  });

  it('operationId / 方法 / 路径 / scope 与契约一致', () => {
    const actual = CUSTOMER_RETURN_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/customer-returns customer_return.list.read',
        'POST /api/v1/customer-returns customer_return.create',
        'GET /api/v1/customer-returns/{id} customer_return.detail.read',
      ].sort(),
    );

    expect(byId.get('customer_return.list.read')?.scope).toBe('customer_return.read');
    expect(byId.get('customer_return.detail.read')?.scope).toBe('customer_return.read');
    expect(byId.get('customer_return.create')?.scope).toBe('customer_return.create');
  });

  it('普通读不记审计；登记退货 audit=write（D51 / D54 ②）', () => {
    expect(byId.get('customer_return.list.read')?.audit).toEqual({ kind: 'none', required: false });
    expect(byId.get('customer_return.detail.read')?.audit).toEqual({
      kind: 'none',
      required: false,
    });
    expect(byId.get('customer_return.create')?.audit).toEqual({ kind: 'write', required: true });
  });

  it('登记退货是冲正危险动作：AI 禁止且必须给原因；201 返回实体', () => {
    expect(byId.get('customer_return.create')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: true,
    });
    expect(byId.get('customer_return.create')?.response?.status).toBe(201);
    expect(byId.get('customer_return.list.read')?.response?.status).toBe(200);
    expect(byId.get('customer_return.detail.read')?.response?.status).toBe(200);
  });

  it('类型 / 仅退款子类型 / 退款方式枚举封闭（F4 / D40）', () => {
    expect([...CustomerReturnTypeSchema.options]).toEqual(['退货退款', '仅退款']);
    expect([...OnlyRefundKindSchema.options]).toEqual(['纠收款', '减成交额']);
    expect([...RefundModeSchema.options]).toEqual(['原路退款', '冲抵应收']);

    for (const invalid of ['退款', '退货', 'refund']) {
      expect(CustomerReturnTypeSchema.safeParse(invalid).success, invalid).toBe(false);
    }
    for (const invalid of ['纠收款退款', '减额', 'recalculate']) {
      expect(OnlyRefundKindSchema.safeParse(invalid).success, invalid).toBe(false);
    }
    for (const invalid of ['现金', '微信', '转账']) {
      expect(RefundModeSchema.safeParse(invalid).success, invalid).toBe(false);
    }
  });

  it('onlyRefundKind 条件必填：仅退款必填、退货退款必须为空（D40，refine 锁死）', () => {
    // 仅退款：必须给出 纠收款 / 减成交额。
    expect(CustomerReturnCreateInputSchema.safeParse(CREATE_ONLY_REFUND).success).toBe(true);
    expect(
      CustomerReturnCreateInputSchema.safeParse({
        ...CREATE_ONLY_REFUND,
        onlyRefundKind: '减成交额',
      }).success,
    ).toBe(true);
    const { onlyRefundKind: _missing, ...withoutKind } = CREATE_ONLY_REFUND;
    expect(CustomerReturnCreateInputSchema.safeParse(withoutKind).success).toBe(false);
    expect(
      CustomerReturnCreateInputSchema.safeParse({ ...CREATE_ONLY_REFUND, onlyRefundKind: null })
        .success,
    ).toBe(false);

    // 退货退款：other 情况必须为空（null / 未传），给出值即拒绝。
    expect(CustomerReturnCreateInputSchema.safeParse(CREATE_RETURN_REFUND).success).toBe(true);
    expect(
      CustomerReturnCreateInputSchema.safeParse({
        ...CREATE_RETURN_REFUND,
        onlyRefundKind: null,
      }).success,
    ).toBe(true);
    expect(
      CustomerReturnCreateInputSchema.safeParse({
        ...CREATE_RETURN_REFUND,
        onlyRefundKind: '纠收款',
      }).success,
    ).toBe(false);
  });

  it('退货退款必须有商品明细；仅退款 lines 可为空 / 省略（§5.1 / F4）', () => {
    expect(CustomerReturnCreateInputSchema.safeParse(CREATE_RETURN_REFUND).success).toBe(true);
    const { lines: _lines, ...withoutLines } = CREATE_RETURN_REFUND;
    expect(CustomerReturnCreateInputSchema.safeParse(withoutLines).success).toBe(false);
    expect(
      CustomerReturnCreateInputSchema.safeParse({ ...CREATE_RETURN_REFUND, lines: [] }).success,
    ).toBe(false);

    expect(CustomerReturnCreateInputSchema.safeParse(CREATE_ONLY_REFUND).success).toBe(true);
    expect(
      CustomerReturnCreateInputSchema.safeParse({ ...CREATE_ONLY_REFUND, lines: [] }).success,
    ).toBe(true);
  });

  it('refundAmount 必须是正数 decimal 字符串（D40 / D54）', () => {
    for (const invalid of ['0', '0.000000', '-1', '-0.01', 'abc', '1.2345678']) {
      expect(
        CustomerReturnCreateInputSchema.safeParse({
          ...CREATE_ONLY_REFUND,
          refundAmount: invalid,
        }).success,
        invalid,
      ).toBe(false);
    }
    for (const valid of ['0.01', '10', '25.5', '999999999999.999999']) {
      expect(
        CustomerReturnCreateInputSchema.safeParse({
          ...CREATE_ONLY_REFUND,
          refundAmount: valid,
        }).success,
        valid,
      ).toBe(true);
    }
    expect(
      CustomerReturnCreateInputSchema.safeParse({ ...CREATE_ONLY_REFUND, refundAmount: 10 }).success,
    ).toBe(false);
  });

  it('入参只收客户端字段：服务端生成字段不在 shape', () => {
    const keys = Object.keys(CustomerReturnCreateInputSchema.shape).sort();
    expect(keys).toEqual(
      [
        'companyId',
        'originalSalesOrderId',
        'originalSettlementOrderId',
        'returnType',
        'refundMode',
        'onlyRefundKind',
        'lines',
        'refundAmount',
      ].sort(),
    );
    for (const serverField of ['id', 'tenantId', 'returnNo', 'status', 'version', 'createdAt', 'updatedAt']) {
      expect(keys).not.toContain(serverField);
    }
  });

  it('实体字段：可空项 / 状态三态 / decimal / 明细批次约束', () => {
    expect(CustomerReturnSchema.safeParse(RETURN_REFUND).success).toBe(true);
    expect(CustomerReturnSchema.safeParse(ONLY_REFUND).success).toBe(true);

    // 状态复用 HEADER_STATES，不另造枚举。
    for (const status of ['进行中', '已完成', '已取消']) {
      expect(CustomerReturnSchema.safeParse({ ...RETURN_REFUND, status }).success, status).toBe(true);
    }
    expect(CustomerReturnSchema.safeParse({ ...RETURN_REFUND, status: '已结算' }).success).toBe(false);

    // 关联 C 单可空；备注可空；金额仍为 decimal 字符串。
    expect(
      CustomerReturnSchema.safeParse({ ...RETURN_REFUND, originalSettlementOrderId: null }).success,
    ).toBe(true);
    expect(CustomerReturnSchema.safeParse({ ...RETURN_REFUND, remark: null }).success).toBe(true);
    expect(CustomerReturnSchema.safeParse({ ...RETURN_REFUND, refundAmount: 25 }).success).toBe(false);

    // 实体同样锁 onlyRefundKind 条件。
    expect(CustomerReturnSchema.safeParse({ ...ONLY_REFUND, onlyRefundKind: null }).success).toBe(
      false,
    );
    expect(
      CustomerReturnSchema.safeParse({ ...RETURN_REFUND, onlyRefundKind: '纠收款' }).success,
    ).toBe(false);

    // 明细至少引用 1 个批次；金额 shape 不可缺。
    expect(
      CustomerReturnLineSchema.safeParse({ ...LINE, batchIds: [] }).success,
    ).toBe(false);
    expect(CustomerReturnLineSchema.safeParse({ ...LINE, amount: 25 }).success).toBe(false);

    for (const field of [
      'id',
      'tenantId',
      'companyId',
      'returnNo',
      'originalSalesOrderId',
      'originalSettlementOrderId',
      'returnType',
      'onlyRefundKind',
      'refundMode',
      'status',
      'refundAmount',
      'lines',
      'remark',
      'version',
      'createdAt',
      'updatedAt',
    ] as const) {
      const { [field]: _removed, ...rest } = RETURN_REFUND;
      expect(CustomerReturnSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    expect(ENTITIES.map((e) => e.name)).toContain('CustomerReturn');
    expect(z.globalRegistry.get(CustomerReturnSchema)?.id).toBe('CustomerReturn');

    const doc = buildOpenApiDocument(ROUTES);
    expect(doc.components.schemas.CustomerReturn).toBeDefined();
  });

  it('OpenAPI 发射出退货端点与 x-module / x-scope / x-audit / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);
    const path = doc.paths['/api/v1/customer-returns'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(path).sort()).toEqual(['get', 'post']);

    expect(path.get?.['x-module']).toBe('sales');
    expect(path.get?.['x-scope']).toBe('customer_return.read');
    expect(path.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    expect(path.get?.['x-mcp-tool']).toBe('qingdan_customer_return_list_read');
    expect(path.get?.responses).toHaveProperty('200');

    expect(path.post?.['x-module']).toBe('sales');
    expect(path.post?.['x-scope']).toBe('customer_return.create');
    expect(path.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(path.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(path.post?.['x-mcp-tool']).toBe('qingdan_customer_return_create');
    expect(path.post?.responses).toHaveProperty('201');

    const detail = doc.paths['/api/v1/customer-returns/{id}'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(detail.get?.['x-scope']).toBe('customer_return.read');
    expect(detail.get?.['x-mcp-tool']).toBe('qingdan_customer_return_detail_read');
  });
});
