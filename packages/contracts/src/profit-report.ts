import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 利润报表契约（D43 / Issue #164；口径见 #97）。
 *
 * 一期只落**契约 + 端口 + 骨架**，真实聚合由 settlement / processing 的 owner 实现：
 * - **毛利** = 期间内已结算 C 单的毛利合计（D5 口径，直接汇总 C 单 `gross_profit`）；
 * - **全损耗损失** = 期间内 B 单的全损耗金额合计（D35 / D43）；
 * - **净毛利** = 毛利 − 全损耗损失（D33「净毛利 = 毛利 − 相关损失」在报表层的聚合）；
 * - **未归属损失**（D43）一期**固定为 `null` / 不可用**：归属判定依赖
 *   `processing_order.attributed` 之外的口径（#97 未拍板），先占位，实现方落地后
 *   把 `unattributedLossAvailable` 从 `z.literal(false)` 放开成 boolean。
 * - **金额一律 NonNegativeDecimal / decimal 字符串**（D54），不用 `number`；
 *   毛利 / 净毛利可为负，用带符号的 decimal 字符串。
 * - **金额脱敏（D27 / D78）**：调用者无 `profit_report.view_price` 时下列金额字段
 *   返回 `null`——字段保留、不删、不出 0，也不 403。判定在本层只写进 summary / 注释，
 *   实现由 report 模块 owner 按 `purchase/services/masking.ts` 的范式补。
 * - 两条都是普通读，**不记审计**（D54 ②）。
 */

/** 可为负的 decimal 字符串（D54 `numeric(18,6)`：最多 12 位整数 + 6 位小数）。 */
const DecimalString = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（最多 6 位小数，D54）');

/** 非负 decimal 字符串：损失金额（D54 `numeric(18,6)`）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/**
 * 期间查询：起止日 `YYYY-MM-DD`（含当日，与提成生效日 / 报价日同格式），
 * 可选 `companyIds` 收口到指定公司（缺省按调用者可见公司集合，D15）。
 */
export const ProfitReportQuerySchema = z.object({
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  companyIds: z.array(z.string().uuid()).optional(),
});
export type ProfitReportQuery = z.infer<typeof ProfitReportQuerySchema>;

/**
 * 利润报表（D43 / #97 口径，一期）：
 * - `grossProfit`：期间毛利合计，可为负，无看价权限 → null；
 * - `fullLossAmount`：B 单全损耗损失合计，非负，无看价权限 → null；
 * - `netProfit` = 毛利 − 损失，可为负，无看价权限 → null；
 * - `unattributedLoss`：**本期固定 null**（未归属损失口径未拍板）；
 * - `unattributedLossAvailable`：**本期固定 false**——前端据此隐藏下钻入口；
 * - `settledOrderCount`：参与汇总的已结算 C 单数（非金额，不脱敏）。
 */
export const ProfitReportSchema = z.object({
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  grossProfit: DecimalString.nullable(),
  fullLossAmount: NonNegativeDecimal.nullable(),
  netProfit: DecimalString.nullable(),
  unattributedLoss: z.literal(null),
  unattributedLossAvailable: z.literal(false),
  settledOrderCount: z.number().int().min(0),
});
export type ProfitReport = z.infer<typeof ProfitReportSchema>;
z.globalRegistry.add(ProfitReportSchema, { id: 'ProfitReport' });

/**
 * 未归属损失下钻行（D43）：一张 B 单的全损耗损失及其归属状态。
 * `lossAmount` 无看价权限 → null；`attributed` 是归属判定结果，不脱敏。
 */
export const ProfitLossItemSchema = z.object({
  processingOrderId: z.string(),
  processingOrderNo: z.string(),
  lossAmount: NonNegativeDecimal.nullable(),
  attributed: z.boolean(),
});
export type ProfitLossItem = z.infer<typeof ProfitLossItemSchema>;
z.globalRegistry.add(ProfitLossItemSchema, { id: 'ProfitLossItem' });

/** 下钻响应：一期不做游标分页（期间内行数可控），需要时再加 `pageSchema`。 */
export const ProfitLossListSchema = z.object({
  items: z.array(ProfitLossItemSchema),
});
export type ProfitLossList = z.infer<typeof ProfitLossListSchema>;
z.globalRegistry.add(ProfitLossListSchema, { id: 'ProfitLossList' });

/**
 * report 模块利润报表端点（2 条）。
 *
 * operationId 以功能域 `profit_report` 开头（registry 校验要求）；两条都是普通读，
 * 不记审计；金额受 `profit_report.view_price` 管（无权限 → null，D27 / D78）。
 */
export const PROFIT_REPORT_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'report',
    operationId: 'profit_report.read',
    method: 'GET',
    path: '/api/v1/reports/profit',
    domain: 'profit_report',
    action: 'read',
    summary:
      '按期间汇总已结算 C 单毛利 + B 单全损耗，给出净毛利（D43 / #97；金额受 profit_report.view_price 管，无权限为 null，D78）',
    audit: { kind: 'none' },
    request: { query: ProfitReportQuerySchema },
    response: { status: 200, schema: ProfitReportSchema },
  }),
  defineRoute({
    module: 'report',
    operationId: 'profit_report.loss.read',
    method: 'GET',
    path: '/api/v1/reports/profit/losses',
    domain: 'profit_report',
    action: 'read',
    summary:
      '未归属损失下钻：期间内 B 单全损耗损失及归属状态（D43；金额受 profit_report.view_price 管，无权限为 null，D78）',
    audit: { kind: 'none' },
    request: { query: ProfitReportQuerySchema },
    response: { status: 200, schema: ProfitLossListSchema },
  }),
];
