import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEADER_STATES, canCancel } from './documents.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';
import { ROUTES } from './routes.js';
import {
  SALES_ORDER_ROUTES,
  SalesOrderCancelableSchema,
  SalesOrderCreateInputSchema,
  SalesOrderDetailSchema,
  SalesOrderFeeSchema,
  SalesOrderLineSchema,
  SalesOrderListQuerySchema,
  SalesOrderSchema,
  SalesOrderStatusSchema,
  SalesOrderUpdateInputSchema,
} from './sales-orders.js';

/**
 * 销售单 E 契约（契约第一批 §3.3 / §5.1 / §5.2 / §10）。
 *
 * 这些断言锁的是「契约签名」本身，不是实现：开单 / 改单 / 取消的实现
 * 由 sales 负责人按本文件落地，改签名必须先改这里并过评审。
 */

const PRODUCT_ID = '00000000-0000-4000-8000-000000000010';
const BATCH_ID = '00000000-0000-4000-8000-000000000020';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000030';
const HANDLER_ID = '00000000-0000-4000-8000-000000000040';
const COMPANY_ID = '00000000-0000-4000-8000-000000000050';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_ID],
  qty: '2',
  unitPrice: '12.5',
  amount: '25',
} as const;

const FEE = {
  feeName: '运费',
  qty: '2',
  unitPrice: '10',
  amount: '20',
  remark: null,
} as const;

const ORDER = {
  id: 'so-1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  orderNo: 'E-0001-20261105-0001',
  customerId: CUSTOMER_ID,
  customerName: '张三商贸',
  status: '进行中',
  handlerId: HANDLER_ID,
  lines: [LINE],
  fees: [FEE],
  totalAmount: '45',
  version: 1,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
} as const;

const DETAIL = {
  ...ORDER,
  receipts: [],
  cancelable: { allowed: true, reason: null },
} as const;

const CREATE_INPUT = {
  companyId: COMPANY_ID,
  customerId: CUSTOMER_ID,
  handlerId: HANDLER_ID,
  lines: [LINE],
  fees: [FEE],
} as const;

