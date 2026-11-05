import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule, validateRegistry } from './registry.js';
import { ROUTES } from './routes.js';
import {
  SUPPLIER_RETURN_ROUTES,
  SupplierReturnCreateInputSchema,
  SupplierReturnLineSchema,
  SupplierReturnSchema,
} from './supplier-returns.js';

/**
 * S 供应商退货契约（契约第一批 §4；F4c / D47 / D51 / D54）。
 *
 * F4c：只做「退钱」，不抵下次货款、不换货补发——所以**没有退货类型字段**。
 */

const COMPANY_ID = '00000000-0000-4000-8000-000000000050';
const PURCHASE_ORDER_ID = '00000000-0000-4000-8000-000000000090';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000010';
const BATCH_ID = '00000000-0000-4000-8000-000000000020';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_ID],
  qty: '2',
  unitPrice: '12.5',
  amount: '25',
} as const;

const RETURN = {
  id: 'sr-1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  returnNo: 'S-0001-20261105-0001',
  originalPurchaseOrderId: PURCHASE_ORDER_ID,
  status: '进行中',
  refundAmount: '25',
  lines: [LINE],
  remark: '退供应商',
  version: 1,
  createdAt: '2026-11-05T02:00:00.000Z',
  updatedAt: '2026-11-05T02:00:00.000Z',
} as const;

const CREATE_INPUT = {
  companyId: COMPANY_ID,
  originalPurchaseOrderId: PURCHASE_ORDER_ID,
  lines: [LINE],
  refundAmount: '25',
} as const;

const byId = new Map(SUPPLIER_RETURN_ROUTES.map((route) => [route.operationId, route]));

