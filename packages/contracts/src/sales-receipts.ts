import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 收款记录契约（契约第一批 §6，内嵌 E 单详情页，D24 / D34 / D40 / D51 / D54）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **金额一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`，避免浮点误差；
 * - **方向与金额符号必须一致**（§6 / D34）：收款行金额 > 0，退款行金额 < 0；
 *   用 `refine` 锁死，不只是注释——退款只追加负数行，不修改历史行；
 * - **退款不得写成 E 单费用行**（D40）：费用行是成交结构，退款是钱账流水，
 *   两者混用会让毛利的成交额口径失真；
 * - **方式枚举封闭**（§6）：在线支付回调 / 线下转账 / 原路退款 / 冲抵应收；
 * - **块内余额 = 收款合计 − 退款合计**（D34）：由服务端计算，
 *   以 `SalesOrderDetail.receiptBalance` 只读回显，客户端不传；
 * - 写操作必记审计（D51）；普通读不记（D54 ②）；
 * - 涉及钱账，**追加收款属危险动作：AI 默认禁止且必须给原因**（D52① / D54 ⑥）。
 *
 * 本批明确不做（等后续批次）：
 * - **不做收款记录的 update / delete**：退账走新增负数退款行（D34/D40），不改历史行；
 * - **不做「在线支付回调」的接收端点**：支付模式 A（企业自配商户号、平台不碰钱）
 *   在二期 / 后续批次（D34）；
 * - **不做 R 客户退货单**：R 是独立单据，关联关系只以 `reversalDocId` 占位（§6）；
 * - **不做「纠收款」与「减成交额」两型的重算逻辑**：本批只登记 direction / method，
 *   毛利与提成重算在退货批次做（D40；结算后走退货不冲正，D2③）。
 */

/** decimal 字符串（D54 `numeric(18,6)`：最多 12 位整数 + 6 位小数，可负）。 */
const DecimalString = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（最多 6 位小数，D54）');

/** 收款方向（§6）：退款是负数行，不是独立单据。 */
export const SalesReceiptDirectionSchema = z.enum(['收款', '退款']);
export type SalesReceiptDirection = z.infer<typeof SalesReceiptDirectionSchema>;

/** 收款方式（§6，封闭枚举；「在线支付回调」的接收端点本批不做，D34）。 */
export const SalesReceiptMethodSchema = z.enum([
  '在线支付回调',
  '线下转账',
  '原路退款',
  '冲抵应收',
]);
export type SalesReceiptMethod = z.infer<typeof SalesReceiptMethodSchema>;

const DIRECTION_AMOUNT_MESSAGE =
  '收款行金额必须 > 0、退款行金额必须 < 0（§6 / D34；退款只追加负数行，不改历史行）';

/**
 * 方向与金额符号一致性：收款 > 0，退款 < 0（D34/D40）。
 * 无看价权限时 `amount` 为 null（D79），此时不判符号——脱敏字段保留、值不下发。
 */
function directionMatchesAmount(value: { direction: SalesReceiptDirection; amount: string | null }): boolean {
  if (value.amount === null) return true;
  if (value.direction === '退款') return Number(value.amount) < 0;
  return Number(value.amount) > 0;
}

/** 实体与创建入参共用的字段（服务端生成字段不在其中）。 */
const receiptFields = {
  direction: SalesReceiptDirectionSchema,
  /** 金额；**无 `sales.view_price` 时响应为 null**（D79）。 */
  amount: DecimalString,
  method: SalesReceiptMethodSchema,
  /** 发生时间（§6），ISO datetime 字符串。 */
  occurredAt: z.string().datetime(),
  /** 退款关联的 R 冲正单，选填（§6；是否强制关联见 open item §11-2）。 */
  reversalDocId: z.string().uuid().nullable(),
  /** 备注可空，≤200（§6）。 */
  remark: z.string().max(200).nullable(),
};

/**
 * 收款记录实体（§6）：内嵌 E 单详情页，不新增独立页面（D24）。
 * 退款以负数行记入同一块（D34/D40）。
 */
export const SalesReceiptSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    /** 公司隔离（D15）：收款记录随所属 E 单归属公司。 */
    companyId: z.string(),
    salesOrderId: z.string(),
    ...receiptFields,
    /** 金额；无 `sales.view_price` 时响应为 null（D79：字段保留、不出 0、不 403）。 */
    amount: DecimalString.nullable(),
    /** 乐观锁版本：记录只追加，版本留给后续批次（本批不做 update）。 */
    version: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .refine(directionMatchesAmount, { message: DIRECTION_AMOUNT_MESSAGE, path: ['amount'] });
export type SalesReceipt = z.infer<typeof SalesReceiptSchema>;

/**
 * 追加收款记录入参（§6）：
 * - 服务端生成 `id` / `tenantId` / `companyId` / `salesOrderId` / `version` / 时间戳，
 *   客户端**不传**；
 * - `reversalDocId` / `remark` 选填；
 * - 退款必须为负数行（refine，见上）。
 */
export const SalesReceiptCreateInputSchema = z
  .object({
    direction: SalesReceiptDirectionSchema,
    amount: DecimalString,
    method: SalesReceiptMethodSchema,
    occurredAt: z.string().datetime(),
    reversalDocId: z.string().uuid().nullable().optional(),
    remark: z.string().max(200).nullable().optional(),
  })
  .refine(directionMatchesAmount, { message: DIRECTION_AMOUNT_MESSAGE, path: ['amount'] });
export type SalesReceiptCreateInput = z.infer<typeof SalesReceiptCreateInputSchema>;

/**
 * 收款记录端点（2 条，契约第一批 §6）：
 * - 列表：普通读不记审计（D54 ②），返回数组而非分页——收款台账内嵌 E 单详情块（D24），
 *   单量有限，且 §6 未定义游标查询；
 * - 追加：写操作必记审计（D51）；涉及钱账，AI 禁止且必须给原因（D52① / D54 ⑥）。
 */
export const SALES_RECEIPT_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'sales',
    operationId: 'sales.receipt.read',
    method: 'GET',
    path: '/api/v1/sales-orders/{id}/receipts',
    domain: 'sales',
    action: 'read',
    summary: '销售单收款记录（内嵌收款台账，退款为负数行；普通读不记审计，D24/D34）',
    audit: { kind: 'none' },
    response: { status: 200, schema: z.array(SalesReceiptSchema) },
  }),
  defineRoute({
    module: 'sales',
    operationId: 'sales.receipt.create',
    method: 'POST',
    path: '/api/v1/sales-orders/{id}/receipts',
    domain: 'sales',
    action: 'update',
    summary: '追加收款记录（退款为负数行；钱账危险动作，AI 默认禁止且必须给原因，D34/D40/D52①）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: SalesReceiptCreateInputSchema },
    response: { status: 201, schema: SalesReceiptSchema },
  }),
];