describe('销售单契约（sales）', () => {
  it('5 条端点全部登记并汇总进 ROUTES，且归属 sales', () => {
    expect(SALES_ORDER_ROUTES).toHaveLength(5);
    for (const route of SALES_ORDER_ROUTES) expect(route.module).toBe('sales');

    const salesIds = routesOfModule(ROUTES, 'sales').map((r) => r.operationId);
    for (const route of SALES_ORDER_ROUTES) expect(salesIds).toContain(route.operationId);
  });

  it('operationId / 方法 / 路径 / scope 与契约一致', () => {
    const actual = SALES_ORDER_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/sales-orders sales.order.list.read',
        'POST /api/v1/sales-orders sales.order.create',
        'GET /api/v1/sales-orders/{id} sales.order.detail.read',
        'PATCH /api/v1/sales-orders/{id} sales.order.update',
        'POST /api/v1/sales-orders/{id}/cancel sales.order.cancel',
      ].sort(),
    );

    const byId = new Map(SALES_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('sales.order.list.read')?.scope).toBe('sales.read');
    expect(byId.get('sales.order.detail.read')?.scope).toBe('sales.read');
    expect(byId.get('sales.order.create')?.scope).toBe('sales.create');
    expect(byId.get('sales.order.update')?.scope).toBe('sales.update');
    expect(byId.get('sales.order.cancel')?.scope).toBe('sales.delete');
  });

  it('普通读不记审计；写操作全部 audit=write（D51）', () => {
    const byId = new Map(SALES_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('sales.order.list.read')?.audit).toEqual({ kind: 'none', required: false });
    expect(byId.get('sales.order.detail.read')?.audit).toEqual({ kind: 'none', required: false });
    for (const id of ['sales.order.create', 'sales.order.update', 'sales.order.cancel']) {
      expect(byId.get(id)?.audit, id).toEqual({ kind: 'write', required: true });
    }
  });

  it('AI 口径：开单禁止、修改允许、取消禁止且必须给原因；update/cancel 带强 ETag', () => {
    const byId = new Map(SALES_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('sales.order.create')?.ai).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(byId.get('sales.order.update')?.ai).toEqual({ policy: 'allow', reasonRequired: false });
    expect(byId.get('sales.order.cancel')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: true,
    });

    expect(byId.get('sales.order.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('sales.order.cancel')?.requiresIfMatch).toBe(true);
    expect(byId.get('sales.order.create')?.requiresIfMatch).toBe(false);
    expect(byId.get('sales.order.create')?.response?.status).toBe(201);
  });

  it('状态只复用 documents.ts 的 HEADER_STATES，不另造枚举（§10）', () => {
    expect([...SalesOrderStatusSchema.options]).toEqual([...HEADER_STATES]);
    expect(SalesOrderStatusSchema.safeParse('进行中').success).toBe(true);
    expect(SalesOrderStatusSchema.safeParse('已完成').success).toBe(true);
    expect(SalesOrderStatusSchema.safeParse('已取消').success).toBe(true);
    for (const invalid of ['pending', 'completed', '取消', '待出库']) {
      expect(SalesOrderStatusSchema.safeParse(invalid).success, invalid).toBe(false);
    }
    expect(SalesOrderSchema.safeParse(ORDER).success).toBe(true);
    expect(SalesOrderSchema.safeParse({ ...ORDER, status: 'completed' }).success).toBe(false);
  });

  it('商品明细：batchIds 至少 1 个（D22），数量/金额是 decimal 字符串（D54）', () => {
    expect(SalesOrderLineSchema.safeParse(LINE).success).toBe(true);
    expect(SalesOrderLineSchema.safeParse({ ...LINE, batchIds: [] }).success).toBe(false);
    expect(SalesOrderLineSchema.safeParse({ ...LINE, batchIds: 'not-an-array' }).success).toBe(false);
    expect(SalesOrderLineSchema.safeParse({ ...LINE, batchIds: ['not-a-uuid'] }).success).toBe(false);
    expect(
      SalesOrderLineSchema.safeParse({ ...LINE, batchIds: [BATCH_ID, PRODUCT_ID] }).success,
    ).toBe(true);

    for (const field of ['qty', 'unitPrice', 'amount'] as const) {
      expect(SalesOrderLineSchema.safeParse({ ...LINE, [field]: 1 }).success, field).toBe(false);
      expect(SalesOrderLineSchema.safeParse({ ...LINE, [field]: '-1' }).success, field).toBe(false);
      expect(SalesOrderLineSchema.safeParse({ ...LINE, [field]: '1.2345678' }).success, field).toBe(
        false,
      );
    }
    expect(SalesOrderLineSchema.safeParse({ ...LINE, qty: '1.234567' }).success).toBe(true);
  });

  it('费用明细：金额负数被拒（D39，refine 校验，不只是注释）', () => {
    expect(SalesOrderFeeSchema.safeParse(FEE).success).toBe(true);
    expect(SalesOrderFeeSchema.safeParse({ ...FEE, amount: '0' }).success).toBe(true);
    expect(SalesOrderFeeSchema.safeParse({ ...FEE, amount: '-0.01' }).success).toBe(false);
    expect(SalesOrderFeeSchema.safeParse({ ...FEE, amount: '-20' }).success).toBe(false);
    // 数量 / 单价仍按非负 decimal 校验。
    expect(SalesOrderFeeSchema.safeParse({ ...FEE, qty: '-1' }).success).toBe(false);
    expect(SalesOrderFeeSchema.safeParse({ ...FEE, unitPrice: -10 }).success).toBe(false);
    expect(SalesOrderFeeSchema.safeParse({ ...FEE, feeName: '' }).success).toBe(false);
    expect(SalesOrderFeeSchema.safeParse({ ...FEE, remark: null }).success).toBe(true);
    expect(SalesOrderFeeSchema.safeParse({ ...FEE, remark: '两车' }).success).toBe(true);

    expect(SalesOrderSchema.safeParse({ ...ORDER, fees: [{ ...FEE, amount: '-1' }] }).success).toBe(
      false,
    );
  });

  it('开单入参不接收单号（D16），商品明细至少 1 行；fees 选填', () => {
    expect(SalesOrderCreateInputSchema.safeParse(CREATE_INPUT).success).toBe(true);
    expect(
      SalesOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, fees: undefined }).success,
    ).toBe(true);
    expect(SalesOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, lines: [] }).success).toBe(false);
    expect(SalesOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, companyId: 'co-1' }).success).toBe(
      false,
    );

    expect(Object.keys(SalesOrderCreateInputSchema.shape)).not.toContain('orderNo');
    expect(Object.keys(SalesOrderCreateInputSchema.shape)).not.toContain('status');
    // 夹带单号不等于被接受：schema 会剥掉未知键，但契约明确不声明该字段。
    expect(Object.keys(SalesOrderCreateInputSchema.shape).sort()).toEqual(
      ['companyId', 'customerId', 'fees', 'handlerId', 'lines'].sort(),
    );
  });

  it('修改入参：至少改一个字段，且不含 companyId / orderNo / status', () => {
    expect(SalesOrderUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(SalesOrderUpdateInputSchema.safeParse({ handlerId: HANDLER_ID }).success).toBe(true);
    expect(SalesOrderUpdateInputSchema.safeParse({ lines: [LINE] }).success).toBe(true);
    expect(SalesOrderUpdateInputSchema.safeParse({ lines: [] }).success).toBe(false);
    const keys = Object.keys(SalesOrderUpdateInputSchema.shape);
    expect(keys).not.toContain('companyId');
    expect(keys).not.toContain('orderNo');
    expect(keys).not.toContain('status');
  });

  it('列表查询：公司/客户/状态/关键字 + 游标分页', () => {
    expect(
      SalesOrderListQuerySchema.safeParse({
        companyId: COMPANY_ID,
        customerId: CUSTOMER_ID,
        status: '进行中',
        keyword: 'E-0001',
        cursor: 'abc',
        limit: 50,
      }).success,
    ).toBe(true);
    expect(SalesOrderListQuerySchema.safeParse({}).success).toBe(true);
    expect(SalesOrderListQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
    expect(SalesOrderListQuerySchema.safeParse({ customerId: 'not-a-uuid' }).success).toBe(false);
    expect(SalesOrderListQuerySchema.safeParse({ keyword: 'k'.repeat(65) }).success).toBe(false);
  });

  it('详情：receipts 空数组占位 + cancelable 与 canCancel 口径一致（D21/D24）', () => {
    expect(SalesOrderDetailSchema.safeParse(DETAIL).success).toBe(true);
    expect(SalesOrderDetailSchema.safeParse({ ...DETAIL, receipts: undefined }).success).toBe(false);

    const keys = Object.keys(SalesOrderDetailSchema.shape);
    expect(keys).toContain('receipts');
    expect(keys).toContain('cancelable');

    // cancelable 直接承载 documents.ts 的 CancelDecision，不另造词表。
    for (const decision of [
      canCancel('进行中', false),
      canCancel('进行中', true),
      canCancel('已完成', false),
      canCancel('已取消', false),
    ]) {
      expect(SalesOrderCancelableSchema.safeParse(decision).success, JSON.stringify(decision)).toBe(
        true,
      );
    }
    expect(
      SalesOrderCancelableSchema.safeParse({ allowed: false, reason: 'unknown' }).success,
    ).toBe(false);
    expect(DETAIL.cancelable).toEqual(canCancel('进行中', false));

    // 本批没有「完成 / 出库」端点，也没有收款记录写入端点。
    const ids = SALES_ORDER_ROUTES.map((r) => r.operationId);
    expect(ids.some((id) => /complete|ship|receipt/.test(id))).toBe(false);
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    const names = ENTITIES.map((e) => e.name);
    for (const name of ['SalesOrder', 'SalesOrderLine', 'SalesOrderFee', 'SalesOrderDetail']) {
      expect(names, name).toContain(name);
    }

    expect(z.globalRegistry.get(SalesOrderSchema)?.id).toBe('SalesOrder');
    expect(z.globalRegistry.get(SalesOrderLineSchema)?.id).toBe('SalesOrderLine');
    expect(z.globalRegistry.get(SalesOrderFeeSchema)?.id).toBe('SalesOrderFee');
    expect(z.globalRegistry.get(SalesOrderDetailSchema)?.id).toBe('SalesOrderDetail');

    const doc = buildOpenApiDocument(ROUTES);
    for (const name of ['SalesOrder', 'SalesOrderLine', 'SalesOrderFee', 'SalesOrderDetail']) {
      expect(doc.components.schemas[name], name).toBeDefined();
    }
    const detail = doc.components.schemas.SalesOrderDetail as {
      properties: Record<string, unknown>;
    };
    expect(detail.properties).toHaveProperty('receipts');
    expect(detail.properties).toHaveProperty('cancelable');
  });

  it('OpenAPI 发射出 sales 端点与 x-module / x-scope / x-audit / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);

    const orders = doc.paths['/api/v1/sales-orders'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(orders).sort()).toEqual(['get', 'post']);
    expect(orders.get?.['x-module']).toBe('sales');
    expect(orders.get?.['x-scope']).toBe('sales.read');
    expect(orders.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    expect(orders.get?.['x-mcp-tool']).toBe('qingdan_sales_order_list_read');
    const queryNames = (orders.get?.parameters as Array<{ name: string }>).map((p) => p.name).sort();
    expect(queryNames).toEqual(['companyId', 'cursor', 'customerId', 'keyword', 'limit', 'status']);

    expect(orders.post?.['x-scope']).toBe('sales.create');
    expect(orders.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(orders.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(orders.post?.['x-mcp-tool']).toBe('qingdan_sales_order_create');
    expect(orders.post?.responses).toHaveProperty('201');

    const detail = doc.paths['/api/v1/sales-orders/{id}'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(detail).sort()).toEqual(['get', 'patch']);
    expect(detail.get?.['x-mcp-tool']).toBe('qingdan_sales_order_detail_read');
    expect(detail.patch?.['x-scope']).toBe('sales.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);

    const cancel = doc.paths['/api/v1/sales-orders/{id}/cancel'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(cancel.post?.['x-scope']).toBe('sales.delete');
    expect(cancel.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(cancel.post?.['x-mcp-tool']).toBe('qingdan_sales_order_cancel');
    expect(cancel.post?.['x-requires-if-match']).toBe(true);
  });
});
