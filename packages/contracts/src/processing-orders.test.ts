import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEADER_STATES, canCancel } from './documents.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';
import { ROUTES } from './routes.js';
import {
  PROCESSING_ORDER_ROUTES,
  ProcessingMaterialBatchIdsSchema,
  ProcessingOrderCancelableSchema,
  ProcessingOrderCreateInputSchema,
  ProcessingOrderDetailSchema,
  ProcessingOrderFeeSchema,
  ProcessingOrderListQuerySchema,
  ProcessingOrderLossRecordSchema,
  ProcessingOrderSchema,
  ProcessingOrderStatusSchema,
  ProcessingOrderUpdateInputSchema,
} from './processing-orders.js';

/**
 * 加工单 B 契约（契约第一批 §3.2 / §5.2 / §9 / §10）。
 *
 * 这些断言锁的是「契约签名」本身，不是实现：开单 / 改单 / 取消的实现
 * 由 processing 负责人按本文件落地，改签名必须先改这里并过评审。
 */

const BATCH_ID = '00000000-0000-4000-8000-000000000020';
const BATCH_ID_2 = '00000000-0000-4000-8000-000000000021';
const PROCESSOR_ID = '00000000-0000-4000-8000-000000000030';
const HANDLER_ID = '00000000-0000-4000-8000-000000000040';
const COMPANY_ID = '00000000-0000-4000-8000-000000000050';

const FEE = {
  feeName: '加工费',
  qty: '1',
  unitPrice: '100',
  amount: '100',
  remark: null,
} as const;

const ORDER = {
  id: 'bo-1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  orderNo: 'B-0001-20261105-0001',
  processorId: PROCESSOR_ID,
  processorName: '王五加工厂',
  status: '进行中',
  handlerId: HANDLER_ID,
  materialBatchIds: [BATCH_ID],
  auxMaterials: '纸箱',
  fees: [FEE],
  inputQty: '100',
  lossQty: null,
  sellableQty: null,
  attributionDoc: null,
  version: 1,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
} as const;

const LOSS_RECORD = {
  lossQty: '100',
  amount: '460',
  recordedAt: '2026-11-05T00:00:00.000Z',
} as const;

const DETAIL = {
  ...ORDER,
  outputBatchId: null,
  lossRecord: null,
  cancelable: { allowed: true, reason: null },
} as const;

const CREATE_INPUT = {
  companyId: COMPANY_ID,
  processorId: PROCESSOR_ID,
  handlerId: HANDLER_ID,
  materialBatchIds: [BATCH_ID],
  inputQty: '100',
  auxMaterials: '纸箱',
  fees: [FEE],
  attributionDoc: null,
  lossQty: null,
} as const;

