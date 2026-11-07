import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 盘点调整 I 契约（契约第一批 §4 冲正单据 / §8 库存流水；
 * D2① / D15 / D16 / D47 / D51 / D52 / D54 / D67）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **盘点单是审批流**：状态三态 `待审批 / 已批准 / 已驳回`，**不复用** `HEADER_STATES`
 *   （单据框架的「进行中 / 已完成 / 已取消」不是审批流）；
 * - **差异量不接收**：客户端只传账面量 `bookQty` 与实盘量 `actualQty`，
 *   服务端计算 `diffQty = actualQty − bookQty`（可正可负）后落库；
 *   `actualQty === bookQty`（无差异）不允许开单，用 `refine` 锁死；
 * - **数量一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`；
 * - **盘盈盘亏走冲正流水、不物理删除**（D47）：审批通过后追加一条库存流水
 *   （盘盈为正、盘亏为负），批次与历史流水一行都不删、不改；
 * - **审批端点不直接改批次数量**（D67 / Issue #48 §2）：库存写入只能经 inventory
 *   服务函数，与单据同事务；本契约只登记审批动作；
 * - **单号服务端按 D16 取号**（`I-<公司码4>-<日期8>-<流水4>`），客户端不传；
 * - 公司隔离（D15）：盘点单归属某一公司，跨公司不可见；
 * - 写操作必记审计（D51）；普通读不记（D54 ②）；
 * - **审批只能人类执行**：AI 默认禁止且必须给原因（D52① / D54 ⑥）。
 *
 * 本批明确不做（等后续批次）：
 * - **不做驳回端点**（`stocktake.reject`）：一期先做「批准」路径，驳回留后续批次；
 * - **不做批量盘点**：一期一张盘点单对应一个批次；
 * - **不做盘点明细表**：一个批次一条差异，够一期用。
 */

/** 非负 decimal 字符串：账面量 / 实盘量（D54 `numeric(18,6)`）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/** 可负 decimal 字符串：差异量，盘盈为正、盘亏为负（D47 / D54）。 */
const SignedDecimal = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, '差异量必须是 decimal 字符串（可负、最多 6 位小数）');

/**
 * 盘点单状态（审批流三态）：**不复用** `HEADER_STATES`。
 * 待审批 → 已批准 / 已驳回；一期只做「批准」路径，驳回端点留后续批次。
 */
export const STOCKTAKE_STATUSES = ['待审批', '已批准', '已驳回'] as const;
export type StocktakeStatus = (typeof STOCKTAKE_STATUSES)[number];
export const StocktakeStatusSchema = z.enum(STOCKTAKE_STATUSES);

/** 不可审批的原因：已批准 / 已驳回都是终态（一期无重新审批）。 */
export const STOCKTAKE_APPROVE_BLOCK_REASONS = ['already_approved', 'already_rejected'] as const;
export type StocktakeApproveBlockReason = (typeof STOCKTAKE_APPROVE_BLOCK_REASONS)[number];

/**
 * 「是否可审批」口径：由实现侧按状态推导后回给前端，前端直接渲染、不自行重算。
 * 待审批 → 可审批；已批准 / 已驳回 → 不可再审批。
 */
export const StocktakeApprovableSchema = z.object({
  allowed: z.boolean(),
  reason: z.enum(STOCKTAKE_APPROVE_BLOCK_REASONS).nullable(),
});
export type StocktakeApprovable = z.infer<typeof StocktakeApprovableSchema>;

export function stocktakeApprovable(status: StocktakeStatus): StocktakeApprovable {
  if (status === '已批准') return { allowed: false, reason: 'already_approved' };
  if (status === '已驳回') return { allowed: false, reason: 'already_rejected' };
  return { allowed: true, reason: null };
}

/**
 * 盘点调整单实体（契约第一批 §4）：
 * - `stocktakeNo` 服务端按 D16 取号（`I-<公司码4>-<日期8>-<流水4>`）；
 * - `diffQty = actualQty − bookQty` 是**服务端计算值**，可正可负；
 * - `approverId` 审批后落值，审批前为空；
 * - `status` 是审批流三态，不复用单据框架的 `HEADER_STATES`。
 */
export const StocktakeSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：盘点单归属某一公司，跨公司不可见。 */
  companyId: z.string(),
  /** 单号（服务端按 D16 生成，格式 `I-<公司码4>-<日期8>-<流水4>`）。 */
  stocktakeNo: z.string(),
  /** 盘点对象：一期一张盘点单对应一个批次。 */
  batchId: z.string(),
  /** 账面量：decimal 字符串（D54）。 */
  bookQty: NonNegativeDecimal,
  /** 实盘量：decimal 字符串（D54）。 */
  actualQty: NonNegativeDecimal,
  /** 差异量 = 实盘量 − 账面量（服务端计算，盘盈为正、盘亏为负）。 */
  diffQty: SignedDecimal,
  status: StocktakeStatusSchema,
  /** 发起人。 */
  applicantId: z.string(),
  /** 审批人：审批前为空。 */
  approverId: z.string().nullable(),
  /** 备注可空，≤200。 */
  remark: z.string().max(200).nullable(),
  /** 乐观锁版本：审批用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Stocktake = z.infer<typeof StocktakeSchema>;

/**
 * 盘点单详情：在实体上补审批判定 `approvable`。
 * 已批准 / 已驳回不可再批（一期不做重新审批）。
 */
export const StocktakeDetailSchema = StocktakeSchema.extend({
  approvable: StocktakeApprovableSchema,
});
export type StocktakeDetail = z.infer<typeof StocktakeDetailSchema>;

/** 无差异不允许开单：`actualQty === bookQty` 时拒绝（D47：盘点只为盘盈盘亏冲正）。 */
const NO_DIFFERENCE_MESSAGE = '无差异不需要盘点单';

/** 去掉前导零与小数末尾的零：`001` / `1.000000` → `1`，用于精确比较 decimal 字符串。 */
function normalizeDecimal(value: string): string {
  const parts = value.split('.');
  const int = (parts[0] ?? '0').replace(/^0+(?=\d)/, '');
  const frac = (parts[1] ?? '').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function hasDifference(value: { bookQty: string; actualQty: string }): boolean {
  // 按 decimal 字符串归一化后比较，不用 Number：
  // ① `1` 与 `1.000000` 视为同一数量；
  // ② `numeric(18,6)` 最多 18 位有效数字，超出 double 精度，转 Number 会误判相等。
  return normalizeDecimal(value.actualQty) !== normalizeDecimal(value.bookQty);
}

/** 按 `numeric(18,6)` 定点比较两个 decimal 字符串：返回负数 / 0 / 正数。 */
function compareDecimal(left: string, right: string): number {
  const toScaled = (value: string): bigint => {
    const [int, frac = ''] = value.split('.');
    return BigInt(`${int}${frac.padEnd(6, '0')}`);
  };
  const a = toScaled(left);
  const b = toScaled(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * 发起盘点单入参：
 * - 服务端生成 `id` / `tenantId` / `stocktakeNo` / `diffQty` / `status` /
 *   `applicantId` / `approverId` / `version` / 时间戳，客户端**不传**；
 * - **差异量不接收**：由服务端算 `diffQty = actualQty − bookQty`（可正可负）；
 * - 无差异（`actualQty === bookQty`）拒绝，提示「无差异不需要盘点单」。
 */
export const StocktakeCreateInputSchema = z
  .object({
    companyId: z.string().uuid(),
    batchId: z.string().uuid(),
    bookQty: NonNegativeDecimal,
    actualQty: NonNegativeDecimal,
    remark: z.string().max(200).nullable().optional(),
  })
  .refine(hasDifference, { message: NO_DIFFERENCE_MESSAGE, path: ['actualQty'] });
export type StocktakeCreateInput = z.infer<typeof StocktakeCreateInputSchema>;

/**
 * 盘盈入参：实盘量必须**大于**账面量（D71）。
 * 与盘亏拆成两条路由，是因为两者的权限口径不同（盘盈 = `stocktake.create`，
 * 盘亏 = `stocktake.delete`／「仅删减」，见 D71）。
 */
export const StocktakeIncreaseInputSchema = StocktakeCreateInputSchema.refine(
  (value) => compareDecimal(value.actualQty, value.bookQty) > 0,
  { message: '盘盈单要求实盘量大于账面量', path: ['actualQty'] },
);

/** 盘亏入参：实盘量必须**小于**账面量（D71）。 */
export const StocktakeDecreaseInputSchema = StocktakeCreateInputSchema.refine(
  (value) => compareDecimal(value.actualQty, value.bookQty) < 0,
  { message: '盘亏单要求实盘量小于账面量', path: ['actualQty'] },
);

/**
 * 盘点单列表查询：公司 / 状态 / 关键字（单号），游标分页。
 * 公司隔离（D15）由服务端按调用者可见公司集合再收口。
 */
export const StocktakeListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  status: StocktakeStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * inventory 模块盘点调整 I 端点（5 条，契约第一批 §4 / §8；D71 拆盘盈/盘亏）。
 *
 * operationId 以 `stocktake` 开头（功能域 = 权限域，registry 校验要求）；
 * **不要用 `stocktake_page`**：那是页面权限域，不是本单据的功能域。
 * 权限：查询 `stocktake.read`；盘盈 `stocktake.create`；盘亏 `stocktake.delete`（仅删减）；
 * **审批 `stocktake.approve`**（D71）。
 * 审计：普通读不记（D54 ②）；发起 / 审批记 write（D51）。
 * AI：发起盘点默认禁止；**审批只能人类，禁止 AI 且必须给原因**（D52① / D54 ⑥）。
 * 并发：审批强制 If-Match 强 ETag。
 * 审批通过后追加一条库存流水（盘盈为正、盘亏为负），**不物理删除任何行**（D47）；
 * **不在此端点直接改批次数量**——库存写入只能经 inventory 服务函数（D67）。
 */
export const STOCKTAKE_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'inventory',
    operationId: 'stocktake.list.read',
    method: 'GET',
    path: '/api/v1/stocktakes',
    domain: 'stocktake',
    action: 'read',
    summary: '盘点单列表（按公司/状态/单号检索；普通读不记审计，D15）',
    audit: { kind: 'none' },
    request: { query: StocktakeListQuerySchema },
    response: { status: 200, schema: pageSchema(StocktakeSchema) },
  }),
  defineRoute({
    module: 'inventory',
    operationId: 'stocktake.increase.create',
    method: 'POST',
    path: '/api/v1/stocktakes/increases',
    domain: 'stocktake',
    action: 'create',
    summary:
      '发起盘盈单（实盘量 > 账面量；差异量服务端算；盘盈走冲正流水 D47；权限 stocktake.create，D71）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: StocktakeIncreaseInputSchema },
    response: { status: 201, schema: StocktakeSchema },
  }),
  defineRoute({
    module: 'inventory',
    operationId: 'stocktake.decrease.create',
    method: 'POST',
    path: '/api/v1/stocktakes/decreases',
    domain: 'stocktake',
    action: 'delete',
    summary:
      '发起盘亏单（实盘量 < 账面量；只追加冲正流水、不物理删除 D47；权限 stocktake.delete = 仅删减，D71）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: StocktakeDecreaseInputSchema },
    response: { status: 201, schema: StocktakeSchema },
  }),
  defineRoute({
    module: 'inventory',
    operationId: 'stocktake.detail.read',
    method: 'GET',
    path: '/api/v1/stocktakes/{id}',
    domain: 'stocktake',
    action: 'read',
    summary: '盘点单详情（内嵌审批判定 approvable；普通读不记审计，D47）',
    audit: { kind: 'none' },
    response: { status: 200, schema: StocktakeDetailSchema },
  }),
  defineRoute({
    module: 'inventory',
    operationId: 'stocktake.approve',
    method: 'POST',
    path: '/api/v1/stocktakes/{id}/approve',
    domain: 'stocktake',
    action: 'approve',
    summary:
      '审批盘点单（通过后追加库存流水、不物理删除 D47；不直接改批次数量 D67；AI 禁止审批 D52）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    response: { status: 200, schema: StocktakeDetailSchema },
  }),
];