describe('供应商退货契约（supplier_return）', () => {
  it('3 条端点全部登记并汇总进 ROUTES，且归属 purchase', () => {
    expect(SUPPLIER_RETURN_ROUTES).toHaveLength(3);
    for (const route of SUPPLIER_RETURN_ROUTES) expect(route.module).toBe('purchase');

    const purchaseIds = routesOfModule(ROUTES, 'purchase').map((r) => r.operationId);
    for (const route of SUPPLIER_RETURN_ROUTES) expect(purchaseIds).toContain(route.operationId);
    expect(validateRegistry(ROUTES)).toEqual([]);
  });

  it('operationId / 方法 / 路径 / scope 与契约一致', () => {
    const actual = SUPPLIER_RETURN_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/supplier-returns supplier_return.list.read',
        'POST /api/v1/supplier-returns supplier_return.create',
        'GET /api/v1/supplier-returns/{id} supplier_return.detail.read',
      ].sort(),
    );

    expect(byId.get('supplier_return.list.read')?.scope).toBe('supplier_return.read');
    expect(byId.get('supplier_return.detail.read')?.scope).toBe('supplier_return.read');
    expect(byId.get('supplier_return.create')?.scope).toBe('supplier_return.create');
  });

  it('普通读不记审计；登记退货 audit=write（D51 / D54 ②）', () => {
    expect(byId.get('supplier_return.list.read')?.audit).toEqual({ kind: 'none', required: false });
    expect(byId.get('supplier_return.detail.read')?.audit).toEqual({
      kind: 'none',
      required: false,
    });
    expect(byId.get('supplier_return.create')?.audit).toEqual({ kind: 'write', required: true });
  });

  it('登记退货是冲正危险动作：AI 禁止且必须给原因；201 返回实体', () => {
    expect(byId.get('supplier_return.create')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: true,
    });
    expect(byId.get('supplier_return.create')?.response?.status).toBe(201);
    expect(byId.get('supplier_return.list.read')?.response?.status).toBe(200);
    expect(byId.get('supplier_return.detail.read')?.response?.status).toBe(200);
  });

  it('F4c：只有「退钱」一种，不造退货类型 / 换货 / 抵货款字段', () => {
    expect(Object.keys(SupplierReturnSchema.shape).sort()).toEqual(
      [
        'id',
        'tenantId',
        'companyId',
        'returnNo',
        'originalPurchaseOrderId',
        'status',
        'refundAmount',
        'lines',
        'remark',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(Object.keys(SupplierReturnCreateInputSchema.shape).sort()).toEqual(
      ['companyId', 'originalPurchaseOrderId', 'lines', 'refundAmount'].sort(),
    );

    for (const absent of ['returnType', 'refundMode', 'onlyRefundKind', 'exchange', 'offsetNextPayment']) {
      expect(Object.keys(SupplierReturnSchema.shape)).not.toContain(absent);
      expect(Object.keys(SupplierReturnCreateInputSchema.shape)).not.toContain(absent);
    }
  });

  it('refundAmount 必须是正数 decimal 字符串（F4c / D54）', () => {
    for (const invalid of ['0', '0.000000', '-1', '-0.01', 'abc', '1.2345678']) {
      expect(
        SupplierReturnCreateInputSchema.safeParse({ ...CREATE_INPUT, refundAmount: invalid })
          .success,
        invalid,
      ).toBe(false);
    }
    for (const valid of ['0.01', '10', '25.5', '999999999999.999999']) {
      expect(
        SupplierReturnCreateInputSchema.safeParse({ ...CREATE_INPUT, refundAmount: valid }).success,
        valid,
      ).toBe(true);
    }
    expect(
      SupplierReturnCreateInputSchema.safeParse({ ...CREATE_INPUT, refundAmount: 25 }).success,
    ).toBe(false);
  });

  it('入参 lines 至少 1 行，且每行至少引用 1 个批次（§5.1 / D22）', () => {
    expect(SupplierReturnCreateInputSchema.safeParse(CREATE_INPUT).success).toBe(true);
    expect(
      SupplierReturnCreateInputSchema.safeParse({ ...CREATE_INPUT, lines: [] }).success,
    ).toBe(false);
    const { lines: _lines, ...withoutLines } = CREATE_INPUT;
    expect(SupplierReturnCreateInputSchema.safeParse(withoutLines).success).toBe(false);

    expect(SupplierReturnLineSchema.safeParse({ ...LINE, batchIds: [] }).success).toBe(false);
    expect(SupplierReturnLineSchema.safeParse({ ...LINE, amount: 25 }).success).toBe(false);
  });

  it('实体字段：状态三态 / decimal / 可空备注 / 必填项', () => {
    expect(SupplierReturnSchema.safeParse(RETURN).success).toBe(true);

    for (const status of ['进行中', '已完成', '已取消']) {
      expect(SupplierReturnSchema.safeParse({ ...RETURN, status }).success, status).toBe(true);
    }
    expect(SupplierReturnSchema.safeParse({ ...RETURN, status: '已结算' }).success).toBe(false);
    expect(SupplierReturnSchema.safeParse({ ...RETURN, remark: null }).success).toBe(true);
    expect(SupplierReturnSchema.safeParse({ ...RETURN, refundAmount: 25 }).success).toBe(false);

    for (const field of [
      'id',
      'tenantId',
      'companyId',
      'returnNo',
      'originalPurchaseOrderId',
      'status',
      'refundAmount',
      'lines',
      'remark',
      'version',
      'createdAt',
      'updatedAt',
    ] as const) {
      const { [field]: _removed, ...rest } = RETURN;
      expect(SupplierReturnSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    expect(ENTITIES.map((e) => e.name)).toContain('SupplierReturn');
    expect(z.globalRegistry.get(SupplierReturnSchema)?.id).toBe('SupplierReturn');

    const doc = buildOpenApiDocument(ROUTES);
    expect(doc.components.schemas.SupplierReturn).toBeDefined();
  });

  it('OpenAPI 发射出退货端点与 x-module / x-scope / x-audit / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);
    const path = doc.paths['/api/v1/supplier-returns'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(path).sort()).toEqual(['get', 'post']);

    expect(path.get?.['x-module']).toBe('purchase');
    expect(path.get?.['x-scope']).toBe('supplier_return.read');
    expect(path.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    expect(path.get?.['x-mcp-tool']).toBe('qingdan_supplier_return_list_read');
    expect(path.get?.responses).toHaveProperty('200');

    expect(path.post?.['x-module']).toBe('purchase');
    expect(path.post?.['x-scope']).toBe('supplier_return.create');
    expect(path.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(path.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(path.post?.['x-mcp-tool']).toBe('qingdan_supplier_return_create');
    expect(path.post?.responses).toHaveProperty('201');

    const detail = doc.paths['/api/v1/supplier-returns/{id}'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(detail.get?.['x-scope']).toBe('supplier_return.read');
    expect(detail.get?.['x-mcp-tool']).toBe('qingdan_supplier_return_detail_read');
  });
});
