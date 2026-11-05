import { z } from 'zod';
import { HEADER_STATES, type CancelDecision } from './documents.js';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 销售单 E 契约（契约第一批 §3.3 / §5.1 / §5.2 / §10，第一批第一切）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **金额与数量一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`，避免浮点误差；
 * - **单号由服务端按 D16 生成**，创建入参不接收 `orderNo`；
 * - **公司隔离**（D15）：销售单归属某一个公司，跨公司不可见；
 * - **只能引用本公司批次**（D22）：商品明细的 `batchIds` 至少 1 个，由实现侧校验归属；
 * - **E 单费用行金额必须 ≥ 0**（D39）：负数费用行会绕过破下限审批，schema 层直接拒绝；
 * - **状态直接复用** `documents.ts` 的 `HEADER_STATES`（进行中 / 已完成 / 已取消，§10），
 *   不另造英文枚举（D54 §9-6）；
 * - **取消规则复用** `documents.ts` 的 `canCancel` / `assertCancelable`（D21），
 *   本文件不重写一套级联判断；
 * - 写操作必记审计（D51）；普通读不记（D54 ②）。
 *
 * 本批明确不做（等后续批次）：
 * - **不做「完成 / 出库」端点**：出库要把待执行占用转已引用（D41），依赖 inventory 写路径，
 *   等 inventory 写能力落地后再加；
 * - **不做收款记录写入端点**（下一批）：详情里的 `receipts` 仅留空数组占位（D24/D34/D40）；
 * - **不做改价下限审批的独立端点**：破下限需走 platform 审批（D20），审批端点后续补；
 *   本批不在契约里发明任何审批 / `priceFloor` 字段。
 */

/** decimal 字符串（D54 `numeric(18,6)`：最多 12 位整数 + 6 位小数，可负）。 */
const DecimalString = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（最多 6 位小数，D54）');

/** 非负 decimal 字符串：数量 / 单价 / 金额（D54 `numeric(18,6)`）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/** 单头三态（契约第一批 §10）：直接复用单据框架的 `HEADER_STATES`，不另造枚举。 */
export const SalesOrderStatusSchema = z.enum(HEADER_STATES);
export type SalesOrderStatus = z.infer<typeof SalesOrderStatusSchema>;

/**
 * 商品明细（§5.1）：E 单单价为售价；一行可引多个批次（D22 本公司批次）。
 * `amount = qty × unitPrice` 由实现侧计算并落库，契约层只校验类型。
 */
export const SalesOrderLineSchema = z.object({
  productId: z.string().uuid(),
  /** 一行可引多批次，但至少 1 个（§5.1 / §11-1 拟定必填）。 */
  batchIds: z.array(z.string().uuid()).min(1, '商品明细至少引用 1 个批次（D22）'),
  qty: NonNegativeDecimal,
  unitPrice: NonNegativeDecimal,
  amount: NonNegativeDecimal,
});
export type SalesOrderLine = z.infer<typeof SalesOrderLineSchema>;

/**
 * 费用明细（§5.2）：运费 / 杂费 / 加工费等。
 * **E 单费用行金额必须 ≥ 0（D39）**——负数会绕过破下限审批，故在 schema 层用 refine 拒绝。
 */
export const SalesOrderFeeSchema = z.object({
  feeName: z.string().min(1).max(64),
  qty: NonNegativeDecimal,
  unitPrice: NonNegativeDecimal,
  amount: DecimalString.refine((value) => Number(value) >= 0, {
    message: 'E 单费用行金额必须 ≥ 0（D39，禁止用负数费用行绕过破下限审批）',
  }),
  /** 备注可空（§5.2；A 单负数费用才条件必填，E 单无此要求）。 */
  remark: z.string().max(255).nullable(),
});
export type SalesOrderFee = z.infer<typeof SalesOrderFeeSchema>;

/** 创建入参里的费用行：`remark` 可省略（响应实体仍回 `null`）。 */
const SalesOrderFeeInputSchema = SalesOrderFeeSchema.extend({
  remark: z.string().max(255).nullable().optional(),
});

/** 销售单实体（§3.3）：`customerName` 为只读回显，单号服务端生成（D16）。 */
export const SalesOrderSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：销售单归属某一个公司，跨公司不可见。 */
  companyId: z.string(),
  /** 单号（服务端按 D16 生成，格式 `E-<公司码4>-<日期8>-<流水4>`）。 */
  orderNo: z.string(),
  customerId: z.string(),
  /** 客户名只读回显，避免列表二次查询。 */
  customerName: z.string(),
  status: SalesOrderStatusSchema,
  /** 经手人。 */
  handlerId: z.string(),
  lines: z.array(SalesOrderLineSchema),
  fees: z.array(SalesOrderFeeSchema),
  /** 单据总金额，decimal 字符串（D54）。 */
  totalAmount: NonNegativeDecimal,
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SalesOrder = z.infer<typeof SalesOrderSchema>;

/**
 * 「是否可取消」口径（D21）：与 `documents.ts` 的 `CancelDecision` 一一对应，
 * 由实现侧调用 `canCancel` 推导后回给前端，前端直接渲染，不自行重算。
 */
export const SalesOrderCancelableSchema: z.ZodType<CancelDecision> = z.object({
  allowed: z.boolean(),
  reason: z.enum(['already_completed', 'already_cancelled', 'has_downstream']).nullable(),
});
export type SalesOrderCancelable = z.infer<typeof SalesOrderCancelableSchema>;

/**
 * 销售单详情（§3.3）：在列表实体上补收款记录块与取消判定。
 * - `receipts` 本批只留空数组占位（收款记录批次实现，D24/D34/D40）；
 * - `cancelable` 由 `canCancel` 推导（D21）。
 */
export const SalesOrderDetailSchema = SalesOrderSchema.extend({
  receipts: z.array(z.unknown()),
  cancelable: SalesOrderCancelableSchema,
});
export type SalesOrderDetail = z.infer<typeof SalesOrderDetailSchema>;

/**
 * 销售单列表查询：公司 / 客户 / 状态 / 关键字（单号或客户名），游标分页。
 * 公司隔离（D15）由服务端按调用者可见公司集合再收口。
 */
export const SalesOrderListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  status: SalesOrderStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * 开单入参（§3.3）：
 * - **不接收单号**（服务端按 D16 生成）；
 * - 费用明细选填（§3.3），商品明细至少 1 行；
 * - 破下限需走 platform 审批（D20），本批不提供审批字段。
 */
export const SalesOrderCreateInputSchema = z.object({
  companyId: z.string().uuid(),
  customerId: z.string().uuid(),
  handlerId: z.string().uuid(),
  lines: z.array(SalesOrderLineSchema).min(1, '销售单至少 1 行商品明细'),
  fees: z.array(SalesOrderFeeInputSchema).optional(),
});
export type SalesOrderCreateInput = z.infer<typeof SalesOrderCreateInputSchema>;

/**
 * 修改入参：全字段可选、至少改一个。
 * **只有「进行中」的销售单可改**（服务端按 D4 状态机校验；状态不是入参）。
 * 破下限需走 platform 审批（D20），审批端点后续补。
 */
export const SalesOrderUpdateInputSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    handlerId: z.string().uuid().optional(),
    lines: z.array(SalesOrderLineSchema).min(1).optional(),
    fees: z.array(SalesOrderFeeInputSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });
export type SalesOrderUpdateInput = z.infer<typeof SalesOrderUpdateInputSchema>;

/**
 * sales 模块 E 销售单端点（5 条，共第一批）。
 *
 * 权限：`sales.read` / `.create` / `.update` / `.delete`（scope = domain.action，D44）。
 * 审计：写操作必记（D51）；普通读不记（D54 ②）。
 * AI：**开单属业务动作，默认禁止**（与既有写端点口径一致）；
 *     修改允许；**取消属危险动作，默认禁止且必须给原因**（D52① / D54 ⑥）。
 * 并发：update / cancel 强制 If-Match 强 ETag。
 * 取消：规则复用 `documents.ts` 的 `assertCancelable`（D21：有下游不可取消，先取消下游）。
 */
export const SALES_ORDER_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'sales',
    operationId: 'sales.order.list.read',
    method: 'GET',
    path: '/api/v1/sales-orders',
    domain: 'sales',
    action: 'read',
    summary: '销售单列表（按公司/客户/状态/单号或客户名检索；普通读不记审计，D15）',
    audit: { kind: 'none' },
    request: { query: SalesOrderListQuerySchema },
    response: { status: 200, schema: pageSchema(SalesOrderSchema) },
  }),
  defineRoute({
    module: 'sales',
    operationId: 'sales.order.create',
    method: 'POST',
    path: '/api/v1/sales-orders',
    domain: 'sales',
    action: 'create',
    summary: '开销售单（单号服务端按 D16 生成；AI 默认禁止开单；破下限需走 platform 审批 D20）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: SalesOrderCreateInputSchema },
    response: { status: 201, schema: SalesOrderSchema },
  }),
  defineRoute({
    module: 'sales',
    operationId: 'sales.order.detail.read',
    method: 'GET',
    path: '/api/v1/sales-orders/{id}',
    domain: 'sales',
    action: 'read',
    summary: '销售单详情（内嵌收款记录占位 + 取消判定 cancelable；普通读不记审计，D21/D24）',
    audit: { kind: 'none' },
    response: { status: 200, schema: SalesOrderDetailSchema },
  }),
  defineRoute({
    module: 'sales',
    operationId: 'sales.order.update',
    method: 'PATCH',
    path: '/api/v1/sales-orders/{id}',
    domain: 'sales',
    action: 'update',
    summary: '修改销售单（仅「进行中」可改；强 ETag If-Match；破下限需走 platform 审批 D20）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: SalesOrderUpdateInputSchema },
    response: { status: 200, schema: SalesOrderSchema },
  }),
  defineRoute({
    module: 'sales',
    operationId: 'sales.order.cancel',
    method: 'POST',
    path: '/api/v1/sales-orders/{id}/cancel',
    domain: 'sales',
    action: 'delete',
    summary: '取消销售单（复用 assertCancelable：有下游不可取消、先取消下游；危险动作 AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    response: { status: 200, schema: SalesOrderSchema },
  }),
];