describe('加工单契约（processing）', () => {
  it('5 条端点全部登记并汇总进 ROUTES，且归属 processing', () => {
    expect(PROCESSING_ORDER_ROUTES).toHaveLength(5);
    for (const route of PROCESSING_ORDER_ROUTES) expect(route.module).toBe('processing');

    const processingIds = routesOfModule(ROUTES, 'processing').map((r) => r.operationId);
    for (const route of PROCESSING_ORDER_ROUTES) expect(processingIds).toContain(route.operationId);
  });

  it('operationId / 方法 / 路径 / scope 与契约一致', () => {
    const actual = PROCESSING_ORDER_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/processing-orders processing.order.list.read',
        'POST /api/v1/processing-orders processing.order.create',
        'GET /api/v1/processing-orders/{id} processing.order.detail.read',
        'PATCH /api/v1/processing-orders/{id} processing.order.update',
        'POST /api/v1/processing-orders/{id}/cancel processing.order.cancel',
      ].sort(),
    );

    const byId = new Map(PROCESSING_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('processing.order.list.read')?.scope).toBe('processing.read');
    expect(byId.get('processing.order.detail.read')?.scope).toBe('processing.read');
    expect(byId.get('processing.order.create')?.scope).toBe('processing.create');
    expect(byId.get('processing.order.update')?.scope).toBe('processing.update');
    expect(byId.get('processing.order.cancel')?.scope).toBe('processing.delete');
  });

  it('普通读不记审计；写操作全部 audit=write（D51）', () => {
    const byId = new Map(PROCESSING_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('processing.order.list.read')?.audit).toEqual({ kind: 'none', required: false });
    expect(byId.get('processing.order.detail.read')?.audit).toEqual({
      kind: 'none',
      required: false,
    });
    for (const id of [
      'processing.order.create',
      'processing.order.update',
      'processing.order.cancel',
    ]) {
      expect(byId.get(id)?.audit, id).toEqual({ kind: 'write', required: true });
    }
  });

  it('AI 口径：开单禁止、修改允许、取消禁止且必须给原因；update/cancel 带强 ETag', () => {
    const byId = new Map(PROCESSING_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('processing.order.create')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: false,
    });
    expect(byId.get('processing.order.update')?.ai).toEqual({
      policy: 'allow',
      reasonRequired: false,
    });
    expect(byId.get('processing.order.cancel')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: true,
    });

    expect(byId.get('processing.order.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('processing.order.cancel')?.requiresIfMatch).toBe(true);
    expect(byId.get('processing.order.create')?.requiresIfMatch).toBe(false);
    expect(byId.get('processing.order.create')?.response?.status).toBe(201);
  });

  it('状态只复用 documents.ts 的 HEADER_STATES，不另造枚举（§10）', () => {
    expect([...ProcessingOrderStatusSchema.options]).toEqual([...HEADER_STATES]);
    expect(ProcessingOrderStatusSchema.safeParse('进行中').success).toBe(true);
    expect(ProcessingOrderStatusSchema.safeParse('已完成').success).toBe(true);
    expect(ProcessingOrderStatusSchema.safeParse('已取消').success).toBe(true);
    for (const invalid of ['pending', 'completed', '取消', '加工中']) {
      expect(ProcessingOrderStatusSchema.safeParse(invalid).success, invalid).toBe(false);
    }
    expect(ProcessingOrderSchema.safeParse(ORDER).success).toBe(true);
    expect(ProcessingOrderSchema.safeParse({ ...ORDER, status: 'completed' }).success).toBe(false);
  });

  it('材料投入批次至少 1 条（F2b），空数组 / 缺失 / 非 uuid 一律拒绝', () => {
    expect(ProcessingMaterialBatchIdsSchema.safeParse([BATCH_ID]).success).toBe(true);
    expect(ProcessingMaterialBatchIdsSchema.safeParse([BATCH_ID, BATCH_ID_2]).success).toBe(true);
    expect(ProcessingMaterialBatchIdsSchema.safeParse([]).success).toBe(false);
    expect(ProcessingMaterialBatchIdsSchema.safeParse('not-an-array').success).toBe(false);
    expect(ProcessingMaterialBatchIdsSchema.safeParse(['not-a-uuid']).success).toBe(false);

    // 实体与开单入参同样执行该口径。
    expect(ProcessingOrderSchema.safeParse({ ...ORDER, materialBatchIds: [] }).success).toBe(false);
    expect(
      ProcessingOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, materialBatchIds: [] }).success,
    ).toBe(false);
    const { materialBatchIds: _omitted, ...withoutBatches } = CREATE_INPUT;
    expect(ProcessingOrderCreateInputSchema.safeParse(withoutBatches).success).toBe(false);
  });

  it('费用明细：金额负数被拒（D39，refine 校验，不只是注释）', () => {
    expect(ProcessingOrderFeeSchema.safeParse(FEE).success).toBe(true);
    expect(ProcessingOrderFeeSchema.safeParse({ ...FEE, amount: '0' }).success).toBe(true);
    expect(ProcessingOrderFeeSchema.safeParse({ ...FEE, amount: '-0.01' }).success).toBe(false);
    expect(ProcessingOrderFeeSchema.safeParse({ ...FEE, amount: '-100' }).success).toBe(false);
    // 数量 / 单价仍按非负 decimal 校验。
    expect(ProcessingOrderFeeSchema.safeParse({ ...FEE, qty: '-1' }).success).toBe(false);
    expect(ProcessingOrderFeeSchema.safeParse({ ...FEE, unitPrice: -10 }).success).toBe(false);
    expect(ProcessingOrderFeeSchema.safeParse({ ...FEE, feeName: '' }).success).toBe(false);
    expect(ProcessingOrderFeeSchema.safeParse({ ...FEE, amount: 100 }).success).toBe(false);

    expect(ProcessingOrderSchema.safeParse({ ...ORDER, fees: [{ ...FEE, amount: '-1' }] }).success).toBe(
      false,
    );
    expect(
      ProcessingOrderCreateInputSchema.safeParse({
        ...CREATE_INPUT,
        fees: [{ feeName: '运杂费', qty: '1', unitPrice: '10', amount: '-10' }],
      }).success,
    ).toBe(false);
  });

  it('数量字段是 decimal 字符串；损耗量 / 可售量可空（F3）', () => {
    expect(ProcessingOrderSchema.safeParse({ ...ORDER, inputQty: 100 }).success).toBe(false);
    expect(ProcessingOrderSchema.safeParse({ ...ORDER, inputQty: '-1' }).success).toBe(false);
    expect(ProcessingOrderSchema.safeParse({ ...ORDER, inputQty: '1.2345678' }).success).toBe(false);
    expect(ProcessingOrderSchema.safeParse({ ...ORDER, inputQty: '1.234567' }).success).toBe(true);

    expect(ProcessingOrderSchema.safeParse(ORDER).success).toBe(true);
    expect(
      ProcessingOrderSchema.safeParse({
        ...ORDER,
        lossQty: '2',
        sellableQty: '98',
        status: '已完成',
      }).success,
    ).toBe(true);
    expect(ProcessingOrderSchema.safeParse({ ...ORDER, lossQty: '-2' }).success).toBe(false);
  });

  it('归属单只接受 E / N 单号（D16 / D35），可空', () => {
    for (const doc of ['E-0001-20261105-0001', 'N-0042-20261231-9999']) {
      expect(ProcessingOrderSchema.safeParse({ ...ORDER, attributionDoc: doc }).success, doc).toBe(
        true,
      );
    }
    for (const doc of ['B-0001-20261105-0001', 'A-0001-20261105-0001', 'E-1-20261105-0001', '']) {
      expect(ProcessingOrderSchema.safeParse({ ...ORDER, attributionDoc: doc }).success, doc).toBe(
        false,
      );
    }
    expect(ProcessingOrderSchema.safeParse({ ...ORDER, attributionDoc: null }).success).toBe(true);
  });

  it('开单入参不接收单号（D16），也不接收状态 / 可售量；材料/投入量/费用为必填', () => {
    expect(ProcessingOrderCreateInputSchema.safeParse(CREATE_INPUT).success).toBe(true);
    // 辅料 / 归属单 / 损耗量选填。
    expect(
      ProcessingOrderCreateInputSchema.safeParse({
        ...CREATE_INPUT,
        auxMaterials: undefined,
        attributionDoc: undefined,
        lossQty: undefined,
      }).success,
    ).toBe(true);
    // 费用明细至少 1 行（§3.2 加工费/运杂费必填）。
    expect(
      ProcessingOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, fees: undefined }).success,
    ).toBe(false);
    expect(ProcessingOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, fees: [] }).success).toBe(
      false,
    );
    expect(
      ProcessingOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, companyId: 'co-1' }).success,
    ).toBe(false);

    const keys = Object.keys(ProcessingOrderCreateInputSchema.shape);
    expect(keys).not.toContain('orderNo');
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('sellableQty');
    expect(keys.sort()).toEqual(
      [
        'attributionDoc',
        'auxMaterials',
        'companyId',
        'fees',
        'handlerId',
        'inputQty',
        'lossQty',
        'materialBatchIds',
        'processorId',
      ].sort(),
    );
  });

  it('修改入参：至少改一个字段，不含 orderNo / status / lossQty / sellableQty', () => {
    expect(ProcessingOrderUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(ProcessingOrderUpdateInputSchema.safeParse({ handlerId: HANDLER_ID }).success).toBe(true);
    expect(
      ProcessingOrderUpdateInputSchema.safeParse({ materialBatchIds: [BATCH_ID_2] }).success,
    ).toBe(true);
    expect(ProcessingOrderUpdateInputSchema.safeParse({ materialBatchIds: [] }).success).toBe(false);
    expect(
      ProcessingOrderUpdateInputSchema.safeParse({ attributionDoc: 'E-0001-20261105-0001' }).success,
    ).toBe(true);
    expect(ProcessingOrderUpdateInputSchema.safeParse({ attributionDoc: 'B-x' }).success).toBe(false);

    const keys = Object.keys(ProcessingOrderUpdateInputSchema.shape);
    expect(keys).not.toContain('companyId');
    expect(keys).not.toContain('orderNo');
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('lossQty');
    expect(keys).not.toContain('sellableQty');
  });

  it('列表查询：公司/加工厂/状态/关键字 + 游标分页', () => {
    expect(
      ProcessingOrderListQuerySchema.safeParse({
        companyId: COMPANY_ID,
        processorId: PROCESSOR_ID,
        status: '进行中',
        keyword: 'B-0001',
        cursor: 'abc',
        limit: 50,
      }).success,
    ).toBe(true);
    expect(ProcessingOrderListQuerySchema.safeParse({}).success).toBe(true);
    expect(ProcessingOrderListQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
    expect(ProcessingOrderListQuerySchema.safeParse({ processorId: 'not-a-uuid' }).success).toBe(
      false,
    );
    expect(ProcessingOrderListQuerySchema.safeParse({ keyword: 'k'.repeat(65) }).success).toBe(false);
  });

  it('详情：产出批次占位 + 损失记录 + cancelable 与 canCancel 一致（D21 / §9 / G2）', () => {
    expect(ProcessingOrderDetailSchema.safeParse(DETAIL).success).toBe(true);
    expect(ProcessingOrderDetailSchema.safeParse({ ...DETAIL, cancelable: undefined }).success).toBe(
      false,
    );

    const keys = Object.keys(ProcessingOrderDetailSchema.shape);
    expect(keys).toContain('outputBatchId');
    expect(keys).toContain('lossRecord');
    expect(keys).toContain('cancelable');

    // 产出批次本批恒 null 占位；有值时也接受字符串（完成端点后续回填）。
    expect(ProcessingOrderDetailSchema.safeParse({ ...DETAIL, outputBatchId: 'batch-out-1' }).success).toBe(
      true,
    );

    // 损失记录精简视图：损耗量 / 损失金额 / 记录时间。
    expect(ProcessingOrderLossRecordSchema.safeParse(LOSS_RECORD).success).toBe(true);
    expect(
      ProcessingOrderLossRecordSchema.safeParse({ ...LOSS_RECORD, amount: '-1' }).success,
    ).toBe(false);
    expect(
      ProcessingOrderDetailSchema.safeParse({ ...DETAIL, lossRecord: LOSS_RECORD }).success,
    ).toBe(true);

    // cancelable 直接承载 documents.ts 的 CancelDecision，不另造词表。
    for (const decision of [
      canCancel('进行中', false),
      canCancel('进行中', true),
      canCancel('已完成', false),
      canCancel('已取消', false),
    ]) {
      expect(ProcessingOrderCancelableSchema.safeParse(decision).success, JSON.stringify(decision)).toBe(
        true,
      );
    }
    expect(
      ProcessingOrderCancelableSchema.safeParse({ allowed: false, reason: 'unknown' }).success,
    ).toBe(false);
    expect(DETAIL.cancelable).toEqual(canCancel('进行中', false));

    // 本批没有「验收/完成」端点，也没有独立损失记录端点。
    const ids = PROCESSING_ORDER_ROUTES.map((r) => r.operationId);
    expect(ids.some((id) => /complete|accept|loss/.test(id))).toBe(false);
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    const names = ENTITIES.map((e) => e.name);
    for (const name of ['ProcessingOrder', 'ProcessingOrderFee', 'ProcessingOrderDetail']) {
      expect(names, name).toContain(name);
    }

    expect(z.globalRegistry.get(ProcessingOrderSchema)?.id).toBe('ProcessingOrder');
    expect(z.globalRegistry.get(ProcessingOrderFeeSchema)?.id).toBe('ProcessingOrderFee');
    expect(z.globalRegistry.get(ProcessingOrderDetailSchema)?.id).toBe('ProcessingOrderDetail');

    const doc = buildOpenApiDocument(ROUTES);
    for (const name of ['ProcessingOrder', 'ProcessingOrderFee', 'ProcessingOrderDetail']) {
      expect(doc.components.schemas[name], name).toBeDefined();
    }
    const detail = doc.components.schemas.ProcessingOrderDetail as {
      properties: Record<string, unknown>;
    };
    expect(detail.properties).toHaveProperty('outputBatchId');
    expect(detail.properties).toHaveProperty('lossRecord');
    expect(detail.properties).toHaveProperty('cancelable');
    const order = doc.components.schemas.ProcessingOrder as {
      properties: Record<string, unknown>;
    };
    expect(order.properties).toHaveProperty('materialBatchIds');
    expect(order.properties).toHaveProperty('inputQty');
    expect(order.properties).toHaveProperty('sellableQty');
  });

  it('OpenAPI 发射出 processing 端点与 x-module / x-scope / x-audit / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);

    const orders = doc.paths['/api/v1/processing-orders'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(orders).sort()).toEqual(['get', 'post']);
    expect(orders.get?.['x-module']).toBe('processing');
    expect(orders.get?.['x-scope']).toBe('processing.read');
    expect(orders.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    expect(orders.get?.['x-mcp-tool']).toBe('qingdan_processing_order_list_read');
    const queryNames = (orders.get?.parameters as Array<{ name: string }>).map((p) => p.name).sort();
    expect(queryNames).toEqual(['companyId', 'cursor', 'keyword', 'limit', 'processorId', 'status']);

    expect(orders.post?.['x-scope']).toBe('processing.create');
    expect(orders.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(orders.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(orders.post?.['x-mcp-tool']).toBe('qingdan_processing_order_create');
    expect(orders.post?.responses).toHaveProperty('201');

    const detail = doc.paths['/api/v1/processing-orders/{id}'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(detail).sort()).toEqual(['get', 'patch']);
    expect(detail.get?.['x-mcp-tool']).toBe('qingdan_processing_order_detail_read');
    expect(detail.patch?.['x-scope']).toBe('processing.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);

    const cancel = doc.paths['/api/v1/processing-orders/{id}/cancel'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(cancel.post?.['x-scope']).toBe('processing.delete');
    expect(cancel.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(cancel.post?.['x-mcp-tool']).toBe('qingdan_processing_order_cancel');
    expect(cancel.post?.['x-requires-if-match']).toBe(true);
  });
});
