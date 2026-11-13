import { z } from 'zod';
import {
  canCancel,
  type CancelDecision,
  type HeaderState,
} from './documents.js';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 内部交易单 N 契约（契约第二批 §1 / §3，第一批切）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **N 单状态是独立四态**（D68②）：进行中 / 在途 / 已完成 / 已取消。
 *   **不复用** `documents.ts` 的 `HEADER_STATES`：`在途` 是 N 单特有的中间态，
 *   塞进单据框架三态会污染 A/B/E 单的状态机；
 * - **取消规则仍复用** `documents.ts` 的 `canCancel` / `assertCancelable`（D21）：
 *   `进行中` / `在途` 都是非终态（按 `进行中` 参与判定），`已完成` / `已取消` 不可取消；
 *   映射见 `internalTradeHeaderState`，本文件不重写一套级联判断；
 * - **内部价由制单人手填，系统不自动计算**（D68①）；一期不做内部定价规则表（§3 / D45）；
 * - **明细必须引用发出公司（`fromCompanyId`）的批次**（D22）：`batchIds` 至少 1 条；
 *   批次归属校验由实现侧做，schema 层只锁非空与 uuid 形状；
 * - **在途期间批次公司字段不变（仍归发出方），收货方确认到货时才转司**（D22 / D31 / D68③）；
 *   在途量 `inTransitQty` 是锁定量的只读回显；
 * - 金额与数量一律 **decimal 字符串**（D54 `numeric(18,6)`），不用 `number`；
 * - **单号由服务端按 D16 生成**（格式 `N-<公司码4>-<日期8>-<流水4>`），创建入参不接收 `orderNo`；
 * - 写操作必记审计（D51）；普通读不记（D54 ②）。
 *
 * 本批明确不做（写进契约，防止后续顺手加端点）：
 * - **不做「发货 / 在途」端点**：进入在途要按 D31 锁定批次可用量（在途占用），依赖 inventory 写能力；
 * - **不做「到货确认 / 转司」端点**：转司要在同一事务里改批次 `company_id` 并解锁在途占用（D22 / D31 / D68③），
 *   同样依赖 inventory 写能力；
 * - **不做内部定价规则表**：一期内部价手工填（D68①），系统不按成本价 / 加成自动算；
 * - **不做 N 单完成自动生成 C 单草稿**（D29，与 E 单同规则）：等结算模块落地后再加。
 */

/** 非负 decimal 字符串：数量 / 单价 / 金额 / 内部价 / 在途量（D54 `numeric(18,6)`）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/**
 * N 单独立四态（D68②）：**不复用** `HEADER_STATES`。
 * `在途` 只存在于内部交易：发货后、接收方确认到货前，批次仍归发出公司（D22 / D31）。
 */
export const INTERNAL_TRADE_ORDER_STATES = ['进行中', '在途', '已完成', '已取消'] as const;
export type InternalTradeOrderState = (typeof INTERNAL_TRADE_ORDER_STATES)[number];
export const InternalTradeOrderStatusSchema = z.enum(INTERNAL_TRADE_ORDER_STATES);
export type InternalTradeOrderStatus = z.infer<typeof InternalTradeOrderStatusSchema>;

/**
 * N 单四态 → 单据框架三态（D68② / D21）。
 *
 * 取消规则复用 `canCancel` / `assertCancelable`，但后者只认 `HeaderState`；
 * `进行中` 与 `在途` 对取消判定等价（都是非终态），因此统一映射成 `进行中`。
 * 实现侧取消时调用 `assertCancelable(internalTradeHeaderState(status), hasDirectDownstream)`。
 */
export function internalTradeHeaderState(status: InternalTradeOrderStatus): HeaderState {
  return status === '已完成' || status === '已取消' ? status : '进行中';
}

/** 「是否可取消」：按四态映射后走 `canCancel`，前端直接渲染，不自行重算。 */
export function internalTradeCancelable(
  status: InternalTradeOrderStatus,
  hasDirectDownstream: boolean,
): CancelDecision {
  return canCancel(internalTradeHeaderState(status), hasDirectDownstream);
}

/**
 * 商品明细（§1 / D22）：`batchIds` 至少 1 条，且必须属于**发出公司**。
 * 归属校验由实现侧按 D22 做；这里只锁「非空 + uuid」的形状。
 */
export const InternalTradeBatchIdsSchema = z
  .array(z.string().uuid())
  .min(1, 'N 单商品明细至少引用 1 个发出公司批次（D22）');
export type InternalTradeBatchIds = z.infer<typeof InternalTradeBatchIdsSchema>;

/**
 * 商品明细（§1 / D22）：`amount = qty × unitPrice` 由实现侧计算并落库，契约层只校验类型。
 */
