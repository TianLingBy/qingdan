import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * C 结算单契约（契约第一批 §3.4；D2③ / D5 / D11 / D19 / D29 / D33 / D35 / D36 / D51 / D52 / D54）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **C 单状态是独立两态** `待确认 / 已结算`：**不复用** `documents.ts` 的 `HEADER_STATES`。
 *   C 单是「草稿 → 确认」，没有「进行中 / 已取消」；结算后不可冲正，错账走 R 退货（D2③）。
 * - **一期一单一次结算**（D19）：不支持部分结算 / 多次结算；E/N 单「已完成」时由系统自动
 *   生成草稿（D19 / D29），财务确认后才生效——本模块**不暴露创建端点**。
 * - **毛利公式固化**（D5）：毛利 = 总售价 − 总成本；毛利率 = 毛利 ÷ 总售价。
 * - **净毛利 = 毛利 − 本单相关损失**（D26 / D33）：仅展示层聚合，不改 D5 毛利公式、不摊批次。
 * - **本单相关损失**（D35）= Σ(归属单 = 本单对应 E/N 单 的 B 单损失金额)；
 *   是实时重算还是结算时快照属契约第一批 §11-5 开放项，**尚未拍板**，契约层不预设；
 *   结算后退货的毛利 / 提成重算走 F4b 并留痕。
 * - **提成以 C 单为单位结算、不跨单归并**（D36）：`commissionRateSnapshot` 是**结算时快照**，
 *   之后改比例不影响本单（D5④「改比例不重算历史单」）；一期提成仅为报表数字（D11）。
 * - **提成归属人**（D77 ②）：`commissionOwnerId` 是来源单负责人，由来源模块生成草稿时传入；
 *   确认结算时按它在**本公司**解析比例（见 `commission-rates.ts`），无配置则比例记 0。
 * - **金额一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`；
 *   `grossProfit` / `grossMarginRate` / `netProfit` 是**服务端计算值**，客户端不传。
 * - 写操作必记审计（D51）；普通读不记（D54 ②）；**结算确认属审批动作**，
 *   scope 用 `settlement.approve`，AI 默认禁止且必须给原因（D52① / D54 ⑥）。
 *
 * 本批明确不做（写进契约，防止后续顺手加端点）：
 * - **不做 create**：C 单草稿由 E/N 单「已完成」时系统内部自动生成（D19 / D29）；
 * - **不做取消 / 冲正**：结算后不可冲正，错账走 R 退货（D2③）；
 * - **不做提成规则配置端点与利润报表端点**：提成规则见 `commission-rates.ts`（D77，
 *   已从「后续批次」提前到本批）；利润报表是 `profit_report` 域（D43），仍未做；
 * - **不做部分结算 / 多次结算**（D19）；
 * - **不做 R 退货触发的毛利 / 提成重算端点**：F4b 重算在退货批次落地（D30 / D40）。
 */

/** decimal 字符串（D54 `numeric(18,6)`：最多 12 位整数 + 6 位小数，可负）。 */
const DecimalString = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（最多 6 位小数，D54）');

/** 非负 decimal 字符串：售价 / 成本 / 损失 / 提成比例与金额（D54 `numeric(18,6)`）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/**
 * C 单独立两态（§3.4）：**不复用** `HEADER_STATES`。
 * 「待确认」= 系统自动生成的草稿，「已结算」= 财务确认后的终态（D19）。
 */
export const SETTLEMENT_ORDER_STATES = ['待确认', '已结算'] as const;
export type SettlementOrderState = (typeof SETTLEMENT_ORDER_STATES)[number];
export const SettlementOrderStatusSchema = z.enum(SETTLEMENT_ORDER_STATES);
export type SettlementOrderStatus = z.infer<typeof SettlementOrderStatusSchema>;

/**
 * 来源单类型（§3.4）：E 销售单 / N 内部交易单。
 * E/N 单单头「已完成」时自动生成 C 单草稿（D19 / D29），所以只可能是这两种。
 */
export const SETTLEMENT_SOURCE_DOC_TYPES = ['E', 'N'] as const;
export type SettlementSourceDocType = (typeof SETTLEMENT_SOURCE_DOC_TYPES)[number];
export const SettlementOrderSourceDocTypeSchema = z.enum(SETTLEMENT_SOURCE_DOC_TYPES);

/**
 * C 结算单实体（§3.4）：
 * - `companyId` 公司隔离（D15）：C 单随来源 E/N 单归属公司，跨公司不可见；
 * - `totalSaleAmount` / `totalCostAmount`：计算值（来源单成交额与批次成本合计）；
 * - `grossProfit` = 总售价 − 总成本（D5），**可为负**；
 * - `grossMarginRate` = 毛利 ÷ 总售价（D5），**可为负**；
 * - `relatedLossAmount`：本单相关损失（D35），结算时快照（§11-5），非负；
 * - `netProfit` = 毛利 − 本单相关损失（D33），**可为负**；
 * - `commissionRateSnapshot`：**结算时快照**（D36），之后改比例不影响本单；
 * - `commissionAmount`：提成金额，负毛利记 0（D5④），非负；一期仅为报表数字（D11）。
 *
 * **金额脱敏（D27 / D78）**：调用者无 `settlement.view_price` 时，下列金额字段返回 `null`
 * （字段保留、不删不出 0，也不 403）——「可见记录、金额隐藏」；普通读不记日志，
 * 但**有看价权限的成功读取会写一条 `amount.detail` 审计**（D51①）。
 */
export const SettlementOrderSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：C 单归属某一公司，跨公司不可见。 */
  companyId: z.string(),
  /** 单号（服务端按 D16 生成，格式 `C-<公司码4>-<日期8>-<流水4>`）。 */
  orderNo: z.string(),
  /** 来源单类型：E 销售单 / N 内部交易单（D19 / D29）。 */
  sourceDocType: SettlementOrderSourceDocTypeSchema,
  /** 来源单 id：一张 C 单对应且仅对应一张 E/N 单（一期一单一次，D19）。 */
  sourceDocId: z.string(),
  status: SettlementOrderStatusSchema,
  /** 总售价：来源单成交额合计（decimal 字符串，D54）；无看价权限 → null（D78）。 */
  totalSaleAmount: NonNegativeDecimal.nullable(),
  /** 总成本：来源单引用批次成本合计（decimal 字符串，D54）；无看价权限 → null（D78）。 */
  totalCostAmount: NonNegativeDecimal.nullable(),
  /** 毛利 = 总售价 − 总成本（D5）；服务端计算值，可为负；无看价权限 → null（D78）。 */
  grossProfit: DecimalString.nullable(),
  /** 毛利率 = 毛利 ÷ 总售价（D5）；服务端计算值，可为负；无看价权限 → null（D78）。 */
  grossMarginRate: DecimalString.nullable(),
  /** 本单相关损失（D35）：结算时快照，非负；无看价权限 → null（D78）。 */
  relatedLossAmount: NonNegativeDecimal.nullable(),
  /** 净毛利 = 毛利 − 本单相关损失（D33）；服务端计算值，可为负；无看价权限 → null（D78）。 */
  netProfit: DecimalString.nullable(),
  /** 提成比例快照：**结算时快照**，之后改比例不影响本单（D36 / D5④）。 */
  commissionRateSnapshot: NonNegativeDecimal,
  /** 提成金额：负毛利记 0（D5④），一期仅为报表数字（D11）；无看价权限 → null（D78）。 */
  commissionAmount: NonNegativeDecimal.nullable(),
  /**
   * 提成归属人：来源单负责人（D77 ②）。草稿生成时写入；确认结算时按它在**本公司**
   * `effectiveFrom <= 结算日` 的最新配置解析比例。历史草稿可能为 null（比例记 0）。
   */
  commissionOwnerId: z.string().uuid().nullable(),
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SettlementOrder = z.infer<typeof SettlementOrderSchema>;

/** 不可确认的原因：一期只有「已结算」一种终态（D19），不存在「已取消」。 */
export const SETTLEMENT_CONFIRM_BLOCK_REASONS = ['already_settled'] as const;
export type SettlementConfirmBlockReason = (typeof SETTLEMENT_CONFIRM_BLOCK_REASONS)[number];

/**
 * 「是否可确认结算」口径（D19）：由实现侧调用 `settlementConfirmable` 推导后回给前端，
 * 前端直接渲染，不自行重算。待确认 → 可确认；已结算 → 不可再确认（一期一单一次）。
 */
export const SettlementConfirmableSchema = z.object({
  allowed: z.boolean(),
  reason: z.enum(SETTLEMENT_CONFIRM_BLOCK_REASONS).nullable(),
});
export type SettlementConfirmable = z.infer<typeof SettlementConfirmableSchema>;

export function settlementConfirmable(
  status: SettlementOrderStatus,
): SettlementConfirmable {
  return status === '已结算'
    ? { allowed: false, reason: 'already_settled' }
    : { allowed: true, reason: null };
}

/**
 * C 结算单详情（§3.4）：在列表实体上补确认判定 `confirmable`。
 * 不内嵌商品明细 / 收发记录：C 单是计算与结算凭证，明细以来源 E/N 单为准。
 */
export const SettlementOrderDetailSchema = SettlementOrderSchema.extend({
  confirmable: SettlementConfirmableSchema,
});
export type SettlementOrderDetail = z.infer<typeof SettlementOrderDetailSchema>;

/**
 * 结算单列表查询：公司 / 状态 / 来源单类型 / 关键字（单号），游标分页。
 * 公司隔离（D15）由服务端按调用者可见公司集合再收口。
 */
export const SettlementOrderListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  status: SettlementOrderStatusSchema.optional(),
  sourceDocType: SettlementOrderSourceDocTypeSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * settlement 模块 C 结算单端点（3 条，契约第一批 §3.4）。
 *
 * operationId 以 `settlement` 开头（与功能域同名，registry 校验要求）。
 * 权限：查询 `settlement.read`；**确认结算属审批动作**，scope 用 `settlement.approve`（D44）。
 * 审计：普通读不记（D54 ②）；**有看价权限的详情读取记一条 `amount.detail`（D51① / D78）**；确认结算记 write（D51）。
 * AI：**结算确认属危险动作，默认禁止且必须给原因**（D52① / D54 ⑥）。
 * 并发：confirm 强制 If-Match 强 ETag。
 * 一期一单一次结算（D19）；结算后不可冲正，走退货（D2③）。
 */
export const SETTLEMENT_ORDER_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'settlement',
    operationId: 'settlement.order.list.read',
    method: 'GET',
    path: '/api/v1/settlement-orders',
    domain: 'settlement',
    action: 'read',
    summary: '结算单列表（按公司/状态/来源单类型/单号检索；无看价权限时金额字段为 null，D15 / D27 / D78）',
    audit: { kind: 'none' },
    request: { query: SettlementOrderListQuerySchema },
    response: { status: 200, schema: pageSchema(SettlementOrderSchema) },
  }),
  defineRoute({
    module: 'settlement',
    operationId: 'settlement.order.detail.read',
    method: 'GET',
    path: '/api/v1/settlement-orders/{id}',
    domain: 'settlement',
    action: 'read',
    summary:
      '结算单详情（内嵌确认判定 confirmable；无 settlement.view_price 时金额字段为 null，D27 / D78；看过金额记 amount.detail，D51①）',
    audit: { kind: 'none' },
    response: { status: 200, schema: SettlementOrderDetailSchema },
  }),
  defineRoute({
    module: 'settlement',
    operationId: 'settlement.order.confirm',
    method: 'POST',
    path: '/api/v1/settlement-orders/{id}/confirm',
    domain: 'settlement',
    action: 'approve',
    summary:
      '确认结算（待确认 → 已结算；一期一单一次 D19；结算后不可冲正走退货 D2③；AI 禁止审批 D52）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    response: { status: 200, schema: SettlementOrderDetailSchema },
  }),
];
