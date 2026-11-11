import {
  AppError,
  encodeCursor,
  type CostAdjustmentStatus,
  type CostAdjustmentTier,
  type CursorPayload,
  type InventoryCostAdjustment,
} from '@qingdan/contracts';
import type { InventoryRepoContext } from './repo.js';

/**
 * 成本更正数据访问层（Issue #163 / #100）。
 *
 * - 只改成本、不改数量：本文件**不写** `inventory_flow`（D2① / D67④）；
 * - 所有查询同时受 tenant RLS 与调用者可见公司集合约束（D15）；
 * - 金额保持 decimal 字符串（D54），读出时 `trim_scale` 归一；
 * - 审批用条件 UPDATE（version + status='pending_approval'）做乐观锁，
 *   失败由调用方转 VERSION_CONFLICT（D60③ 同款）。
 */

export interface CostAdjustmentBatchState {
  readonly batchId: string;
  readonly companyId: string;
  /** 批次当前锁定单价：可能为空（未锁定成本的批次不允许更正）。 */
  readonly lockedUnitCost: string | null;
  readonly inboundQty: string;
  readonly version: number;
}

export interface CostAdjustmentListQuery {
  readonly batchId: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

export interface CostAdjustmentPage {
  readonly items: InventoryCostAdjustment[];
  readonly nextCursor: string | null;
}

export interface InsertCostAdjustmentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly batchId: string;
  readonly tier: CostAdjustmentTier;
  readonly beforeUnitCost: string;
  readonly afterUnitCost: string;
  readonly reason: string;
  readonly status: Extract<CostAdjustmentStatus, 'applied' | 'pending_approval'>;
  readonly requestedBy: string;
  readonly referenceSnapshot: unknown;
  readonly requestId: string | null;
  /** 仅 T1 直接生效时落值；T2 待审批为 null。 */
  readonly appliedAt: Date | null;
}

export interface CostAdjustmentState {
  readonly id: string;
  readonly companyId: string;
  readonly batchId: string;
  readonly status: CostAdjustmentStatus;
  readonly version: number;
}

const COST_ADJUSTMENT_COLUMNS = `
  a.id,
  a.tenant_id,
  a.company_id,
  a.batch_id,
  a.tier,
  trim_scale(a.before_unit_cost) AS before_unit_cost,
  trim_scale(a.after_unit_cost) AS after_unit_cost,
  trim_scale(a.delta_amount) AS delta_amount,
  a.reason,
  a.status,
  a.requested_by,
  a.approved_by,
  a.reference_snapshot,
  a.request_id,
  a.version,
  a.created_at,
  a.applied_at
`;

interface CostAdjustmentRow {
  id: string;
  tenant_id: string;
  company_id: string;
  batch_id: string;
  tier: string;
  before_unit_cost: string;
  after_unit_cost: string;
  delta_amount: string;
  reason: string;
  status: string;
  requested_by: string;
  approved_by: string | null;
  reference_snapshot: unknown;
  request_id: string | null;
  version: number;
  created_at: Date | string;
  applied_at: Date | string | null;
}

function decimal(value: unknown): string {
  return String(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapCostAdjustment(row: CostAdjustmentRow): InventoryCostAdjustment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    batchId: row.batch_id,
    tier: row.tier as CostAdjustmentTier,
    beforeUnitCost: decimal(row.before_unit_cost),
    afterUnitCost: decimal(row.after_unit_cost),
    deltaAmount: decimal(row.delta_amount),
    reason: row.reason,
    status: row.status as CostAdjustmentStatus,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    referenceSnapshot: row.reference_snapshot as InventoryCostAdjustment['referenceSnapshot'],
    requestId: row.request_id,
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    appliedAt: row.applied_at === null ? null : toDate(row.applied_at).toISOString(),
  };
}

/**
 * 读取批次当前成本状态并加行锁（`FOR UPDATE`）。
 *
 * 加锁是为了把「判定档位 → 算差额 → 改批次成本」串行化：
 * 两个 T1 并发提交时，后一个必须看到前一个已生效的新成本，否则差额会算错。
 */
