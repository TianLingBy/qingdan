import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEADER_STATES, canCancel } from './documents.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';
import { ROUTES } from './routes.js';
import {
  PURCHASE_ORDER_ROUTES,
  PurchaseOrderCancelableSchema,
  PurchaseOrderCreateInputSchema,
  PurchaseOrderDetailSchema,
  PurchaseOrderFeeSchema,
  PurchaseOrderFeeViewSchema,
  PurchaseOrderLineSchema,
  PurchaseOrderLineViewSchema,
  PurchaseOrderListQuerySchema,
  PurchaseOrderSchema,
  PurchaseOrderStatusSchema,
  PurchaseOrderUpdateInputSchema,
} from './purchase-orders.js';

/**
 * 采购单 A 契约（契约第一批 §3.1 / §5.1 / §5.2 / §10）。
 *
 * 这些断言锁的是「契约签名」本身，不是实现：开单 / 改单 / 取消的实现
 * 由 purchase 负责人按本文件落地，改签名必须先改这里并过评审。
 */

const PRODUCT_ID = '00000000-0000-4000-8000-000000000010';
const SUPPLIER_ID = '00000000-0000-4000-8000-000000000030';
const HANDLER_ID = '00000000-0000-4000-8000-000000000040';
const COMPANY_ID = '00000000-0000-4000-8000-000000000050';

/** A 单商品明细：没有 batchIds（A 单入库时生成批次，不引用既有批次）。 */
const LINE = {
  productId: PRODUCT_ID,
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
  id: 'po-1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  orderNo: 'A-0001-20261105-0001',
  supplierId: SUPPLIER_ID,
  supplierName: '李四供应链',
  status: '进行中',
  handlerId: HANDLER_ID,
  lines: [LINE],
  fees: [FEE],
  goodsAmount: '25',
  feeAmount: '20',
  totalAmount: '45',
  version: 1,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
} as const;

const DETAIL = {
  ...ORDER,
  cancelable: { allowed: true, reason: null },
} as const;

const CREATE_INPUT = {
  companyId: COMPANY_ID,
  supplierId: SUPPLIER_ID,
  handlerId: HANDLER_ID,
  lines: [LINE],
  fees: [FEE],
} as const;

