import {
  AppError,
  encodeCursor,
  type CursorPayload,
  type Stocktake,
  type StocktakeCreateInput,
  type StocktakeStatus,
} from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 盘点调整 I 数据访问层（D15 / D16 / D47 / D54 / D67）。
 *
 * - 所有查询都带 tenant_id + company_id = ANY(可见公司集合)；
 * - 数量保持 decimal 字符串，读出时由 SQL trim_scale 规范化；
 * - 差异量由 INSERT 语句按 actual_qty - book_qty 计算，应用侧不传；
 * - 审批使用 version + status 条件原子更新；本层不做任何物理删除（D47）。
 */

export interface StocktakeRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface StocktakeListQuery {
  readonly companyId?: string;
  readonly status?: StocktakeStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 创建输入 = 契约创建体 + 用例生成的 uuid / 单号 / 发起人。 */
export type StocktakeInsertInput = StocktakeCreateInput & {
  readonly id: string;
  readonly stocktakeNo: string;
  readonly applicantId: string;
};

export interface StocktakePage {
  readonly items: Stocktake[];
  readonly nextCursor: string | null;
}

export interface StocktakeState {
  readonly id: string;
  readonly companyId: string;
  readonly batchId: string;
  readonly status: StocktakeStatus;
  readonly diffQty: string;
  readonly version: number;
}

interface StocktakeRow {
  id: string;
  tenant_id: string;
  company_id: string;
  stocktake_no: string;
  batch_id: string;
  book_qty: string | number;
  actual_qty: string | number;
  diff_qty: string | number;
  status: string;
  applicant_id: string;
  approver_id: string | null;
  remark: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StocktakeStateRow {
  id: string;
  company_id: string;
  batch_id: string;
  status: string;
  diff_qty: string | number;
  version: number;
}

const STOCKTAKE_COLUMNS = `s.id,
  s.tenant_id,
  s.company_id,
  s.stocktake_no,
  s.batch_id,
  trim_scale(s.book_qty) AS book_qty,
  trim_scale(s.actual_qty) AS actual_qty,
  trim_scale(s.diff_qty) AS diff_qty,
  s.status,
  s.applicant_id,
  s.approver_id,
  s.remark,
  s.version,
  s.created_at,
  s.updated_at`;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function decimal(value: string | number): string {
  return String(value);
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function mapStocktake(row: StocktakeRow): Stocktake {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    stocktakeNo: row.stocktake_no,
    batchId: row.batch_id,
    bookQty: decimal(row.book_qty),
    actualQty: decimal(row.actual_qty),
    diffQty: decimal(row.diff_qty),
    status: row.status as StocktakeStatus,
    applicantId: row.applicant_id,
    approverId: row.approver_id,
    remark: row.remark,
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

/** 盘点单列表：租户 + 可见公司内过滤，按 UUIDv7 id 倒序分页。 */
export async function listStocktakes(
  ctx: StocktakeRepoContext,
  query: StocktakeListQuery,
): Promise<StocktakePage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = [
    's.tenant_id = $1',
    's.company_id = ANY($2::uuid[])',
  ];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`s.company_id = $${params.length}::uuid`);
  }
  if (query.status !== undefined) {
    params.push(query.status);
    where.push(`s.status = $${params.length}`);
  }
  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    where.push(`s.stocktake_no ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`s.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);
  const result = await ctx.tx.query<StocktakeRow>(
    `SELECT ${STOCKTAKE_COLUMNS}
       FROM inventory_stocktake s
      WHERE ${where.join('\n        AND ')}
      ORDER BY s.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const items = pageRows.map(mapStocktake);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

/** 盘点单详情：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getStocktake(
  ctx: StocktakeRepoContext,
  id: string,
): Promise<Stocktake | null> {
  const result = await ctx.tx.query<StocktakeRow>(
    `SELECT ${STOCKTAKE_COLUMNS}
       FROM inventory_stocktake s
      WHERE s.id = $1::uuid
        AND s.tenant_id = $2
        AND s.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  return row ? mapStocktake(row) : null;
}

/** 审批前读取状态；跨公司等同不存在。 */
export async function loadStocktakeState(
  ctx: StocktakeRepoContext,
  id: string,
): Promise<StocktakeState | null> {
  const result = await ctx.tx.query<StocktakeStateRow>(
    `SELECT s.id,
            s.company_id,
            s.batch_id,
            s.status,
            trim_scale(s.diff_qty) AS diff_qty,
            s.version
       FROM inventory_stocktake s
      WHERE s.id = $1::uuid
        AND s.tenant_id = $2
        AND s.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    batchId: row.batch_id,
    status: row.status as StocktakeStatus,
    diffQty: decimal(row.diff_qty),
    version: row.version,
  };
}

/** 盘点批次必须与盘点单同租户、同公司（D15 / D22 同款收口）。 */
export async function assertBatchInCompany(
  ctx: StocktakeRepoContext,
  batchId: string,
  companyId: string,
): Promise<void> {
  const result = await ctx.tx.query(
    `SELECT 1
       FROM inventory_batch
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid`,
    [batchId, ctx.tenantId, companyId],
  );
  if (result.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', '批次不存在或不属于盘点单的公司', {
      batchId,
      companyId,
    });
  }
}

/**
 * 新增盘点单：`id` / `stocktakeNo` / `applicantId` 由用例生成。
 * 差异量由 SQL 按 actual_qty - book_qty 计算（契约不接收 diffQty）。
 */
export async function insertStocktake(
  ctx: StocktakeRepoContext,
  input: StocktakeInsertInput,
): Promise<Stocktake> {
  await ctx.tx.query(
    `INSERT INTO inventory_stocktake
       (id, tenant_id, company_id, stocktake_no, batch_id,
        book_qty, actual_qty, diff_qty, status, applicant_id, remark, version)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid,
             $6::amount, $7::amount, ($7::amount - $6::amount),
             '待审批', $8::uuid, $9, 1)`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.stocktakeNo,
      input.batchId,
      input.bookQty,
      input.actualQty,
      input.applicantId,
      input.remark ?? null,
    ],
  );

  const created = await getStocktake(ctx, input.id);
  if (!created) {
    throw new AppError('INTERNAL_ERROR', '盘点单创建后读取失败', {
      id: input.id,
    });
  }
  return created;
}

/**
 * 审批通过：待审批 -> 已批准，一次且仅一次。
 *
 * 版本或状态已被并发修改时返回 null，由用例映射冲突；本层不物理删除。
 * 批次数量调整必须由用例在同一事务内经 `services/stock-flow.ts` 完成（D67）。
 */
export async function approveStocktake(
  ctx: StocktakeRepoContext,
  id: string,
  expectedVersion: number,
  approverId: string,
): Promise<boolean> {
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE inventory_stocktake
        SET status = '已批准',
            approver_id = $4::uuid,
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $5
        AND status = '待审批'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], approverId, expectedVersion],
  );
  return result.rows.length > 0;
}