export async function loadBatchForCostAdjustment(
  ctx: InventoryRepoContext,
  batchId: string,
): Promise<CostAdjustmentBatchState | null> {
  const result = await ctx.tx.query<{
    id: string;
    company_id: string;
    locked_unit_cost: string | null;
    inbound_qty: string;
    version: number;
  }>(
    `SELECT
       b.id,
       b.company_id,
       CASE WHEN b.locked_unit_cost IS NULL THEN NULL ELSE trim_scale(b.locked_unit_cost) END
         AS locked_unit_cost,
       trim_scale(b.inbound_qty) AS inbound_qty,
       b.version
     FROM inventory_batch b
     WHERE b.id = $1::uuid
       AND b.tenant_id = $2
       AND b.company_id = ANY($3::uuid[])
     FOR UPDATE`,
    [batchId, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    batchId: row.id,
    companyId: row.company_id,
    lockedUnitCost: row.locked_unit_cost === null ? null : decimal(row.locked_unit_cost),
    inboundQty: decimal(row.inbound_qty),
    version: row.version,
  };
}

/** 插入一条成本更正；差额在 SQL 里按批次 inbound_qty 现算，避免应用侧浮点误差。 */
export async function insertCostAdjustment(
  ctx: InventoryRepoContext,
  input: InsertCostAdjustmentInput,
): Promise<InventoryCostAdjustment> {
  const result = await ctx.tx.query<CostAdjustmentRow>(
    `INSERT INTO inventory_cost_adjustment AS a (
       id, tenant_id, company_id, batch_id, tier,
       before_unit_cost, after_unit_cost, delta_amount,
       reason, status, requested_by, approved_by,
       reference_snapshot, request_id, applied_at, version, created_at
     )
     SELECT
       $1::uuid, $2, $3::uuid, $4::uuid, $5::text,
       $6::amount, $7::amount,
       ($7::amount - $6::amount) * b.inbound_qty,
       $8::text, $9::text, $10::uuid, NULL,
       $11::jsonb, $12::text, $13::timestamptz, 1, now()
     FROM inventory_batch b
     WHERE b.id = $4::uuid
       AND b.tenant_id = $2
       AND b.company_id = $3::uuid
     RETURNING ${COST_ADJUSTMENT_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.companyId,
      input.batchId,
      input.tier,
      input.beforeUnitCost,
      input.afterUnitCost,
      input.reason,
      input.status,
      input.requestedBy,
      JSON.stringify(input.referenceSnapshot),
      input.requestId,
      input.appliedAt,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('INTERNAL_ERROR', '成本更正写入后读不到（批次已不在可见公司内）', {
      batchId: input.batchId,
    });
  }
  return mapCostAdjustment(row);
}

/** 按批次列历史：id 倒序（uuidv7 单调递增，等价于创建时间倒序）。 */
export async function listCostAdjustments(
  ctx: InventoryRepoContext,
  query: CostAdjustmentListQuery,
): Promise<CostAdjustmentPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds], query.batchId];
  const where: string[] = [
    'a.tenant_id = $1',
    'a.company_id = ANY($2::uuid[])',
    'a.batch_id = $3::uuid',
  ];
  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`a.id < $${params.length}::uuid`);
  }
  params.push(query.limit + 1);
  const result = await ctx.tx.query<CostAdjustmentRow>(
    `SELECT ${COST_ADJUSTMENT_COLUMNS}
       FROM inventory_cost_adjustment a
      WHERE ${where.join('\n        AND ')}
      ORDER BY a.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const items = pageRows.map(mapCostAdjustment);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/** 读取单条成本更正（跨公司等同不存在）。 */
export async function getCostAdjustment(
  ctx: InventoryRepoContext,
  id: string,
): Promise<InventoryCostAdjustment | null> {
  const result = await ctx.tx.query<CostAdjustmentRow>(
    `SELECT ${COST_ADJUSTMENT_COLUMNS}
       FROM inventory_cost_adjustment a
      WHERE a.id = $1::uuid
        AND a.tenant_id = $2
        AND a.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  return row ? mapCostAdjustment(row) : null;
}

/** 审批前读取状态：只取审批需要的字段。 */
export async function loadCostAdjustmentState(
  ctx: InventoryRepoContext,
  id: string,
): Promise<CostAdjustmentState | null> {
  const result = await ctx.tx.query<{
    id: string;
    company_id: string;
    batch_id: string;
    status: string;
    version: number;
  }>(
    `SELECT a.id, a.company_id, a.batch_id, a.status, a.version
       FROM inventory_cost_adjustment a
      WHERE a.id = $1::uuid
        AND a.tenant_id = $2
        AND a.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    batchId: row.batch_id,
    status: row.status as CostAdjustmentStatus,
    version: row.version,
  };
}

/**
 * 条件更新审批结果（乐观锁 + 状态闸门）。
 * 返回是否命中；未命中由调用方按当前状态区分 404 / 409。
 */
export async function updateCostAdjustmentDecision(
  ctx: InventoryRepoContext,
  input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly status: Extract<CostAdjustmentStatus, 'applied' | 'rejected'>;
    readonly approvedBy: string;
  },
): Promise<boolean> {
  const result = await ctx.tx.query(
    `UPDATE inventory_cost_adjustment
        SET status = $4::text,
            approved_by = $5::uuid,
            applied_at = CASE WHEN $4::text = 'applied' THEN now() ELSE applied_at END,
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $6
        AND status = 'pending_approval'
      RETURNING id`,
    [input.id, ctx.tenantId, [...ctx.companyIds], input.status, input.approvedBy, input.expectedVersion],
  );
  return result.rows.length > 0;
}

/**
 * 把批次锁定单价改成新成本；**不动任何数量列**（Issue #163 铁律）。
 * 版本号 +1，供后续批次读接口的 ETag 使用。
 */
export async function updateBatchLockedUnitCost(
  ctx: InventoryRepoContext,
  input: {
    readonly batchId: string;
    readonly companyId: string;
    readonly unitCost: string;
  },
): Promise<boolean> {
  const result = await ctx.tx.query(
    `UPDATE inventory_batch
        SET locked_unit_cost = $4::amount,
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid
      RETURNING id`,
    [input.batchId, ctx.tenantId, input.companyId, input.unitCost],
  );
  return result.rows.length > 0;
}
