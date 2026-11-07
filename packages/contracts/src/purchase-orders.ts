import { z } from 'zod';
import { HEADER_STATES, type CancelDecision } from './documents.js';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 采购单 A 契约（契约第一批 §3.1 / §5.1 / §5.2 / §10，第一批第二切）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **金额与数量一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`，避免浮点误差；
 * - **单号由服务端按 D16 生成**，创建入参不接收 `orderNo`；
 * - **公司隔离**（D15）：采购单归属某一个公司，跨公司不可见；
 * - **A 单按「入库时生成批次」建模，不是引用既有批次**：商品明细**不含 `batchIds`**——
 *   这是与 E 单（§5.1 引用本公司批次，D22）的关键差异，别把 E 单明细照抄过来；
 * - **A 单费用行金额允许为负**（供应商返利 / 对方承担运费 / 退运费冲减），
 *   但**负数行必须填写备注**（D39），schema 层用 `refine` 校验，不只是注释；
 * - **状态直接复用** `documents.ts` 的 `HEADER_STATES`（进行中 / 已完成 / 已取消，§10），
 *   不另造英文枚举（D54 §9-6）；
 * - **取消规则复用** `documents.ts` 的 `canCancel` / `assertCancelable`（D21），
 *   本文件不重写一套级联判断；已完成 / 已结算一律不可取消，错账走冲正 R/S/I；
 * - 写操作必记审计（D51）；普通读不记（D54 ②）。
 *
 * 本批明确不做（等后续批次）：
 * - **不做「完成 / 入库」端点**：入库要按 `批次单价 = (货款+运费+杂费) ÷ 入库数量`
 *   生成批次并锁价（D5），依赖 inventory 写能力，等 inventory 落地后再加；
 * - **不做 T1/T2/T3 成本更正的独立端点**（D37）：改批次价须走 platform 审批
 *   （老板 / 经理 / 财务可审批，D42），审批端点后续补；本批不在契约里发明审批字段；
 * - **不做 S 供应商退货**（独立单据，另起一批）。
 */

/** decimal 字符串（D54 `numeric(18,6)`：最多 12 位整数 + 6 位小数，可负）。 */
const DecimalString = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（最多 6 位小数，D54）');

/** 非负 decimal 字符串：数量 / 单价 / 货款（D54 `numeric(18,6)`）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/** 单头三态（契约第一批 §10）：直接复用单据框架的 `HEADER_STATES`，不另造枚举。 */
export const PurchaseOrderStatusSchema = z.enum(HEADER_STATES);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatusSchema>;

/**
 * 商品明细（§5.1）：A 单单价为**成本**（入库后按 D5 摊成批次单价）。
 *
 * **不含 `batchIds`**：A 单是「入库时生成批次」，不是引用既有批次；
 * 引用批次的是 B / E 单（D22），两者明细结构不能混用。
 * `amount = qty × unitPrice` 由实现侧计算并落库，契约层只校验类型。
 */
export const PurchaseOrderLineSchema = z.object({
  productId: z.string().uuid(),
  qty: NonNegativeDecimal,
  unitPrice: NonNegativeDecimal,
  amount: NonNegativeDecimal,
});
export type PurchaseOrderLine = z.infer<typeof PurchaseOrderLineSchema>;

/** 实体视图：无 `purchase.view_price` 时金额为 null（D79）；入参仍用上面的非空 schema。 */
export const PurchaseOrderLineViewSchema = PurchaseOrderLineSchema.extend({
  unitPrice: NonNegativeDecimal.nullable(),
  amount: NonNegativeDecimal.nullable(),
});

/** D39：A 单负数费用行必须填写非空备注，否则拒绝。 */
function negativeFeeHasRemark(fee: { amount: string | null; remark?: string | null }): boolean {
  if (fee.amount === null) return true;
  if (Number(fee.amount) >= 0) return true;
  return typeof fee.remark === 'string' && fee.remark.trim().length > 0;
}

const NEGATIVE_FEE_MESSAGE = 'A 单负数费用行必须填写备注（D39，供应商返利等须可追溯）';

/** 费用行公共字段（响应实体与创建入参共用，备注可空性不同）。 */
const feeShape = {
  feeName: z.string().min(1).max(64),
  qty: NonNegativeDecimal,
  unitPrice: NonNegativeDecimal,
  /** 金额可负（D39）；负数时必须填备注，见下方 refine。 */
  amount: DecimalString,
};

/**
 * 费用明细（§5.2）：运费 / 杂费 / 加工费等。
 * **A 单费用行金额允许为负（D39）**——供应商返利、对方承担运费、退运费冲减；
 * 但负数会让「成本构成」变得不直观，故 **负数时 `remark` 必填**，用 refine 锁死。
 */
export const PurchaseOrderFeeSchema = z
  .object({
    ...feeShape,
    /** 备注可空（§5.2；负数时条件必填）。 */
    remark: z.string().max(255).nullable(),
  })
  .refine(negativeFeeHasRemark, { message: NEGATIVE_FEE_MESSAGE, path: ['remark'] });
export type PurchaseOrderFee = z.infer<typeof PurchaseOrderFeeSchema>;

/** 实体视图：金额可为 null（D79）；null 表示无看价权限，跳过负数备注校验。 */
export const PurchaseOrderFeeViewSchema = z
  .object({
    ...feeShape,
    unitPrice: NonNegativeDecimal.nullable(),
    amount: DecimalString.nullable(),
    remark: z.string().max(255).nullable(),
  })
  .refine(negativeFeeHasRemark, { message: NEGATIVE_FEE_MESSAGE, path: ['remark'] });

/** 创建入参里的费用行：`remark` 可省略（响应实体仍回 `null`），负数校验口径不变。 */
const PurchaseOrderFeeInputSchema = z
  .object({
    ...feeShape,
    remark: z.string().max(255).nullable().optional(),
  })
  .refine(negativeFeeHasRemark, { message: NEGATIVE_FEE_MESSAGE, path: ['remark'] });

/**
 * 采购单实体（§3.1）：`supplierName` 为只读回显，单号服务端生成（D16）。
 * - `goodsAmount` = 商品明细金额合计（货款，非负）；
 * - `feeAmount` = 费用明细金额合计（可为负，D39）；
 * - `totalAmount` = 货款 + 费用合计，由实现侧计算并落库（D5 成本分子）。
 */
export const PurchaseOrderSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：采购单归属某一个公司，跨公司不可见。 */
  companyId: z.string(),
  /** 单号（服务端按 D16 生成，格式 `A-<公司码4>-<日期8>-<流水4>`）。 */
  orderNo: z.string(),
  supplierId: z.string(),
  /** 供应商名只读回显，避免列表二次查询。 */
  supplierName: z.string(),
  status: PurchaseOrderStatusSchema,
  /** 经手人。 */
  handlerId: z.string(),
  lines: z.array(PurchaseOrderLineViewSchema),
  fees: z.array(PurchaseOrderFeeViewSchema),
  /** 货款：商品明细金额合计（decimal 字符串，D54）；**无 `purchase.view_price` 时为 null**（D79）。 */
  goodsAmount: NonNegativeDecimal.nullable(),
  /** 费用合计：可为负（D39）；无看价权限时为 null。 */
  feeAmount: DecimalString.nullable(),
  /** 单据总金额 = 货款 + 费用合计（decimal 字符串，D54 / D5）；无看价权限时为 null。 */
  totalAmount: DecimalString.nullable(),
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

/**
 * 「是否可取消」口径（D21）：与 `documents.ts` 的 `CancelDecision` 一一对应，
 * 由实现侧调用 `canCancel` 推导后回给前端，前端直接渲染，不自行重算。
 */
export const PurchaseOrderCancelableSchema: z.ZodType<CancelDecision> = z.object({
  allowed: z.boolean(),
  reason: z.enum(['already_completed', 'already_cancelled', 'has_downstream']).nullable(),
});
export type PurchaseOrderCancelable = z.infer<typeof PurchaseOrderCancelableSchema>;

/**
 * 采购单详情（§3.1）：在列表实体上补取消判定 `cancelable`（由 `canCancel` 推导，D21）。
 * 本批没有收款 / 付款记录块（D11 采购付款线下走），也不做入库批次明细。
 */
export const PurchaseOrderDetailSchema = PurchaseOrderSchema.extend({
  cancelable: PurchaseOrderCancelableSchema,
});
export type PurchaseOrderDetail = z.infer<typeof PurchaseOrderDetailSchema>;

/**
 * 采购单列表查询：公司 / 供应商 / 状态 / 关键字（单号或供应商名），游标分页。
 * 公司隔离（D15）由服务端按调用者可见公司集合再收口。
 */
export const PurchaseOrderListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  status: PurchaseOrderStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * 开单入参（§3.1）：
 * - **不接收单号**（服务端按 D16 生成）；
 * - 商品明细至少 1 行；费用明细选填；
 * - 入库锁价 / 成本更正不在本批（D5 / D37）。
 */
export const PurchaseOrderCreateInputSchema = z.object({
  companyId: z.string().uuid(),
  supplierId: z.string().uuid(),
  handlerId: z.string().uuid(),
  lines: z.array(PurchaseOrderLineSchema).min(1, '采购单至少 1 行商品明细'),
  fees: z.array(PurchaseOrderFeeInputSchema).optional(),
});
export type PurchaseOrderCreateInput = z.infer<typeof PurchaseOrderCreateInputSchema>;

/**
 * 修改入参：全字段可选、至少改一个。
 * **只有「进行中」的采购单可改**（服务端按 D4 状态机校验；状态不是入参）。
 * 已完成单的成本更正走 platform 审批（D37 / D42），审批端点后续补。
 */
export const PurchaseOrderUpdateInputSchema = z
  .object({
    supplierId: z.string().uuid().optional(),
    handlerId: z.string().uuid().optional(),
    lines: z.array(PurchaseOrderLineSchema).min(1).optional(),
    fees: z.array(PurchaseOrderFeeInputSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });
export type PurchaseOrderUpdateInput = z.infer<typeof PurchaseOrderUpdateInputSchema>;

/**
 * purchase 模块 A 采购单端点（5 条，共第一批）。
 *
 * 权限：`purchase.read` / `.create` / `.update` / `.delete`（scope = domain.action，D44）。
 * 审计：写操作必记（D51）；普通读不记（D54 ②）。
 * AI：**开单属业务动作，默认禁止**（与既有写端点口径一致）；
 *     修改允许；**取消属危险动作，默认禁止且必须给原因**（D52① / D54 ⑥）。
 * 并发：update / cancel 强制 If-Match 强 ETag。
 * 取消：规则复用 `documents.ts` 的 `assertCancelable`（D21：有下游不可取消，先取消下游）。
 */
export const PURCHASE_ORDER_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'purchase',
    operationId: 'purchase.order.list.read',
    method: 'GET',
    path: '/api/v1/purchase-orders',
    domain: 'purchase',
    action: 'read',
    summary: '采购单列表（按公司/供应商/状态/单号或供应商名检索；普通读不记审计，D15）',
    audit: { kind: 'none' },
    request: { query: PurchaseOrderListQuerySchema },
    response: { status: 200, schema: pageSchema(PurchaseOrderSchema) },
  }),
  defineRoute({
    module: 'purchase',
    operationId: 'purchase.order.create',
    method: 'POST',
    path: '/api/v1/purchase-orders',
    domain: 'purchase',
    action: 'create',
    summary: '开采购单（单号服务端按 D16 生成；AI 默认禁止开单；本批不做入库锁价 D5）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: PurchaseOrderCreateInputSchema },
    response: { status: 201, schema: PurchaseOrderSchema },
  }),
  defineRoute({
    module: 'purchase',
    operationId: 'purchase.order.detail.read',
    method: 'GET',
    path: '/api/v1/purchase-orders/{id}',
    domain: 'purchase',
    action: 'read',
    summary: '采购单详情（内嵌取消判定 cancelable；普通读不记审计，D21）',
    audit: { kind: 'none' },
    response: { status: 200, schema: PurchaseOrderDetailSchema },
  }),
  defineRoute({
    module: 'purchase',
    operationId: 'purchase.order.update',
    method: 'PATCH',
    path: '/api/v1/purchase-orders/{id}',
    domain: 'purchase',
    action: 'update',
    summary: '修改采购单（仅「进行中」可改；强 ETag If-Match；成本更正走 platform 审批 D37）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: PurchaseOrderUpdateInputSchema },
    response: { status: 200, schema: PurchaseOrderSchema },
  }),
  defineRoute({
    module: 'purchase',
    operationId: 'purchase.order.cancel',
    method: 'POST',
    path: '/api/v1/purchase-orders/{id}/cancel',
    domain: 'purchase',
    action: 'delete',
    summary: '取消采购单（复用 assertCancelable：已完成/已结算不可取消、有下游先取消下游；AI 禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    response: { status: 200, schema: PurchaseOrderSchema },
  }),
];