/** 写入用商品明细：金额必填（与下面可能被脱敏的实体 schema 分开，D79）。 */
export const InternalTradeOrderLineInputSchema = z.object({
  productId: z.string().uuid(),
  /** 引用**发出公司**批次（D22），至少 1 条。 */
  batchIds: InternalTradeBatchIdsSchema,
  qty: NonNegativeDecimal,
  unitPrice: NonNegativeDecimal,
  amount: NonNegativeDecimal,
});
export type InternalTradeOrderLineInput = z.infer<typeof InternalTradeOrderLineInputSchema>;

/**
 * 商品明细**实体视图**（D79）：无 `internal_trade.view_price` 时金额字段返回 `null`。
 *
 * 入参（开单 / 改单）仍用上面的 `InternalTradeOrderLineInputSchema`，
 * 保证「写的时候必须填金额、读的时候可能看不到金额」两件事互不干扰。
 */
export const InternalTradeOrderLineSchema = InternalTradeOrderLineInputSchema.extend({
  /** 单价；无 `internal_trade.view_price` 时为 null（D79）。 */
  unitPrice: NonNegativeDecimal.nullable(),
  /** 行金额（`qty × unitPrice`）；无看价权限时为 null（D79）。 */
  amount: NonNegativeDecimal.nullable(),
});
export type InternalTradeOrderLine = z.infer<typeof InternalTradeOrderLineSchema>;

/**
 * 内部交易单实体（§1）：公司名只读回显，单号服务端生成（D16）。
 * - `internalPrice`：**制单人手填，系统不自动算**（D68①）；一期只记录，不做利润抵消展示（D45）；
 * - `inTransitQty`：在途量（锁定量）；在途期间批次仍归发出公司，收货方确认到货才转司（D22 / D31）。
 */
export const InternalTradeOrderSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 发出公司（D15）：明细分批次必须属于该公司的批次（D22）。 */
  fromCompanyId: z.string(),
  /** 发出公司名只读回显，避免列表二次查询。 */
  fromCompanyName: z.string(),
  /** 接收公司（D15）：到货确认后批次归属变更为该公司（D31 / D68③）。 */
  toCompanyId: z.string(),
  /** 接收公司名只读回显。 */
  toCompanyName: z.string(),
  /** 单号（服务端按 D16 生成，格式 `N-<公司码4>-<日期8>-<流水4>`）。 */
  orderNo: z.string(),
  status: InternalTradeOrderStatusSchema,
  /** 经手人（负责人）；无权查看负责人（非老板/经理）时服务端返回 null（Issue #227）。 */
  handlerId: z.string().nullable(),
  lines: z.array(InternalTradeOrderLineSchema),
  /** 内部价：制单人手填，系统不自动算（D68①）；decimal 字符串（D54）；**无 `internal_trade.view_price` 时为 null**（D79）。 */
  internalPrice: NonNegativeDecimal.nullable(),
  /** 在途量：发货后锁定、到货确认后解锁（D22 / D31）；decimal 字符串（D54）。 */
  inTransitQty: NonNegativeDecimal,
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InternalTradeOrder = z.infer<typeof InternalTradeOrderSchema>;

/**
 * 「是否可取消」口径（D21）：与 `documents.ts` 的 `CancelDecision` 一一对应，
 * 由实现侧调用 `internalTradeCancelable` / `canCancel` 推导后回给前端。
 */
export const InternalTradeOrderCancelableSchema: z.ZodType<CancelDecision> = z.object({
  allowed: z.boolean(),
  reason: z.enum(['already_completed', 'already_cancelled', 'has_downstream']).nullable(),
});
export type InternalTradeOrderCancelable = z.infer<typeof InternalTradeOrderCancelableSchema>;

/**
 * 内部交易单详情（§1）：在列表实体上补取消判定 `cancelable`（按四态映射后走 `canCancel`）。
 * 本批没有「发货 / 到货确认」的动作块；转司字段与批次明细等 inventory 写能力落地后再补。
 */
export const InternalTradeOrderDetailSchema = InternalTradeOrderSchema.extend({
  cancelable: InternalTradeOrderCancelableSchema,
});
export type InternalTradeOrderDetail = z.infer<typeof InternalTradeOrderDetailSchema>;

/**
 * 内部交易单列表查询：发出公司 / 接收公司 / 状态 / 关键字（单号），游标分页。
 * 公司隔离（D15）由服务端按调用者可见公司集合再收口。
 */
