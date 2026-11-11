import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEADER_STATES, canCancel } from './documents.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';
import { ROUTES } from './routes.js';
import {
  INTERNAL_TRADE_ORDER_ROUTES,
  INTERNAL_TRADE_ORDER_STATES,
  InternalTradeBatchIdsSchema,
  InternalTradeOrderCancelableSchema,
  InternalTradeOrderCreateInputSchema,
  InternalTradeOrderDetailSchema,
  InternalTradeOrderLineInputSchema,
  InternalTradeOrderLineSchema,
  InternalTradeOrderListQuerySchema,
  InternalTradeOrderSchema,
  InternalTradeOrderStatusSchema,
  InternalTradeOrderUpdateInputSchema,
  internalTradeCancelable,
  internalTradeHeaderState,
} from './internal-trade-orders.js';

/**
 * 内部交易单 N 契约（契约第二批 §1 / §3；D22 / D29 / D31 / D45 / D68）。
 *
 * 这些断言锁的是「契约签名」本身，不是实现：开单 / 改单 / 取消的实现
 * 由 internal-trade 负责人按本文件落地，改签名必须先改这里并过评审。
 */

const PRODUCT_ID = '00000000-0000-4000-8000-000000000010';
const BATCH_ID = '00000000-0000-4000-8000-000000000020';
const BATCH_ID_2 = '00000000-0000-4000-8000-000000000021';
const FROM_COMPANY_ID = '00000000-0000-4000-8000-000000000050';
const TO_COMPANY_ID = '00000000-0000-4000-8000-000000000051';
const HANDLER_ID = '00000000-0000-4000-8000-000000000040';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_ID],
  qty: '2',
  unitPrice: '12.5',
  amount: '25',
} as const;

const ORDER = {
  id: 'nt-1',
  tenantId: 't1',
  fromCompanyId: FROM_COMPANY_ID,
  fromCompanyName: '总部',
  toCompanyId: TO_COMPANY_ID,
  toCompanyName: '华南分公司',
  orderNo: 'N-0001-20261105-0001',
  status: '进行中',
  handlerId: HANDLER_ID,
  lines: [LINE],
  internalPrice: '10.5',
  inTransitQty: '2',
  version: 1,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
} as const;

const DETAIL = {
  ...ORDER,
  cancelable: { allowed: true, reason: null },
} as const;

const CREATE_INPUT = {
  fromCompanyId: FROM_COMPANY_ID,
  toCompanyId: TO_COMPANY_ID,
  handlerId: HANDLER_ID,
  lines: [LINE],
  internalPrice: '10.5',
} as const;

