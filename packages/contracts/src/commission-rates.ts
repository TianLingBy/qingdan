import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 提成比例配置契约（D5④ / D36 / D77）。
 *
 * 口径（别在这里「顺手加字段」）：
 * - **一期只支持按人配置**（D77 ①）：按岗（D5④ 的另一半）需要 platform 岗位解析端口，
 *   未落地前不在本批猜实现；`employeeId` 必填，就是这条配置作用的业务员。
 * - **配置归 settlement 域**：提成是 C 单的派生数字（D36 以 C 单为单位、不跨单归并），
 *   所以配置表也由 settlement 拥有；来源模块只传「归属人」，不传比例（D77 ②）。
 * - **生效期**：`effectiveFrom`（日期，含当日）。同一员工 + 同一公司 + 同一生效日唯一，
 *   重复插入返回 409，不静默覆盖（宁可让财务看见冲突）。
 * - **结算时快照**（D36）：确认结算时取 `effectiveFrom <= 结算日` 的最新一条写成
 *   `commissionRateSnapshot`，之后改配置不影响已结算单（D77 ④）。
 * - 比例用 decimal 字符串存 `numeric(18,6)`（D54），取值 [0, 1]（0.05 = 5%）。
 * - 写操作必记审计（D51）；普通读不记（D54 ②）；**配置改动影响钱，AI 默认禁止**（D52①）。
 */

/** decimal 字符串（D54 `numeric(18,6)`）。 */
const DecimalString = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数，D54）');

/** 比例必须落在 [0, 1]（0.05 = 5%）。用字符串比较避免浮点误差。 */
function isRateInRange(value: string): boolean {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1;
}

const RateString = DecimalString.refine(isRateInRange, '提成比例必须在 0 与 1 之间（0.05 = 5%）');

/**
 * 提成比例配置实体。
 * - `id`：UUIDv7；
 * - `companyId`：公司隔离（D15），跨公司不可见；
 * - `employeeId`：业务员（D77 ① 按人）；
 * - `rate`：比例，[0, 1]；
 * - `effectiveFrom`：生效日（`YYYY-MM-DD`，含当日）；
 * - `createdBy`：配置人，写审计时与 `createdBy` 一致。
 */
export const CommissionRateSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  companyId: z.string().uuid(),
  employeeId: z.string().uuid(),
  rate: RateString,
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '生效日必须是 YYYY-MM-DD'),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CommissionRate = z.infer<typeof CommissionRateSchema>;
z.globalRegistry.add(CommissionRateSchema, { id: 'CommissionRate' });

/** 新增配置：同一员工 + 公司 + 生效日唯一（D77 ①）。 */
export const CommissionRateCreateInputSchema = z.object({
  companyId: z.string().uuid(),
  employeeId: z.string().uuid(),
  rate: RateString,
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '生效日必须是 YYYY-MM-DD'),
});
export type CommissionRateCreateInput = z.infer<typeof CommissionRateCreateInputSchema>;

/** 列表查询：按公司 / 员工过滤，游标分页（D54）。 */
export const CommissionRateListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
});

/**
 * 提成配置端点（3 条）。
 *
 * operationId 以 `commission` 开头（与功能域同名，registry 校验要求）；`module` 仍是
 * `settlement`，因为配置表与 C 单同属结算域（D77 ①）。
 * 权限：查询 `commission.read`；新增 `commission.create`；删除 `commission.delete`。
 * 审计：普通读不记（D54 ②）；新增 / 删除记 write（D51）。
 * AI：配置直接决定钱，默认禁止且必须给原因（D52① / D54 ⑥）。
 * 并发：一期配置行没有版本列，删除按 id 幂等（已删返回 404）。
 */
export const COMMISSION_RATE_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'settlement',
    operationId: 'commission.rate.list.read',
    method: 'GET',
    path: '/api/v1/commission-rates',
    domain: 'commission',
    action: 'read',
    summary: '提成比例配置列表（按公司 / 员工检索；普通读不记审计，D15 / D77）',
    audit: { kind: 'none' },
    request: { query: CommissionRateListQuerySchema },
    response: { status: 200, schema: pageSchema(CommissionRateSchema) },
  }),
  defineRoute({
    module: 'settlement',
    operationId: 'commission.rate.create',
    method: 'POST',
    path: '/api/v1/commission-rates',
    domain: 'commission',
    action: 'create',
    summary: '新增提成比例配置（同员工 + 公司 + 生效日唯一；AI 默认禁止，D77）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: CommissionRateCreateInputSchema },
    response: { status: 201, schema: CommissionRateSchema },
  }),
  defineRoute({
    module: 'settlement',
    operationId: 'commission.rate.delete',
    method: 'DELETE',
    path: '/api/v1/commission-rates/{id}',
    domain: 'commission',
    action: 'delete',
    summary: '删除提成比例配置（已结算单靠快照冻结，不受影响；AI 默认禁止，D77 ④）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    response: { status: 200, schema: CommissionRateSchema },
  }),
];
