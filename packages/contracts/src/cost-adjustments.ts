import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 库存成本更正契约（Issue #163 / #100；D5 / D15 / D51 / D54 / D70）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **只改成本、不改数量**：成本更正绝不写 `inventory_flow`（那会改库存数量），
 *   而是落独立的 `inventory_cost_adjustment` 表；
 * - **分档全自动**：服务端按下游引用事实自动判 T1 / T2 / T3，人不参与判断、只确认：
 *   T1 = 无下游引用且未结算（直接生效）、T2 = 已被引用但未结算（走审批）、
 *   T3 = 已进入结算（直接拒绝，成本已锁定）；
 * - **下游引用不直读别人的表**（D70）：inventory 只调 `DownstreamReferencePort`，
 *   由 processing / sales / settlement 各自实现并注册；
 * - **金额一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`；
 * - **成本金额属价格信息**：读接口无 `inventory_qty.view_price` 时金额字段置 `null`，
 *   不报 403、不返回 0（D27 / D50）；
 * - 写操作必记审计（D51）；普通读不记（D54 ②）；
 * - AI 默认禁止发起与审批（成本更正影响利润口径，D52① / D54 ⑥）。
 */

/** 非负 decimal 字符串：单位成本（D54 `numeric(18,6)`，最多 6 位小数）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/** 可负 decimal 字符串：差额金额，正=调增、负=调减（D54）。 */
const SignedDecimal = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, '差额金额必须是 decimal 字符串（可负、最多 6 位小数）');

/** 自动判定档位（服务端快照，不接受客户端传入）。 */
export const COST_ADJUSTMENT_TIERS = ['T1', 'T2', 'T3'] as const;
export type CostAdjustmentTier = (typeof COST_ADJUSTMENT_TIERS)[number];
export const CostAdjustmentTierSchema = z.enum(COST_ADJUSTMENT_TIERS);

/**
 * 成本更正单状态：
 * - `pending_approval` = T2 待审批；
 * - `applied` = T1 直接生效 / T2 审批通过；
 * - `rejected` = T3 不入库；T2 审批驳回。
 */
export const COST_ADJUSTMENT_STATUSES = ['pending_approval', 'applied', 'rejected'] as const;
export type CostAdjustmentStatus = (typeof COST_ADJUSTMENT_STATUSES)[number];
export const CostAdjustmentStatusSchema = z.enum(COST_ADJUSTMENT_STATUSES);

/** 下游引用明细：只回「哪个模块、哪种单据、哪个 id」，不回别人表里的业务字段（D70）。 */
export const DownstreamReferenceSchema = z.object({
  /** 归属模块：processing / sales / settlement。 */
  module: z.string(),
  /** 单据类型：B / E / R / N 等。 */
  docType: z.string(),
  /** 单据 id。 */
  docId: z.string(),
  /** 单据状态快照（判定时看到的值）。 */
  status: z.string(),
});
export type DownstreamReference = z.infer<typeof DownstreamReferenceSchema>;

/**
 * 判定时看到的下游引用快照：
 * `referenced` = 是否被下游引用；`settled` = 是否已产生结算金额（进入结算）。
 * 两者都是**判定时的事实快照**，落库后不随下游变化回写。
 */
export const CostAdjustmentReferenceSnapshotSchema = z.object({
  referenced: z.boolean(),
  settled: z.boolean(),
  references: z.array(DownstreamReferenceSchema),
});
export type CostAdjustmentReferenceSnapshot = z.infer<
  typeof CostAdjustmentReferenceSnapshotSchema
>;

/**
 * 成本更正单实体：
 * - `beforeUnitCost` / `afterUnitCost` / `deltaAmount` 属价格信息：无看价权限时置 `null`；
 * - `deltaAmount = (afterUnitCost − beforeUnitCost) × 该批次 inboundQty`（服务端算）；
 * - `referenceSnapshot` 是判定时看到的下游引用事实；
 * - T3 不落库，因此本实体只可能是 T1 / T2。
 */
export const InventoryCostAdjustmentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：成本更正跟随批次归属公司。 */
  companyId: z.string(),
  /** 批次 id（`inventory_batch.id`，ON DELETE RESTRICT）。 */
  batchId: z.string(),
  /** 自动判定档位快照：T1 直接生效 / T2 走审批。 */
  tier: CostAdjustmentTierSchema,
  /** 更正前单位成本：decimal 字符串；无看价权限时为 null。 */
  beforeUnitCost: NonNegativeDecimal.nullable(),
  /** 更正后单位成本：decimal 字符串；无看价权限时为 null。 */
  afterUnitCost: NonNegativeDecimal.nullable(),
  /** 差额金额 =（后 − 前）× 入库量；正=调增、负=调减；无看价权限时为 null。 */
  deltaAmount: SignedDecimal.nullable(),
  /** 更正原因（必填，≤200）。 */
  reason: z.string(),
  status: CostAdjustmentStatusSchema,
  /** 发起人。 */
  requestedBy: z.string(),
  /** 审批人：T1 直接生效与待审批时为空。 */
  approvedBy: z.string().nullable(),
  /** 判定时的下游引用快照（D70 端口回传，不直读别人表）。 */
  referenceSnapshot: CostAdjustmentReferenceSnapshotSchema,
  /** 请求幂等键（可空）。 */
  requestId: z.string().nullable(),
  /** 乐观锁版本：审批用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  /** 生效时间：T1 创建即生效；T2 审批通过后落值。 */
  appliedAt: z.string().datetime().nullable(),
});
export type InventoryCostAdjustment = z.infer<typeof InventoryCostAdjustmentSchema>;

/**
 * 提交成本更正入参：
 * - 服务端生成 id / 档位 / 差额 / 状态 / 发起人 / 快照 / 版本，客户端**不传**；
 * - 只传「更正后单位成本」与「原因」，更正前成本以批次当前锁定成本为准。
 */
export const CostAdjustmentCreateInputSchema = z.object({
  afterUnitCost: NonNegativeDecimal,
  reason: z.string().trim().min(1, '必须填写更正原因').max(200),
});
export type CostAdjustmentCreateInput = z.infer<typeof CostAdjustmentCreateInputSchema>;

/** 驳回归因：审批驳回必须写明原因（≥1，≤200）。 */
export const CostAdjustmentRejectInputSchema = z.object({
  reason: z.string().trim().min(1, '必须填写驳回原因').max(200),
});
export type CostAdjustmentRejectInput = z.infer<typeof CostAdjustmentRejectInputSchema>;

/** 批次成本更正历史查询：游标分页（按创建时间倒序）。 */
export const CostAdjustmentListQuerySchema = PageQuerySchema;

/**
 * inventory 模块成本更正端点（4 条）。
 *
 * 权限沿用 inventory 现有动作（不新造 scope）：
 * - 提交 `inventory_qty.update`（改成本属于批次更新）；
 * - 查询 `inventory_qty.read`；审批/驳回 `inventory_qty.approve`。
 * 审计：提交 / 审批 / 驳回记 write（D51）；查询不记（D54 ②）。
 * AI：全部禁止；审批/驳回还要求原因（D52①）。
 * 并发：审批 / 驳回强制 If-Match 强 ETag。
 *
 * T3 不落库：提交时若判定为已结算，直接返回 `VALIDATION_FAILED`（422），
 * `details.reason='COST_ADJUSTMENT_LOCKED'`，`details.returnEntry` 给一键退货入口。
 */
export const COST_ADJUSTMENT_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'inventory',
    operationId: 'inventory.cost.adjustment.create',
    method: 'POST',
    path: '/api/v1/inventory/batches/{batchId}/cost-adjustments',
    domain: 'inventory_qty',
    action: 'update',
    summary:
      '提交批次成本更正（服务端自动判 T1/T2/T3；只改成本不改数量，T1 直接生效、T2 待审批、T3 拒绝）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: CostAdjustmentCreateInputSchema },
    response: { status: 201, schema: InventoryCostAdjustmentSchema },
  }),
  defineRoute({
    module: 'inventory',
    operationId: 'inventory.cost.adjustment.history.read',
    method: 'GET',
    path: '/api/v1/inventory/batches/{batchId}/cost-adjustments',
    domain: 'inventory_qty',
    action: 'read',
    summary: '批次成本更正历史（含档位/状态/差额/审批人；无看价权限时金额置空）',
    audit: { kind: 'none' },
    request: { query: CostAdjustmentListQuerySchema },
    response: { status: 200, schema: pageSchema(InventoryCostAdjustmentSchema) },
  }),
  defineRoute({
    module: 'inventory',
    operationId: 'inventory.cost.adjustment.approve',
    method: 'POST',
    path: '/api/v1/inventory/cost-adjustments/{id}/approve',
    domain: 'inventory_qty',
    action: 'approve',
    summary:
      '审批通过 T2 成本更正（审批时复查下游引用；已结算则拒绝；AI 禁止审批且必须给原因）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    response: { status: 200, schema: InventoryCostAdjustmentSchema },
  }),
  defineRoute({
    module: 'inventory',
    operationId: 'inventory.cost.adjustment.reject',
    method: 'POST',
    path: '/api/v1/inventory/cost-adjustments/{id}/reject',
    domain: 'inventory_qty',
    action: 'approve',
    summary: '驳回 T2 成本更正（必须写明原因；AI 禁止审批且必须给原因）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    request: { body: CostAdjustmentRejectInputSchema },
    response: { status: 200, schema: InventoryCostAdjustmentSchema },
  }),
];