describe('内部交易单契约（internal-trade）', () => {
  it('6 条端点全部登记并汇总进 ROUTES，且归属 internal-trade', () => {
    expect(INTERNAL_TRADE_ORDER_ROUTES).toHaveLength(6);
    for (const route of INTERNAL_TRADE_ORDER_ROUTES) expect(route.module).toBe('internal-trade');

    const internalTradeIds = routesOfModule(ROUTES, 'internal-trade').map((r) => r.operationId);
    for (const route of INTERNAL_TRADE_ORDER_ROUTES) {
      expect(internalTradeIds).toContain(route.operationId);
    }
  });

  it('operationId / 方法 / 路径 / scope 与契约一致（scope 用下划线域）', () => {
    const actual = INTERNAL_TRADE_ORDER_ROUTES.map(
      (r) => `${r.method} ${r.path} ${r.operationId}`,
    ).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/internal-trade-orders internal_trade.order.list.read',
        'POST /api/v1/internal-trade-orders internal_trade.order.create',
        'GET /api/v1/internal-trade-orders/{id} internal_trade.order.detail.read',
        'PATCH /api/v1/internal-trade-orders/{id} internal_trade.order.update',
        'POST /api/v1/internal-trade-orders/{id}/cancel internal_trade.order.cancel',
        'POST /api/v1/internal-trade-orders/{id}/receive internal_trade.order.receive',
      ].sort(),
    );

    const byId = new Map(INTERNAL_TRADE_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('internal_trade.order.list.read')?.scope).toBe('internal_trade.read');
    expect(byId.get('internal_trade.order.detail.read')?.scope).toBe('internal_trade.read');
    expect(byId.get('internal_trade.order.create')?.scope).toBe('internal_trade.create');
    expect(byId.get('internal_trade.order.update')?.scope).toBe('internal_trade.update');
    expect(byId.get('internal_trade.order.cancel')?.scope).toBe('internal_trade.delete');

    // 域键必须是已有的下划线键，不是模块键的连字符形式。
    for (const route of INTERNAL_TRADE_ORDER_ROUTES) expect(route.domain).toBe('internal_trade');
  });

  it('普通读不记审计；写操作全部 audit=write（D51）', () => {
    const byId = new Map(INTERNAL_TRADE_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('internal_trade.order.list.read')?.audit).toEqual({
      kind: 'none',
      required: false,
    });
    expect(byId.get('internal_trade.order.detail.read')?.audit).toEqual({
      kind: 'none',
      required: false,
    });
    for (const id of [
      'internal_trade.order.create',
      'internal_trade.order.update',
      'internal_trade.order.cancel',
      'internal_trade.order.receive',
    ]) {
      expect(byId.get(id)?.audit, id).toEqual({ kind: 'write', required: true });
    }
  });

  it('AI 口径：开单禁止、修改允许、取消禁止且必须给原因；update/cancel 带强 ETag；create 201', () => {
    const byId = new Map(INTERNAL_TRADE_ORDER_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('internal_trade.order.create')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: false,
    });
    expect(byId.get('internal_trade.order.update')?.ai).toEqual({
      policy: 'allow',
      reasonRequired: false,
    });
    expect(byId.get('internal_trade.order.cancel')?.ai).toEqual({
      policy: 'forbid',
      reasonRequired: true,
    });

    expect(byId.get('internal_trade.order.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('internal_trade.order.cancel')?.requiresIfMatch).toBe(true);
    expect(byId.get('internal_trade.order.receive')?.requiresIfMatch).toBe(true);
    expect(byId.get('internal_trade.order.create')?.requiresIfMatch).toBe(false);
    expect(byId.get('internal_trade.order.create')?.response?.status).toBe(201);
    expect(byId.get('internal_trade.order.list.read')?.response?.status).toBe(200);
  });

  it('状态是独立四态，不复用 HEADER_STATES（D68②）', () => {
    expect([...InternalTradeOrderStatusSchema.options]).toEqual([...INTERNAL_TRADE_ORDER_STATES]);
    expect([...InternalTradeOrderStatusSchema.options]).toEqual([
      '进行中',
      '在途',
      '已完成',
      '已取消',
    ]);
    expect([...InternalTradeOrderStatusSchema.options]).not.toEqual([...HEADER_STATES]);

    // 与单据框架三态的差异只有 `在途` 一个：HEADER 三态全部保留，额外多一态。
    const extra = [...InternalTradeOrderStatusSchema.options].filter(
      (state) => !(HEADER_STATES as readonly string[]).includes(state),
    );
    expect(extra).toEqual(['在途']);

    for (const valid of ['进行中', '在途', '已完成', '已取消']) {
      expect(InternalTradeOrderStatusSchema.safeParse(valid).success, valid).toBe(true);
    }
    for (const invalid of ['pending', 'in_transit', 'completed', '取消', '待发货']) {
      expect(InternalTradeOrderStatusSchema.safeParse(invalid).success, invalid).toBe(false);
    }

    expect(InternalTradeOrderSchema.safeParse(ORDER).success).toBe(true);
    expect(InternalTradeOrderSchema.safeParse({ ...ORDER, status: '在途' }).success).toBe(true);
    expect(InternalTradeOrderSchema.safeParse({ ...ORDER, status: 'completed' }).success).toBe(false);
  });

  it('明细 batchIds 至少 1 条（D22，引用发出公司批次），空数组 / 缺失 / 非 uuid 一律拒绝', () => {
    expect(InternalTradeBatchIdsSchema.safeParse([BATCH_ID]).success).toBe(true);
    expect(InternalTradeBatchIdsSchema.safeParse([BATCH_ID, BATCH_ID_2]).success).toBe(true);
    expect(InternalTradeBatchIdsSchema.safeParse([]).success).toBe(false);
    expect(InternalTradeBatchIdsSchema.safeParse('not-an-array').success).toBe(false);
    expect(InternalTradeBatchIdsSchema.safeParse(['not-a-uuid']).success).toBe(false);

    // 明细 / 实体 / 开单入参同样执行该口径。
    expect(InternalTradeOrderLineSchema.safeParse({ ...LINE, batchIds: [] }).success).toBe(false);
    const { batchIds: _omitted, ...withoutBatches } = LINE;
    expect(InternalTradeOrderLineSchema.safeParse(withoutBatches).success).toBe(false);
    expect(InternalTradeOrderSchema.safeParse({ ...ORDER, lines: [{ ...LINE, batchIds: [] }] }).success).toBe(
      false,
    );
    expect(
      InternalTradeOrderCreateInputSchema.safeParse({
        ...CREATE_INPUT,
        lines: [{ ...LINE, batchIds: [] }],
      }).success,
    ).toBe(false);

    // 明细字段固定，金额是 decimal 字符串。
    expect(Object.keys(InternalTradeOrderLineSchema.shape).sort()).toEqual(
      ['amount', 'batchIds', 'productId', 'qty', 'unitPrice'].sort(),
    );
    for (const field of ['qty', 'unitPrice', 'amount'] as const) {
      expect(InternalTradeOrderLineSchema.safeParse({ ...LINE, [field]: 1 }).success, field).toBe(
        false,
      );
      expect(InternalTradeOrderLineSchema.safeParse({ ...LINE, [field]: '-1' }).success, field).toBe(
        false,
      );
      expect(
        InternalTradeOrderLineSchema.safeParse({ ...LINE, [field]: '1.2345678' }).success,
        field,
      ).toBe(false);
    }
    expect(InternalTradeOrderLineSchema.safeParse({ ...LINE, qty: '1.234567' }).success).toBe(true);
  });

  it('internalPrice 是制单人手填的 decimal 字符串，系统不自动算（D68①）', () => {
    expect(InternalTradeOrderSchema.safeParse(ORDER).success).toBe(true);
    for (const valid of ['0', '10.5', '1.234567']) {
      expect(
        InternalTradeOrderSchema.safeParse({ ...ORDER, internalPrice: valid }).success,
        valid,
      ).toBe(true);
      expect(
        InternalTradeOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, internalPrice: valid })
          .success,
        valid,
      ).toBe(true);
    }
    for (const invalid of [10.5, '-1', '1.2345678', 'abc']) {
      expect(
        InternalTradeOrderSchema.safeParse({ ...ORDER, internalPrice: invalid }).success,
        String(invalid),
      ).toBe(false);
      expect(
        InternalTradeOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, internalPrice: invalid })
          .success,
        String(invalid),
      ).toBe(false);
    }
    // D79：实体视图允许 null（无 internal_trade.view_price 时脱敏），开单入参仍必填。
    expect(InternalTradeOrderSchema.safeParse({ ...ORDER, internalPrice: null }).success).toBe(
      true,
    );
    expect(
      InternalTradeOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, internalPrice: null }).success,
    ).toBe(false);
    // 明细同理：实体视图金额可为 null，写入 schema 不接受 null、也不接受漏填。
    expect(
      InternalTradeOrderLineSchema.safeParse({ ...LINE, unitPrice: null, amount: null }).success,
    ).toBe(true);
    expect(
      InternalTradeOrderLineInputSchema.safeParse({ ...LINE, unitPrice: null }).success,
    ).toBe(false);
    const { unitPrice: _noUnitPrice, ...lineWithoutPrice } = LINE;
    expect(InternalTradeOrderLineInputSchema.safeParse(lineWithoutPrice).success).toBe(false);
    // 内部价必填，不从成本价 / 加成自动推导。
    const { internalPrice: _omitted, ...withoutPrice } = CREATE_INPUT;
    expect(InternalTradeOrderCreateInputSchema.safeParse(withoutPrice).success).toBe(false);

    // 在途量同样是 decimal 字符串；非负。
    expect(InternalTradeOrderSchema.safeParse({ ...ORDER, inTransitQty: 2 }).success).toBe(false);
    expect(InternalTradeOrderSchema.safeParse({ ...ORDER, inTransitQty: '-1' }).success).toBe(false);
    expect(InternalTradeOrderSchema.safeParse({ ...ORDER, inTransitQty: '1.234567' }).success).toBe(
      true,
    );
  });

  it('开单入参：不接收单号 / 状态 / 在途量，明细至少 1 行（D16 / D68②）', () => {
    expect(InternalTradeOrderCreateInputSchema.safeParse(CREATE_INPUT).success).toBe(true);
    expect(
      InternalTradeOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, lines: [] }).success,
    ).toBe(false);
    expect(
      InternalTradeOrderCreateInputSchema.safeParse({ ...CREATE_INPUT, fromCompanyId: 'co-1' })
        .success,
    ).toBe(false);

    const keys = Object.keys(InternalTradeOrderCreateInputSchema.shape);
    expect(keys).not.toContain('orderNo');
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('inTransitQty');
    expect(keys).not.toContain('fromCompanyName');
    expect(keys).not.toContain('toCompanyName');
    expect(keys.sort()).toEqual(
      ['fromCompanyId', 'handlerId', 'internalPrice', 'lines', 'toCompanyId'].sort(),
    );
  });

  it('修改入参：至少改一个字段，且不含单号 / 状态 / 公司 / 在途量', () => {
    expect(InternalTradeOrderUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(InternalTradeOrderUpdateInputSchema.safeParse({ handlerId: HANDLER_ID }).success).toBe(
      true,
    );
    expect(
      InternalTradeOrderUpdateInputSchema.safeParse({ internalPrice: '20' }).success,
    ).toBe(true);
    expect(
      InternalTradeOrderUpdateInputSchema.safeParse({ lines: [{ ...LINE, batchIds: [] }] }).success,
    ).toBe(false);

    const keys = Object.keys(InternalTradeOrderUpdateInputSchema.shape);
    expect(keys).not.toContain('fromCompanyId');
    expect(keys).not.toContain('toCompanyId');
    expect(keys).not.toContain('orderNo');
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('inTransitQty');
    expect(keys.sort()).toEqual(['handlerId', 'internalPrice', 'lines'].sort());
  });

  it('列表查询：发出/接收公司、状态、关键字 + 游标分页', () => {
    expect(
      InternalTradeOrderListQuerySchema.safeParse({
        fromCompanyId: FROM_COMPANY_ID,
        toCompanyId: TO_COMPANY_ID,
        status: '在途',
        keyword: 'N-0001',
        cursor: 'abc',
        limit: 50,
      }).success,
    ).toBe(true);
    expect(InternalTradeOrderListQuerySchema.safeParse({}).success).toBe(true);
    expect(InternalTradeOrderListQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
    expect(
      InternalTradeOrderListQuerySchema.safeParse({ toCompanyId: 'not-a-uuid' }).success,
    ).toBe(false);
    expect(InternalTradeOrderListQuerySchema.safeParse({ keyword: 'k'.repeat(65) }).success).toBe(
      false,
    );
  });

  it('详情：cancelable 按四态映射后复用 canCancel（D21 / D68②）', () => {
    expect(InternalTradeOrderDetailSchema.safeParse(DETAIL).success).toBe(true);
    expect(InternalTradeOrderDetailSchema.safeParse({ ...DETAIL, cancelable: undefined }).success).toBe(
      false,
    );

    // 进行中 / 在途都是非终态，按 `进行中` 参与取消判定；已完成 / 已取消原样映射。
    expect(internalTradeHeaderState('进行中')).toBe('进行中');
    expect(internalTradeHeaderState('在途')).toBe('进行中');
    expect(internalTradeHeaderState('已完成')).toBe('已完成');
    expect(internalTradeHeaderState('已取消')).toBe('已取消');

    expect(internalTradeCancelable('进行中', false)).toEqual(canCancel('进行中', false));
    expect(internalTradeCancelable('在途', false)).toEqual({ allowed: true, reason: null });
    expect(internalTradeCancelable('在途', true)).toEqual({
      allowed: false,
      reason: 'has_downstream',
    });
    expect(internalTradeCancelable('已完成', false).reason).toBe('already_completed');
    expect(internalTradeCancelable('已取消', false).reason).toBe('already_cancelled');

    // cancelable 直接承载 documents.ts 的 CancelDecision，不另造词表。
    for (const decision of [
      internalTradeCancelable('进行中', false),
      internalTradeCancelable('在途', true),
      internalTradeCancelable('已完成', false),
      internalTradeCancelable('已取消', false),
    ]) {
      expect(
        InternalTradeOrderCancelableSchema.safeParse(decision).success,
        JSON.stringify(decision),
      ).toBe(true);
    }
    expect(
      InternalTradeOrderCancelableSchema.safeParse({ allowed: false, reason: 'unknown' }).success,
    ).toBe(false);

    // 当前仍没有「发货 / 在途」和「自动生成 C 单」端点；到货确认已登记，等待实现侧接线。
    const ids = INTERNAL_TRADE_ORDER_ROUTES.map((r) => r.operationId);
    expect(ids).toContain('internal_trade.order.receive');
    expect(ids.some((id) => /ship|transit|complete|settle|price-rule/.test(id))).toBe(false);
  });

  it('实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    const names = ENTITIES.map((e) => e.name);
    for (const name of [
      'InternalTradeOrder',
      'InternalTradeOrderLine',
      'InternalTradeOrderDetail',
    ]) {
      expect(names, name).toContain(name);
    }

    expect(z.globalRegistry.get(InternalTradeOrderSchema)?.id).toBe('InternalTradeOrder');
    expect(z.globalRegistry.get(InternalTradeOrderLineSchema)?.id).toBe('InternalTradeOrderLine');
    expect(z.globalRegistry.get(InternalTradeOrderDetailSchema)?.id).toBe(
      'InternalTradeOrderDetail',
    );

    const doc = buildOpenApiDocument(ROUTES);
    for (const name of [
      'InternalTradeOrder',
      'InternalTradeOrderLine',
      'InternalTradeOrderDetail',
    ]) {
      expect(doc.components.schemas[name], name).toBeDefined();
    }
    const detail = doc.components.schemas.InternalTradeOrderDetail as {
      properties: Record<string, unknown>;
    };
    expect(detail.properties).toHaveProperty('cancelable');
    const order = doc.components.schemas.InternalTradeOrder as {
      properties: Record<string, unknown>;
    };
    for (const field of [
      'fromCompanyId',
      'fromCompanyName',
      'toCompanyId',
      'toCompanyName',
      'internalPrice',
      'inTransitQty',
    ]) {
      expect(order.properties).toHaveProperty(field);
    }
    const line = doc.components.schemas.InternalTradeOrderLine as {
      properties: Record<string, unknown>;
    };
    expect(line.properties).toHaveProperty('batchIds');
  });

  it('OpenAPI 发射出 internal-trade 端点与 x-module / x-scope / x-audit / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);

    const orders = doc.paths['/api/v1/internal-trade-orders'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(orders).sort()).toEqual(['get', 'post']);
    expect(orders.get?.['operationId']).toBe('internal_trade.order.list.read');
    expect(orders.get?.['x-module']).toBe('internal-trade');
    expect(orders.get?.['x-scope']).toBe('internal_trade.read');
    expect(orders.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    // MCP 工具名保持全小写下划线，与功能域一致。
    expect(orders.get?.['x-mcp-tool']).toBe('qingdan_internal_trade_order_list_read');
    const queryNames = (orders.get?.parameters as Array<{ name: string }>).map((p) => p.name).sort();
    expect(queryNames).toEqual([
      'cursor',
      'fromCompanyId',
      'keyword',
      'limit',
      'status',
      'toCompanyId',
    ]);

    expect(orders.post?.['x-scope']).toBe('internal_trade.create');
    expect(orders.post?.['x-audit']).toEqual({ kind: 'write', required: true });
    expect(orders.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(orders.post?.['x-mcp-tool']).toBe('qingdan_internal_trade_order_create');
    expect(orders.post?.responses).toHaveProperty('201');

    const detail = doc.paths['/api/v1/internal-trade-orders/{id}'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(detail).sort()).toEqual(['get', 'patch']);
    expect(detail.get?.['x-mcp-tool']).toBe('qingdan_internal_trade_order_detail_read');
    expect(detail.patch?.['x-scope']).toBe('internal_trade.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);

    const cancel = doc.paths['/api/v1/internal-trade-orders/{id}/cancel'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(cancel.post?.['x-scope']).toBe('internal_trade.delete');
    expect(cancel.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
    expect(cancel.post?.['x-mcp-tool']).toBe('qingdan_internal_trade_order_cancel');
    expect(cancel.post?.['x-requires-if-match']).toBe(true);
  });
});
