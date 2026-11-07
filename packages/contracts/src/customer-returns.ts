import { z } from 'zod';
import { HEADER_STATES } from './documents.js';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * R 客户退货契约（契约第一批 §4 / §5.1；D2③ / D36 / D40 / D47 / D51 / D54）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **金额与数量一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`；
 * - **`returnType` 两型**（F4 / D40）：`退货退款`（有入库流水）与 `仅退款`（无实物流水）；
 *   `仅退款` 再分 `纠收款`（只退钱、不重算毛利提成）与 `减成交额`（成交额减少、
 *   原 C 单按结算时快照比例重算毛利提成并留痕，D40）；
 * - **`onlyRefundKind` 条件必填**（D40）：`returnType=仅退款` 时必填 `纠收款 / 减成交额`；
 *   其它情况必须为空。用 `refine` 锁死，不只是注释；
 * - **退款只走 E 单收款记录负数行**（D40）：R 单不写 E 单负数费用行；
 *   `refundAmount` 是「应退金额」，**必须为正数**，实际退款由收款记录负数行表达；
 * - **R 单必须全额冲回原 E 单成交总额，原单提成归零**（D36）：该约束适用于
 *   「售价录错重开」场景，不约束 F4「仅退款」的小额补偿；
 * - **冲正不物理删除**（D47）：本文件不登记 delete 端点，错账靠追加冲正单据；
 * - **R 单归属 sales 模块、功能域 `customer_return`**（D44 / D62）；
 * - 写操作必记审计（D51）；普通读不记（D54 ②）；**登记冲正单据属危险动作，
 *   AI 默认禁止且必须给原因**（D52① / D54 ⑥）。
 *
 * 本批明确不做（等后续批次）：
 * - **不做状态流转 / 完成 / 取消端点**：R 单入库流水与 C 单重算由实现侧后续落地；
 * - **不做 update / delete**：冲正单据只追加（D47）。
 */

/** 非负 decimal 字符串：数量 / 单价 / 金额（D54 `numeric(18,6)`）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/** 正整数金额：应退金额必须 > 0（D40；实际退款走收款记录负数行）。 */
const PositiveDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（正数、最多 6 位小数）')
  .refine((value) => Number(value) > 0, { message: '退款金额必须 > 0（D40）' });

/** 客户退货类型（F4 / D40）：退货退款（有入库流水）/ 仅退款（无实物流水）。 */
export const CustomerReturnTypeSchema = z.enum(['退货退款', '仅退款']);
export type CustomerReturnType = z.infer<typeof CustomerReturnTypeSchema>;

/** 仅退款子类型（D40）：纠收款（不重算）/ 减成交额（重算毛利提成）。 */
export const OnlyRefundKindSchema = z.enum(['纠收款', '减成交额']);
export type OnlyRefundKind = z.infer<typeof OnlyRefundKindSchema>;

/** 退款方式（F4）：原路退款 / 冲抵应收（挂账抵下单货款）。 */
export const RefundModeSchema = z.enum(['原路退款', '冲抵应收']);
export type RefundMode = z.infer<typeof RefundModeSchema>;

/** R 单三态（§10）：直接复用单据框架的 `HEADER_STATES`，不另造枚举。 */
export const CustomerReturnStatusSchema = z.enum(HEADER_STATES);
export type CustomerReturnStatus = z.infer<typeof CustomerReturnStatusSchema>;

/**
 * 商品明细（§5.1）：R 单退货退款的明细，一行可引多个批次（D22 本公司批次）。
 * `amount = qty × unitPrice` 由实现侧计算并落库，契约层只校验类型。
 * `returnType=仅退款` 时 `lines` 可为空数组（无实物流水，F4）。
 */
export const CustomerReturnLineSchema = z.object({
  productId: z.string().uuid(),
  /** 一行可引多批次，但至少 1 个（§5.1 / D22）。 */
  batchIds: z.array(z.string().uuid()).min(1, '商品明细至少引用 1 个批次（D22）'),
  qty: NonNegativeDecimal,
  unitPrice: NonNegativeDecimal,
  amount: NonNegativeDecimal,
});
export type CustomerReturnLine = z.infer<typeof CustomerReturnLineSchema>;

const ONLY_REFUND_KIND_MESSAGE =
  'returnType=仅退款 时 onlyRefundKind 必填（纠收款 / 减成交额）；其它情况必须为空（D40）';

/**
 * `onlyRefundKind` 条件必填（D40）：
 * - `仅退款` → 必须是 `纠收款` / `减成交额`；
 * - `退货退款` → 必须为 `null` / 未传。
 */
function onlyRefundKindMatches(value: {
  returnType: CustomerReturnType;
  onlyRefundKind?: OnlyRefundKind | null;
}): boolean {
  if (value.returnType === '仅退款') {
    return value.onlyRefundKind === '纠收款' || value.onlyRefundKind === '减成交额';
  }
  return value.onlyRefundKind === null || value.onlyRefundKind === undefined;
}

/**
 * 客户退货单实体（§4）：
 * - `returnNo` 由服务端按 D16 生成（`R-<公司码4>-<日期8>-<流水4>`）；
 * - `originalSettlementOrderId` 关联原 C 单，选填（§4）；
 * - `refundAmount` 是应退金额（正数），实际退款只记入 E 单收款记录负数行（D40）；
 * - `status` 复用三态（§10），冲正单据不物理删除（D47）。
 */
export const CustomerReturnSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    /** 公司隔离（D15）：R 单随原 E 单归属公司，跨公司不可见。 */
    companyId: z.string(),
    /** 单号（服务端按 D16 生成，格式 `R-<公司码4>-<日期8>-<流水4>`）。 */
    returnNo: z.string(),
    /** 关联原 E 单（§4）。 */
    originalSalesOrderId: z.string(),
    /** 关联原 C 单，选填（§4）。 */
    originalSettlementOrderId: z.string().nullable(),
    returnType: CustomerReturnTypeSchema,
    /** 仅 `returnType=仅退款` 时有值（D40）；其它情况为 null。 */
    onlyRefundKind: OnlyRefundKindSchema.nullable(),
    refundMode: RefundModeSchema,
    status: CustomerReturnStatusSchema,
    /** 应退金额，正数（D40；实际退款走收款记录负数行）。 */
    refundAmount: PositiveDecimal,
    /** 商品明细（§5.1）；仅退款时可为空数组（无实物流水，F4）。 */
    lines: z.array(CustomerReturnLineSchema),
    /** 备注可空，≤200。 */
    remark: z.string().max(200).nullable(),
    /** 乐观锁版本。 */
    version: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .refine(onlyRefundKindMatches, {
    message: ONLY_REFUND_KIND_MESSAGE,
    path: ['onlyRefundKind'],
  });
export type CustomerReturn = z.infer<typeof CustomerReturnSchema>;

/**
 * 登记退货入参（§4）：
 * - 服务端生成 `id` / `tenantId` / `returnNo` / `status` / `version` / 时间戳，客户端**不传**；
 * - `onlyRefundKind` 条件必填（D40，见上）；
 * - **退货退款必须有商品明细**（§5.1）；仅退款可省略 / 传空数组（F4）；
 * - `refundAmount` 必须为正数：它是应退金额，实际退款由收款记录负数行表达（D40）。
 */
export const CustomerReturnCreateInputSchema = z
  .object({
    companyId: z.string().uuid(),
    originalSalesOrderId: z.string().uuid(),
    originalSettlementOrderId: z.string().uuid().nullable().optional(),
    returnType: CustomerReturnTypeSchema,
    refundMode: RefundModeSchema,
    onlyRefundKind: OnlyRefundKindSchema.nullable().optional(),
    lines: z.array(CustomerReturnLineSchema).optional(),
    refundAmount: PositiveDecimal,
  })
  .refine(onlyRefundKindMatches, {
    message: ONLY_REFUND_KIND_MESSAGE,
    path: ['onlyRefundKind'],
  })
  .refine((value) => value.returnType !== '退货退款' || (value.lines?.length ?? 0) > 0, {
    message: '退货退款必须有商品明细（§5.1）',
    path: ['lines'],
  });
export type CustomerReturnCreateInput = z.infer<typeof CustomerReturnCreateInputSchema>;

/**
 * 客户退货单列表查询：公司 / 原 E 单 / 状态 / 关键字（单号），游标分页。
 * 公司隔离（D15）由服务端按调用者可见公司集合再收口。
 */
export const CustomerReturnListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  originalSalesOrderId: z.string().uuid().optional(),
  status: CustomerReturnStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * sales 模块 R 客户退货端点（3 条，契约第一批 §4）。
 *
 * 权限：查询 `customer_return.read`；登记 `customer_return.create`（scope = domain.action，D44）。
 * 审计：普通读不记（D54 ②）；登记退货记 write（D51）。
 * AI：**登记冲正单据属危险动作，默认禁止且必须给原因**（D52① / D54 ⑥）。
 * 冲正不物理删除（D47）；退款只走收款记录负数行（D40）。
 */
export const CUSTOMER_RETURN_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'sales',
    operationId: 'customer_return.list.read',
    method: 'GET',
    path: '/api/v1/customer-returns',
    domain: 'customer_return',
    action: 'read',
    summary: '客户退货单列表（按公司/原 E 单/状态/单号检索；普通读不记审计，D15）',
    audit: { kind: 'none' },
    request: { query: CustomerReturnListQuerySchema },
    response: { status: 200, schema: pageSchema(CustomerReturnSchema) },
  }),
  defineRoute({
    module: 'sales',
    operationId: 'customer_return.create',
    method: 'POST',
    path: '/api/v1/customer-returns',
    domain: 'customer_return',
    action: 'create',
    summary:
      '登记客户退货（退货退款/仅退款；退款只走收款记录负数行 D40；R 全额冲回原 E 单 D36；AI 禁止冲正 D52）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: CustomerReturnCreateInputSchema },
    response: { status: 201, schema: CustomerReturnSchema },
  }),
  defineRoute({
    module: 'sales',
    operationId: 'customer_return.detail.read',
    method: 'GET',
    path: '/api/v1/customer-returns/{id}',
    domain: 'customer_return',
    action: 'read',
    summary: '客户退货单详情（普通读不记审计，D54 ②）',
    audit: { kind: 'none' },
    response: { status: 200, schema: CustomerReturnSchema },
  }),
];
