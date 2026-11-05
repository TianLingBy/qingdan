import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule, validateRegistry } from './registry.js';
import { ROUTES } from './routes.js';
import { SalesOrderDetailSchema } from './sales-orders.js';
import {
  SALES_RECEIPT_ROUTES,
  SalesReceiptCreateInputSchema,
  SalesReceiptDirectionSchema,
  SalesReceiptMethodSchema,
  SalesReceiptSchema,
} from './sales-receipts.js';

/**
 * 收款记录契约（契约第一批 §6，内嵌 E 单详情页，D24 / D34 / D40 / D51 / D54）。
 *
 * 这些断言锁的是「契约签名与钱账口径」本身，不是实现：
 * 列表 / 追加收款的实现由 sales 负责人后续落地，改签名必须先改这里并过评审。
 */

const COMPANY_ID = '00000000-0000-4000-8000-000000000050';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000030';
const HANDLER_ID = '00000000-0000-4000-8000-000000000040';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000010';
const BATCH_ID = '00000000-0000-4000-8000-000000000020';
const REVERSAL_ID = '00000000-0000-4000-8000-000000000060';

const RECEIPT = {
  id: 'sr-1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  salesOrderId: 'so-1',
  direction: '收款',
  amount: '25',
  method: '线下转账',
  occurredAt: '2026-11-05T02:00:00.000Z',
  reversalDocId: null,
  remark: '首款',
  version: 1,
  createdAt: '2026-11-05T02:00:00.000Z',
  updatedAt: '2026-11-05T02:00:00.000Z',
} as const;

const REFUND = {
  ...RECEIPT,
  id: 'sr-2',
  direction: '退款',
  amount: '-10',
  method: '原路退款',
  reversalDocId: REVERSAL_ID,
  remark: '仅退款（纠收款）',
} as const;

const CREATE_INPUT = {
  direction: '收款',
  amount: '25',
  method: '线下转账',
  occurredAt: '2026-11-05T02:00:00.000Z',
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
  lines: [
    {
      productId: PRODUCT_ID,
      batchIds: [BATCH_ID],
      qty: '2',
      unitPrice: '12.5',
      amount: '25',
    },
  ],
  fees: [],
  totalAmount: '45',
  version: 1,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
} as const;

const DETAIL = {
  ...ORDER,
  receipts: [RECEIPT, REFUND],
  receiptBalance: '15',
  cancelable: { allowed: true, reason: null },
} as const;