describe('采购单契约（purchase）', () => {
  it('6 条端点全部登记并汇总进 ROUTES，且归属 purchase', () => {
    expect(PURCHASE_ORDER_ROUTES).toHaveLength(6);
    for (const route of PURCHASE_ORDER_ROUTES) expect(route.module).toBe('purchase');

    const purchaseIds = routesOfModule(ROUTES, 'purchase').map((r) => r.operationId);
    for (const route of PURCHASE_ORDER_ROUTES) expect(purchaseIds).toContain(route.operationId);
  });

  it('operationId / 方法 / 路径 / scope 与契约一致', () => {
    const actual = PURCHASE_ORDER_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/purchase-orders purchase.order.list.read',
        'POST /api/v1/purchase-orders purchase.order.create',
        'GET /api/v1/purchase-orders/{id} purchase.order.detail.read',
        'PATCH /api/v1/purchase-orders/{id} purchase.order.update',
        'POST /api/v1/purchase-orders/{id}/cancel purchase.order.cancel',
        'POST /api/v1/purchase-orders/{id}/complete purchase.order.complete',
      ].sort(),
    );

    const byId = new Map(PURCHASE_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('purchase.order.list.read')?.scope).toBe('purchase.read');
    expect(byId.get('purchase.order.detail.read')?.scope).toBe('purchase.read');
    expect(byId.get('purchase.order.create')?.scope).toBe('purchase.create');
    expect(byId.get('purchase.order.update')?.scope).toBe('purchase.update');
    expect(byId.get('purchase.order.cancel')?.scope).toBe('purchase.delete');
    expect(byId.get('purchase.order.complete')?.scope).toBe('purchase.approve');
  });

  it('普通读不记审计；写操作全部 audit=write（D51）', () => {
    const byId = new Map(PURCHASE_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('purchase.order.list.read')?.audit).toEqual({ kind: 'none', required: false });
    expect(byId.get('purchase.order.detail.read')?.audit).toEqual({ kind: 'none', required: false });
    for (const id of ['purchase.order.create', 'purchase.order.update', 'purchase.order.cancel']) {
      expect(byId.get(id)?.audit, id).toEqual({ kind: 'write', required: true });
    }
  });

  it('AI 口径：开单禁止、修改允许、取消禁止且必须给原因；update/cancel 带强 ETag', () => {
    const byId = new Map(PURCHASE_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('purchase.order.create')?.ai).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(byId.get('purchase.order.update')?.ai).toEqual({ policy: 'allow', reasonRequired: false });
    expect(byId.get('purchase.order.cancel')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: true,
    });

    expect(byId.get('purchase.order.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('purchase.order.cancel')?.requiresIfMatch).toBe(true);
    expect(byId.get('purchase.order.create')?.requiresIfMatch).toBe(false);
    expect(byId.get('purchase.order.create')?.response?.status).toBe(201);
  });

  it('状态只复用 documents.ts 的 HEADER_STATES，不另造枚举（§10）', () => {
    expect([...PurchaseOrderStatusSchema.options]).toEqual([...HEADER_STATES]);
    expect(PurchaseOrderStatusSchema.safeParse('进行中').success).toBe(true);
    expect(PurchaseOrderStatusSchema.safeParse('已完成').success).toBe(true);
    expect(PurchaseOrderStatusSchema.safeParse('已取消').success).toBe(true);
    for (const invalid of ['pending', 'completed', '取消', '待入库']) {
      expect(PurchaseOrderStatusSchema.safeParse(invalid).success, invalid).toBe(false);
    }
    expect(PurchaseOrderSchema.safeParse(ORDER).success).toBe(true);
    expect(PurchaseOrderSchema.safeParse({ ...ORDER, status: 'completed' }).success).toBe(false);
  });

  it('A 单商品明细不含 batchIds（入库时生成批次，不引用既有批次），金额是 decimal 字符串', () => {
    expect(PurchaseOrderLineSchema.safeParse(LINE).success).toBe(true);
    expect(Object.keys(PurchaseOrderLineSchema.shape).sort()).toEqual(
      ['amount', 'productId', 'qty', 'unitPrice'].sort(),
    );
    expect(Object.keys(PurchaseOrderLineSchema.shape)).not.toContain('batchIds');

    // 夹带 batchIds 不被接受：schema 会剥掉未知键，解析结果里不得出现。
    const parsed = PurchaseOrderLineSchema.parse({ ...LINE, batchIds: [PRODUCT_ID] });
    expect(parsed).not.toHaveProperty('batchIds');

    for (const field of ['qty', 'unitPrice', 'amount'] as const) {
      expect(PurchaseOrderLineSchema.safeParse({ ...LINE, [field]: 1 }).success, field).toBe(false);
      expect(PurchaseOrderLineSchema.safeParse({ ...LINE, [field]: '-1' }).success, field).toBe(false);
      expect(PurchaseOrderLineSchema.safeParse({ ...LINE, [field]: '1.2345678' }).success, field).toBe(
        false,
      );
    }
    expect(PurchaseOrderLineSchema.safeParse({ ...LINE, qty: '1.234567' }).success).toBe(true);
  });

  it('A 单费用允许负数，但负数必须填备注（D39，refine 校验，不只是注释）', () => {
    // 正数 / 零：备注可空。
    expect(PurchaseOrderFeeSchema.safeParse(FEE).success).toBe(true);
    expect(PurchaseOrderFeeSchema.safeParse({ ...FEE, amount: '0' }).success).toBe(true);
    expect(PurchaseOrderFeeSchema.safeParse({ ...FEE, remark: null }).success).toBe(true);

    // 负数：无备注 / 空备注 / 纯空白备注一律拒绝。
    for (const remark of [undefined, null, '', '   ']) {
      expect(
        PurchaseOrderFeeSchema.safeParse({ ...FEE, amount: '-20', remark }).success,
        String(remark),
      ).toBe(false);
    }
    // 负数 + 有效备注：通过（供应商返利 / 对方承担运费等）。
    expect(
      PurchaseOrderFeeSchema.safeParse({ ...FEE, amount: '-20', remark: '供应商返利' }).success,
    ).toBe(true);
    expect(
      PurchaseOrderFeeSchema.safeParse({ ...FEE, amount: '-0.01', remark: '退运费' }).success,
    ).toBe(true);

    // 金额必须是 decimal 字符串；数量 / 单价仍非负。
    expect(PurchaseOrderFeeSchema.safeParse({ ...FEE, amount: -20, remark: '返利' }).success).toBe(
      false,
    );
    expect(PurchaseOrderFeeSchema.safeParse({ ...FEE, amount: '1.2345678' }).success).toBe(false);
    expect(PurchaseOrderFeeSchema.safeParse({ ...FEE, qty: '-1' }).success).toBe(false);
    expect(PurchaseOrderFeeSchema.safeParse({ ...FEE, unitPrice: -10 }).success).toBe(false);
    expect(PurchaseOrderFeeSchema.safeParse({ ...FEE, feeName: '' }).success).toBe(false);

    // 实体与开单入参同样执行该口径。
    expect(
      PurchaseOrderSchema.safeParse({ ...ORDER, fees: [{ ...FEE, amount: '-1' }] }).success,
    ).toBe(false);
    expect(
      PurchaseOrderSchema.safeParse({
        ...ORDER,
        fees: [{ ...FEE, amount: '-1', remark: '返利' }],
      }).success,
    ).toBe(true);
    expect(
      PurchaseOrderCreateInputSchema.safeParse({
        ...CREATE_INPUT,
        fees: [{ feeName: '返利', qty: '1', unitPrice: '5', amount: '-5' }],
      }).success,
    ).toBe(false);
    expect(
      PurchaseOrderCreateInputSchema.safeParse({
        ...CREATE_INPUT,
        fees: [{ feeName: '返利', qty: '1', unitPrice: '5', amount: '-5', remark: '返利' }],
      }).success,
    ).toBe(true);
  });

  it('开单入参不接收单号（D16），商品明细至少 1 行；fees 选填', () => {
    expect(PurchaseOrderCreateInputSchema.safeParse(CREATE_INPUT).success).toBe(true);
    expect(PurchaseOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, fees: undefined }).success).toBe(
      true,
    );
    expect(PurchaseOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, lines: [] }).success).toBe(false);
    expect(
      PurchaseOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, companyId: 'co-1' }).success,
    ).toBe(false);

    expect(Object.keys(PurchaseOrderCreateInputSchema.shape)).not.toContain('orderNo');
    expect(Object.keys(PurchaseOrderCreateInputSchema.shape)).not.toContain('status');
    expect(Object.keys(PurchaseOrderCreateInputSchema.shape).sort()).toEqual(
      ['companyId', 'fees', 'handlerId', 'lines', 'supplierId'].sort(),
    );
  });

  it('修改入参：至少改一个字段，且不含 companyId / orderNo / status', () => {
    expect(PurchaseOrderUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(PurchaseOrderUpdateInputSchema.safeParse({ handlerId: HANDLER_ID }).success).toBe(true);
    expect(PurchaseOrderUpdateInputSchema.safeParse({ lines: [LINE] }).success).toBe(true);
    expect(PurchaseOrderUpdateInputSchema.safeParse({ lines: [] }).success).toBe(false);
    const keys = Object.keys(PurchaseOrderUpdateInputSchema.shape);
    expect(keys).not.toContain('companyId');
    expect(keys).not.toContain('orderNo');
    expect(keys).not.toContain('status');
  });

  it('列表查询：公司/供应商/状态/关键字 + 游标分页', () => {
    expect(
      PurchaseOrderListQuerySchema.safeParse({
        companyId: COMPANY_ID,
        supplierId: SUPPLIER_ID,
        status: '进行中',
        keyword: 'A-0001',
        cursor: 'abc',
        limit: 50,
      }).success,
    ).toBe(true);
    expect(PurchaseOrderListQuerySchema.safeParse({}).success).toBe(true);
    expect(PurchaseOrderListQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
    expect(PurchaseOrderListQuerySchema.safeParse({ supplierId: 'not-a-uuid' }).success).toBe(false);
    expect(PurchaseOrderListQuerySchema.safeParse({ keyword: 'k'.repeat(65) }).success).toBe(false);
  });

  it('详情：cancelable 与 canCancel 口径一致（D21），不含收款/批次块', () => {
    expect(PurchaseOrderDetailSchema.safeParse(DETAIL).success).toBe(true);
    expect(PurchaseOrderDetailSchema.safeParse({ ...DETAIL, cancelable: undefined }).success).toBe(
      false,
    );

    expect(Object.keys(PurchaseOrderDetailSchema.shape)).toContain('cancelable');

    // cancelable 直接承载 documents.ts 的 CancelDecision，不另造词表。
    for (const decision of [
      canCancel('进行中', false),
      canCancel('进行中', true),
      canCancel('已完成', false),
      canCancel('已取消', false),
    ]) {
      expect(PurchaseOrderCancelableSchema.safeParse(decision).success, JSON.stringify(decision)).toBe(
        true,
      );
    }
    expect(
      PurchaseOrderCancelableSchema.safeParse({ allowed: false, reason: 'unknown' }).success,
    ).toBe(false);
    expect(DETAIL.cancelable).toEqual(canCancel('进行中', false));

    // 本批只有「完成/入库」端点；没有成本更正端点、也没有 S 供应商退货端点（独立契约）。
    const ids = PURCHASE_ORDER_ROUTES.map((r) => r.operationId);
    expect(ids.some((id) => /inbound|cost-correct|supplier-return|return/.test(id))).toBe(
      false,
    );
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    const names = ENTITIES.map((e) => e.name);
    for (const name of [
      'PurchaseOrder',
      'PurchaseOrderLine',
      'PurchaseOrderFee',
      'PurchaseOrderDetail',
    ]) {
      expect(names, name).toContain(name);
    }

    expect(z.globalRegistry.get(PurchaseOrderSchema)?.id).toBe('PurchaseOrder');
    expect(z.globalRegistry.get(PurchaseOrderLineViewSchema)?.id).toBe('PurchaseOrderLine');
    expect(z.globalRegistry.get(PurchaseOrderFeeViewSchema)?.id).toBe('PurchaseOrderFee');
    expect(z.globalRegistry.get(PurchaseOrderDetailSchema)?.id).toBe('PurchaseOrderDetail');

    const doc = buildOpenApiDocument(ROUTES);
    for (const name of [
      'PurchaseOrder',
      'PurchaseOrderLine',
      'PurchaseOrderFee',
      'PurchaseOrderDetail',
    ]) {
      expect(doc.components.schemas[name], name).toBeDefined();
    }
    const detail = doc.components.schemas.PurchaseOrderDetail as {
      properties: Record<string, unknown>;
    };
    expect(detail.properties).toHaveProperty('cancelable');
    const line = doc.components.schemas.PurchaseOrderLine as {
      properties: Record<string, unknown>;
    };
    expect(line.properties).not.toHaveProperty('batchIds');
  });

  it('OpenAPI 发射出 purchase 端点与 x-module / x-scope / x-audit / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);

    const orders = doc.paths['/api/v1/purchase-orders'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(orders).sort()).toEqual(['get', 'post']);
    expect(orders.get?.['x-module']).toBe('purchase');
    expect(orders.get?.['x-scope']).toBe('purchase.read');
    expect(orders.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    expect(orders.get?.['x-mcp-tool']).toBe('qingdan_purchase_order_list_read');
    const queryNames = (orders.get?.parameters as Array<{ name: string }>).map((p) => p.name).sort();
    expect(queryNames).toEqual(['companyId', 'cursor', 'keyword', 'limit', 'status', 'supplierId']);

    expect(orders.post?.['x-scope']).toBe('purchase.create');
    expect(orders.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(orders.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(orders.post?.['x-mcp-tool']).toBe('qingdan_purchase_order_create');
    expect(orders.post?.responses).toHaveProperty('201');

    const detail = doc.paths['/api/v1/purchase-orders/{id}'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(detail).sort()).toEqual(['get', 'patch']);
    expect(detail.get?.['x-mcp-tool']).toBe('qingdan_purchase_order_detail_read');
    expect(detail.patch?.['x-scope']).toBe('purchase.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);

    const cancel = doc.paths['/api/v1/purchase-orders/{id}/cancel'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(cancel.post?.['x-scope']).toBe('purchase.delete');
    expect(cancel.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(cancel.post?.['x-mcp-tool']).toBe('qingdan_purchase_order_cancel');
    expect(cancel.post?.['x-requires-if-match']).toBe(true);
  });
});