export const InternalTradeOrderListQuerySchema = PageQuerySchema.extend({
  fromCompanyId: z.string().uuid().optional(),
  toCompanyId: z.string().uuid().optional(),
  status: InternalTradeOrderStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * 开单入参（§1）：
 * - **不接收单号**（服务端按 D16 生成）、不接收状态 / 在途量；
 * - 商品明细至少 1 行、每行 `batchIds` 至少 1 条（D22）；
 * - 内部价必填且由制单人手填（D68①），系统不自动算。
 */
export const InternalTradeOrderCreateInputSchema = z.object({
  fromCompanyId: z.string().uuid(),
  toCompanyId: z.string().uuid(),
  handlerId: z.string().uuid(),
  lines: z.array(InternalTradeOrderLineInputSchema).min(1, 'N 单至少 1 行商品明细'),
  internalPrice: NonNegativeDecimal,
});
export type InternalTradeOrderCreateInput = z.infer<typeof InternalTradeOrderCreateInputSchema>;

/**
 * 修改入参：全字段可选、至少改一个。
 * **只有「进行中」的 N 单可改**（服务端按 D68② 四态校验；状态不是入参）。
 * 发出公司 / 接收公司变更、在途量、单号均不在本批修改范围：
 * 接收公司是否允许在「进行中」变更尚未拍板，故不引入该字段（不猜口径）。
 */
export const InternalTradeOrderUpdateInputSchema = z
  .object({
    handlerId: z.string().uuid().optional(),
    lines: z.array(InternalTradeOrderLineInputSchema).min(1).optional(),
    internalPrice: NonNegativeDecimal.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });
export type InternalTradeOrderUpdateInput = z.infer<typeof InternalTradeOrderUpdateInputSchema>;

/** 到货确认是危险写操作，要求显式确认，避免误触发批次转司（D22 / D31 / #196）。 */
export const InternalTradeOrderReceiveInputSchema = z.object({
  confirm: z.literal(true),
});
export type InternalTradeOrderReceiveInput = z.infer<typeof InternalTradeOrderReceiveInputSchema>;

/**
 * internal-trade 模块 N 内部交易单端点（6 条，含到货确认）。
 *
 * operationId 以 `internal_trade` 开头（与功能域同名，registry 校验要求）；
 * 权限 scope 仍按功能域推导为 `internal_trade.read/create/update/delete`（D44）。
 * 审计：写操作必记（D51）；普通读不记（D54 ②）。
 * AI：开单属业务动作默认禁止；修改允许；取消属危险动作，默认禁止且必须给原因（D52① / D54 ⑥）。
 * 并发：update / cancel 强制 If-Match 强 ETag。
 * 取消：按四态映射后复用 `canCancel` / `assertCancelable`（D21 / D68②）。
 */
export const INTERNAL_TRADE_ORDER_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'internal-trade',
    operationId: 'internal_trade.order.list.read',
    method: 'GET',
    path: '/api/v1/internal-trade-orders',
    domain: 'internal_trade',
    action: 'read',
    summary: '内部交易单列表（按发出/接收公司、状态、单号检索；普通读不记审计，D15）',
    audit: { kind: 'none' },
    request: { query: InternalTradeOrderListQuerySchema },
    response: { status: 200, schema: pageSchema(InternalTradeOrderSchema) },
  }),
  defineRoute({
    module: 'internal-trade',
    operationId: 'internal_trade.order.create',
    method: 'POST',
    path: '/api/v1/internal-trade-orders',
    domain: 'internal_trade',
    action: 'create',
    summary: '开内部交易单（单号服务端按 D16 生成；内部价手工填 D68①；明细引用发出公司批次 D22）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: InternalTradeOrderCreateInputSchema },
    response: { status: 201, schema: InternalTradeOrderSchema },
  }),
  defineRoute({
    module: 'internal-trade',
    operationId: 'internal_trade.order.detail.read',
    method: 'GET',
    path: '/api/v1/internal-trade-orders/{id}',
    domain: 'internal_trade',
    action: 'read',
    summary: '内部交易单详情（内嵌四态取消判定 cancelable；普通读不记审计，D21 / D68②）',
    audit: { kind: 'none' },
    response: { status: 200, schema: InternalTradeOrderDetailSchema },
  }),
  defineRoute({
    module: 'internal-trade',
    operationId: 'internal_trade.order.update',
    method: 'PATCH',
    path: '/api/v1/internal-trade-orders/{id}',
    domain: 'internal_trade',
    action: 'update',
    summary: '修改内部交易单（仅「进行中」可改；强 ETag If-Match；内部价手工填 D68①）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: InternalTradeOrderUpdateInputSchema },
    response: { status: 200, schema: InternalTradeOrderSchema },
  }),
  defineRoute({
    module: 'internal-trade',
    operationId: 'internal_trade.order.cancel',
    method: 'POST',
    path: '/api/v1/internal-trade-orders/{id}/cancel',
    domain: 'internal_trade',
    action: 'delete',
    summary:
      '取消内部交易单（四态映射后复用 assertCancelable：已完成/已取消不可取消、有下游先取消下游；AI 禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    response: { status: 200, schema: InternalTradeOrderSchema },
  }),
  defineRoute({
    module: 'internal-trade',
    operationId: 'internal_trade.order.receive',
    method: 'POST',
    path: '/api/v1/internal-trade-orders/{id}/receive',
    domain: 'internal_trade',
    action: 'update',
    summary: '确认 N 单到货并将占用批次转入接收公司（D22 / D31 / D68③）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    request: { body: InternalTradeOrderReceiveInputSchema },
    response: { status: 200, schema: InternalTradeOrderSchema },
  }),
];