describe('收款记录契约（sales.receipt）', () => {
  it('2 条端点全部登记并汇总进 ROUTES，且归属 sales', () => {
    expect(SALES_RECEIPT_ROUTES).toHaveLength(2);
    for (const route of SALES_RECEIPT_ROUTES) expect(route.module).toBe('sales');

    const salesIds = routesOfModule(ROUTES, 'sales').map((r) => r.operationId);
    for (const route of SALES_RECEIPT_ROUTES) expect(salesIds).toContain(route.operationId);
    expect(validateRegistry(ROUTES)).toEqual([]);
  });

  it('operationId / 方法 / 路径 / scope 与契约一致', () => {
    const actual = SALES_RECEIPT_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/sales-orders/{id}/receipts sales.receipt.read',
        'POST /api/v1/sales-orders/{id}/receipts sales.receipt.create',
      ].sort(),
    );

    const byId = new Map(SALES_RECEIPT_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('sales.receipt.read')?.scope).toBe('sales.read');
    expect(byId.get('sales.receipt.create')?.scope).toBe('sales.update');
  });

  it('普通读不记审计；追加收款 audit=write（D51）', () => {
    const byId = new Map(SALES_RECEIPT_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('sales.receipt.read')?.audit).toEqual({ kind: 'none', required: false });
    expect(byId.get('sales.receipt.create')?.audit).toEqual({ kind: 'write', required: true });
  });

  it('追加收款是钱账危险动作：AI 禁止且必须给原因；201 返回实体', () => {
    const byId = new Map(SALES_RECEIPT_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('sales.receipt.create')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: true,
    });
    expect(byId.get('sales.receipt.create')?.response?.status).toBe(201);
    expect(byId.get('sales.receipt.read')?.response?.status).toBe(200);
  });

  it('方向 / 方式枚举封闭（§6）', () => {
    expect([...SalesReceiptDirectionSchema.options]).toEqual(['收款', '退款']);
    expect([...SalesReceiptMethodSchema.options]).toEqual([
      '在线支付回调',
      '线下转账',
      '原路退款',
      '冲抵应收',
    ]);
    for (const invalid of ['payment', 'refund', '正常', '现金']) {
      expect(SalesReceiptDirectionSchema.safeParse(invalid).success, invalid).toBe(false);
    }
    for (const invalid of ['现金', '微信', '支付宝', '转账']) {
      expect(SalesReceiptMethodSchema.safeParse(invalid).success, invalid).toBe(false);
    }
  });

  it('退款必须负数、收款必须正数（refine，不只是注释）', () => {
    expect(SalesReceiptSchema.safeParse(RECEIPT).success).toBe(true);
    expect(SalesReceiptSchema.safeParse(REFUND).success).toBe(true);
    expect(SalesReceiptSchema.safeParse({ ...REFUND, amount: '-0.01' }).success).toBe(true);
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, amount: '0.01' }).success).toBe(true);

    // 方向与符号不一致 → 拒绝。
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, amount: '-25' }).success).toBe(false);
    expect(SalesReceiptSchema.safeParse({ ...REFUND, amount: '10' }).success).toBe(false);
    // 零额两边都不允许。
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, amount: '0' }).success).toBe(false);
    expect(SalesReceiptSchema.safeParse({ ...REFUND, amount: '-0' }).success).toBe(false);
    // 非 decimal 字符串仍被拒（D54）。
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, amount: 25 }).success).toBe(false);
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, amount: '1.2345678' }).success).toBe(false);
  });

  it('实体字段：可空项 / 备注长度 / 时间格式 / 十进制金额', () => {
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, reversalDocId: null }).success).toBe(true);
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, remark: null }).success).toBe(true);
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, remark: 'x'.repeat(200) }).success).toBe(true);
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, remark: 'x'.repeat(201) }).success).toBe(false);
    expect(SalesReceiptSchema.safeParse({ ...RECEIPT, reversalDocId: 'r-1' }).success).toBe(false);
    expect(
      SalesReceiptSchema.safeParse({ ...RECEIPT, occurredAt: '2026-11-05 02:00' }).success,
    ).toBe(false);
    for (const field of ['id', 'tenantId', 'companyId', 'salesOrderId', 'direction', 'amount', 'method', 'occurredAt', 'reversalDocId', 'remark', 'version', 'createdAt', 'updatedAt'] as const) {
      const { [field]: _removed, ...rest } = RECEIPT;
      expect(SalesReceiptSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it('追加入参只收客户端字段：服务端生成字段一律不在 shape', () => {
    expect(SalesReceiptCreateInputSchema.safeParse(CREATE_INPUT).success).toBe(true);
    expect(
      SalesReceiptCreateInputSchema.safeParse({ ...CREATE_INPUT, reversalDocId: REVERSAL_ID }).success,
    ).toBe(true);
    expect(SalesReceiptCreateInputSchema.safeParse({ ...CREATE_INPUT, remark: null }).success).toBe(
      true,
    );

    const keys = Object.keys(SalesReceiptCreateInputSchema.shape).sort();
    expect(keys).toEqual(
      ['amount', 'direction', 'method', 'occurredAt', 'remark', 'reversalDocId'].sort(),
    );
    for (const serverField of [
      'id',
      'tenantId',
      'companyId',
      'salesOrderId',
      'version',
      'createdAt',
      'updatedAt',
      'receiptBalance',
    ]) {
      expect(keys).not.toContain(serverField);
    }
    // 入参同样锁符号：退款不得传正数。
    expect(
      SalesReceiptCreateInputSchema.safeParse({ ...CREATE_INPUT, direction: '退款' }).success,
    ).toBe(false);
    expect(
      SalesReceiptCreateInputSchema.safeParse({ ...CREATE_INPUT, direction: '退款', amount: '-25' })
        .success,
    ).toBe(true);
  });

  it('销售单详情：receipts 已换成 SalesReceipt，receiptBalance 为必填计算值', () => {
    expect(SalesOrderDetailSchema.safeParse(DETAIL).success).toBe(true);
    expect(SalesOrderDetailSchema.safeParse({ ...DETAIL, receipts: [] }).success).toBe(true);

    // 旧占位 z.unknown[] 会放过任意对象，新契约必须拒绝。
    expect(SalesOrderDetailSchema.safeParse({ ...DETAIL, receipts: [{ foo: 'bar' }] }).success).toBe(
      false,
    );
    expect(
      SalesOrderDetailSchema.safeParse({ ...DETAIL, receipts: [{ ...REFUND, amount: '10' }] })
        .success,
    ).toBe(false);

    // receiptBalance 必填且是 decimal 字符串；客户端不能借详情入参传（详情只读）。
    const { receiptBalance: _balance, ...withoutBalance } = DETAIL;
    expect(SalesOrderDetailSchema.safeParse(withoutBalance).success).toBe(false);
    expect(SalesOrderDetailSchema.safeParse({ ...DETAIL, receiptBalance: '15.5' }).success).toBe(
      true,
    );
    expect(SalesOrderDetailSchema.safeParse({ ...DETAIL, receiptBalance: 15 }).success).toBe(false);
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    expect(ENTITIES.map((e) => e.name)).toContain('SalesReceipt');
    expect(z.globalRegistry.get(SalesReceiptSchema)?.id).toBe('SalesReceipt');

    const doc = buildOpenApiDocument(ROUTES);
    expect(doc.components.schemas.SalesReceipt).toBeDefined();

    const detail = doc.components.schemas.SalesOrderDetail as {
      properties: Record<string, { items?: { $ref?: string }; type?: string }>;
      required: string[];
    };
    expect(detail.properties.receipts?.items?.$ref).toBe('#/components/schemas/SalesReceipt');
    expect(detail.properties.receiptBalance?.type).toBe('string');
    expect(detail.required).toContain('receipts');
    expect(detail.required).toContain('receiptBalance');
  });

  it('OpenAPI 发射出收款端点与 x-module / x-scope / x-audit / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);
    const receipts = doc.paths['/api/v1/sales-orders/{id}/receipts'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(receipts).sort()).toEqual(['get', 'post']);

    expect(receipts.get?.['x-module']).toBe('sales');
    expect(receipts.get?.['x-scope']).toBe('sales.read');
    expect(receipts.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    expect(receipts.get?.['x-mcp-tool']).toBe('qingdan_sales_receipt_read');
    expect(receipts.get?.responses).toHaveProperty('200');

    expect(receipts.post?.['x-module']).toBe('sales');
    expect(receipts.post?.['x-scope']).toBe('sales.update');
    expect(receipts.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(receipts.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(receipts.post?.['x-mcp-tool']).toBe('qingdan_sales_receipt_create');
    expect(receipts.post?.responses).toHaveProperty('201');
  });
});
