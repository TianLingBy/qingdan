import {
  AppError,
  encodeCursor,
  resolvePaging,
  type CursorPayload,
  type InventoryAlertItem,
  type InventoryBatch,
  type InventoryBatchDetail,
  type InventoryFlow,
  type SortOrder,
} from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';
import { buildOrderBy } from '../../platform/db/order-by.js';

/**
 * 库存只读数据访问层（D15 / D38 / D41 / D67）。
 *
 * - 所有查询同时受 tenant RLS 与调用者可见公司集合约束；
 * - remaining / available 由数据库生成列计算，本层只读，不在应用侧重算；
 * - 库存流水只读，按 occurred_at + id 做稳定 keyset 分页；
 * - 数量和金额一律保持 decimal 字符串（D54），不转 number。
 */

export interface InventoryRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  readonly companyIds: readonly string[];
}

export interface InventoryBatchListQuery {
  readonly companyId?: string;
  readonly productId?: string;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  /** 省略表示调用方没传 limit——由 resolvePaging 决定是游标默认 50 还是页码默认 20。 */
  readonly limit?: number;
  /** 页码模式（D95）：与 cursor 互斥，同时给由 resolvePaging 抛 422。 */
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: InventoryBatchSortKey;
  readonly order?: SortOrder;
}

/** 排序白名单（与契约 `InventoryBatchListQuerySchema.sort` 一一对应，列名核对自 0008 建表语句）。 */
export type InventoryBatchSortKey = 'batchNo' | 'availableQty' | 'createdAt';

export interface InventoryFlowListQuery {
  readonly companyId?: string;
  readonly batchId?: string;
  readonly sourceDocType?: string;
  readonly sourceDocId?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

export interface InventoryBatchPage {
  readonly items: InventoryBatch[];
  /** 页码模式下的总条数；游标模式恒为 null（老调用方不读这几个字段）。 */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number | null;
  readonly nextCursor: string | null;
}

export interface InventoryFlowPage {
  readonly items: InventoryFlow[];
  readonly nextCursor: string | null;
}

interface InventoryBatchRow {
  id: string;
  tenant_id: string;
  company_id: string;
  product_id: string;
  product_name: string;
  product_no: string | null;
  batch_no: string;
  locked_unit_cost: string | number | null;
  inbound_qty: string | number;
  referenced_qty: string | number;
  remaining_qty: string | number;
  in_transit_qty: string | number;
  pending_execution_qty: string | number;
  available_qty: string | number;
  custodian_id: string | null;
  held_by_processor_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface InventoryFlowRow {
  id: string;
  tenant_id: string;
  company_id: string;
  batch_id: string;
  delta: string | number;
  source_doc_type: string;
  source_doc_id: string;
  handled_by: string;
  occurred_at: Date | string;
}

const BATCH_COLUMNS = `b.id,
  b.tenant_id,
  b.company_id,
  b.product_id,
  p.name AS product_name,
  p.product_no,
  b.batch_no,
  b.locked_unit_cost,
  b.inbound_qty,
  b.referenced_qty,
  b.remaining_qty,
  b.in_transit_qty,
  b.pending_execution_qty,
  b.available_qty,
  b.custodian_id,
  b.held_by_processor_id,
  b.version,
  b.created_at,
  b.updated_at`;

/** 批次列表的 FROM/JOIN 片段：分页子查询与 COUNT 子查询共用，避免两处漂移。 */
const BATCH_FROM = `inventory_batch b
       JOIN product p
         ON p.id = b.product_id
        AND p.tenant_id = b.tenant_id
        AND p.company_id = b.company_id`;

const FLOW_COLUMNS = `f.id,
  f.tenant_id,
  f.company_id,
  f.batch_id,
  f.delta,
  f.source_doc_type,
  f.source_doc_id,
  f.handled_by,
  f.occurred_at`;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function requiredDecimal(
  value: string | number | null,
  field: string,
  batchId: string,
): string {
  if (value === null) {
    throw new AppError('INTERNAL_ERROR', `库存批次缺少必要字段：${field}`, { batchId, field });
  }
  return String(value);
}

function decimal(value: string | number): string {
  return String(value);
}

function mapBatch(row: InventoryBatchRow): InventoryBatch {
  if (row.custodian_id === null) {
    throw new AppError('INTERNAL_ERROR', '库存批次缺少保管人', {
      batchId: row.id,
      field: 'custodianId',
    });
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    productId: row.product_id,
    batchNo: row.batch_no,
    lockedUnitCost: requiredDecimal(row.locked_unit_cost, 'lockedUnitCost', row.id),
    inboundQty: decimal(row.inbound_qty),
    referencedQty: decimal(row.referenced_qty),
    remainingQty: decimal(row.remaining_qty),
    inTransitQty: decimal(row.in_transit_qty),
    pendingExecutionQty: decimal(row.pending_execution_qty),
    availableQty: decimal(row.available_qty),
    custodianId: row.custodian_id,
    heldByProcessorId: row.held_by_processor_id,
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

function mapDetail(row: InventoryBatchRow): InventoryBatchDetail {
  return {
    ...mapBatch(row),
    productName: row.product_name,
    productNo: row.product_no,
    // D67⑤：一期不建占用明细表；来源单据表尚未落地，当前返回空数组。
    pendingOccupancies: [],
  };
}

function mapFlow(row: InventoryFlowRow): InventoryFlow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    batchId: row.batch_id,
    delta: decimal(row.delta),
    sourceDocType: row.source_doc_type,
    sourceDocId: row.source_doc_id,
    handledBy: row.handled_by,
    occurredAt: toDate(row.occurred_at).toISOString(),
  };
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * 批次列表：按公司 / 商品 / 批次号或商品名检索。
 * 游标模式（cursor / 仅 limit）按 id 倒序翻页，行为与 D95 之前完全一致；
 * 页码模式（page / pageSize）走 OFFSET，并额外带 total。
 */
export async function listInventoryBatches(
  ctx: InventoryRepoContext,
  query: InventoryBatchListQuery,
): Promise<InventoryBatchPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['b.tenant_id = $1', 'b.company_id = ANY($2::uuid[])'];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`b.company_id = $${params.length}::uuid`);
  }
  if (query.productId !== undefined) {
    params.push(query.productId);
    where.push(`b.product_id = $${params.length}::uuid`);
  }
  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    const keywordParam = `$${params.length}`;
    where.push(`(
      b.batch_no ILIKE ${keywordParam} ESCAPE '\\'
      OR p.name ILIKE ${keywordParam} ESCAPE '\\'
    )`);
  }
  const paging = resolvePaging({
    // resolvePaging 只看「有没有 cursor」这一个事实，解码后的 id 就够当凭据。
    cursor: query.cursor === undefined ? undefined : query.cursor.id,
    limit: query.limit,
    page: query.page,
    pageSize: query.pageSize,
  });
  if (paging.mode === 'cursor' && query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`b.id < $${params.length}::uuid`);
  }

  const orderBy = buildOrderBy(COLUMN_MAP, query.sort, query.order, 'b.id', 'id');
  const whereSql = where.join('\n        AND ');
  const selectSql = `SELECT ${BATCH_COLUMNS}
       FROM ${BATCH_FROM}
      WHERE ${whereSql}`;

  if (paging.mode === 'offset') {
    params.push(paging.limit, paging.offset);
    const result = await ctx.tx.query<InventoryBatchRow>(
      `${selectSql}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    // total 单独一条 COUNT：**故意不与 items 同一快照**。
    // 取舍理由：列表页每次翻页/筛选都走这条路，而 `COUNT(*) OVER()` 要求窗口函数先消费
    // 全部匹配行，计划会退化成「Seq Scan + Sort」，新加的排序索引一次也用不上
    // （EXPLAIN 实测：2 万行 21ms vs 走索引 0.047ms；18 万行 229ms 且溢出 temp read=2486）。
    // READ COMMITTED 下两次语句之间若有并发写入，总数可能与当页条数差一两条——
    // 这不会让人做错任何决定；真正需要严格一致的是财务对账，那走结算模块，不是列表页码。
    // 另外：超过最后一页时分页那条返回 0 行，这条 COUNT 照样给出真实总数，
    // 所以「page 超出范围」不再需要额外的补查分支。
    // 曾评估：分页子查询 LEFT JOIN COUNT（同快照，实测 11.089ms vs 本写法 15.2ms），
    // 因参数位置需在子查询内复用、嵌套加深、筛选项增减时易错位而放弃（详见销售单 repo 同段注释）。
    const countResult = await ctx.tx.query<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM ${BATCH_FROM}
        WHERE ${whereSql}`,
      params.slice(0, -2),
    );
    return {
      items: result.rows.map(mapBatch),
      total: Number(countResult.rows[0]!.n),
      page: paging.page,
      pageSize: paging.limit,
      nextCursor: null,
    };
  }

  params.push(paging.limit + 1);
  const result = await ctx.tx.query<InventoryBatchRow>(
    `${selectSql}
      ORDER BY ${orderBy}
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > paging.limit;
  const pageRows = hasMore ? result.rows.slice(0, paging.limit) : result.rows;
  const items = pageRows.map(mapBatch);
  const last = items[items.length - 1];
  return {
    items,
    total: null,
    page: null,
    pageSize: null,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

/** 排序白名单：键 → 真实列。`id` 只为保住改动前的默认序（原 ORDER BY b.id DESC）。 */
const COLUMN_MAP = {
  id: 'b.id',
  batchNo: 'b.batch_no',
  availableQty: 'b.available_qty',
  createdAt: 'b.created_at',
} as const satisfies Record<string, string>;

/** 批次详情：跨公司等同不存在；商品展示字段来自同公司同租户的商品行。 */
export async function getInventoryBatch(
  ctx: InventoryRepoContext,
  id: string,
): Promise<InventoryBatchDetail | null> {
  const result = await ctx.tx.query<InventoryBatchRow>(
    `SELECT ${BATCH_COLUMNS}
       FROM inventory_batch b
       JOIN product p
         ON p.id = b.product_id
        AND p.tenant_id = b.tenant_id
        AND p.company_id = b.company_id
      WHERE b.id = $1::uuid
        AND b.tenant_id = $2
        AND b.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  return row ? mapDetail(row) : null;
}

/** 流水列表：按公司 / 批次 / 来源单据过滤，occurred_at + id 倒序游标分页。 */
export async function listInventoryFlows(
  ctx: InventoryRepoContext,
  query: InventoryFlowListQuery,
): Promise<InventoryFlowPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['f.tenant_id = $1', 'f.company_id = ANY($2::uuid[])'];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`f.company_id = $${params.length}::uuid`);
  }
  if (query.batchId !== undefined) {
    // 契约把 batchId 定义为普通字符串；用 text 比较避免非法 uuid 直接打成 500。
    params.push(query.batchId);
    where.push(`f.batch_id::text = $${params.length}`);
  }
  if (query.sourceDocType !== undefined) {
    params.push(query.sourceDocType);
    where.push(`f.source_doc_type = $${params.length}`);
  }
  if (query.sourceDocId !== undefined) {
    params.push(query.sourceDocId);
    where.push(`f.source_doc_id::text = $${params.length}`);
  }
  if (query.cursor !== undefined) {
    params.push(query.cursor.createdAt, query.cursor.id);
    where.push(
      `(f.occurred_at, f.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  params.push(query.limit + 1);
  const result = await ctx.tx.query<InventoryFlowRow>(
    `SELECT ${FLOW_COLUMNS}
       FROM inventory_flow f
      WHERE ${where.join('\n        AND ')}
      ORDER BY f.occurred_at DESC, f.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const items = pageRows.map(mapFlow);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.occurredAt, id: last.id })
        : null,
  };
}

/**
 * 导出用查询（#342）：库存批次列表 CSV 的数据源。
 *
 * **与 `listInventoryBatches` 的过滤条件必须保持一致，改一处要改两处。**
 * 这是刻意的重复：并行任务 #341 正在改 `listInventoryBatches`，共用同一段 where 拼装
 * 会让两个改动互相阻塞。
 *
 * 与列表函数不同，这里直接返回「带商品编号 / 商品名」的扁平行：
 * `mapBatch` 会丢掉 `product_name` / `product_no`，而导出的 CSV 必须带上这两个列，
 * 否则用户拿到一堆 UUID 没法对账。
 */
export interface InventoryBatchExportQuery {
  readonly companyId?: string;
  readonly productId?: string;
  readonly keyword?: string;
  /** 行数上限：内部统一按 `maxRows + 1` 取，多出一行即判定超限（不静默截断）。 */
  readonly maxRows: number;
}

export interface InventoryBatchExportRow {
  readonly batchNo: string;
  readonly productNo: string;
  readonly productName: string;
  readonly lockedUnitCost: string;
  readonly inboundQty: string;
  readonly remainingQty: string;
  readonly availableQty: string;
  readonly inTransitQty: string;
  readonly pendingExecutionQty: string;
  readonly custodianId: string;
  readonly createdAt: string;
}

export interface InventoryBatchExportResult {
  readonly rows: readonly InventoryBatchExportRow[];
  readonly exceedsMaxRows: boolean;
}

interface BatchExportRow {
  batch_no: string;
  product_no: string;
  product_name: string;
  locked_unit_cost: string | number;
  inbound_qty: string | number;
  remaining_qty: string | number;
  available_qty: string | number;
  in_transit_qty: string | number;
  pending_execution_qty: string | number;
  custodian_id: string;
  created_at: Date | string;
}

/** 低库存预警的判定窗口与口径（#354 / D104，写进 decisions.md，改这里要同改文档）。 */
export const ALERT_WINDOW_DAYS = 30;

export const ALERT_COVER_DAYS = 7;

/** 一次最多回多少条：预警是「今天该补哪几批货」，不是报表（不分页，D104）。 */
export const ALERT_LIMIT = 200;

export interface InventoryAlertQuery {
  readonly companyId: string;
  /** 已由用例层兜底成 0.2；这里不做缺省判断。 */
  readonly thresholdRatio: number;
}

interface InventoryAlertRow {
  batch_id: string;
  product_id: string;
  product_name: string;
  batch_no: string;
  available_qty: string | number;
  avg_daily_out: string | number;
  days_left: string | number;
}

/**
 * 低库存预警（#354 第 2 条 / D104）：一条 SQL 出全表，不 N+1。
 *
 * 口径（三个数字见 D104）：
 * - `avgDailyOut` = 最近 30 天该批次的出库量合计 ÷ 30，**只算负数流水**（`delta < 0`
 *   是出库；正数是入库 / 冲正，混进去会把日均算大、把预警算没）。
 * - 判定式 `availableQty < avgDailyOut × 7 × (1 + thresholdRatio)`：
 *   `thresholdRatio` 是**叠加在 7 天窗口上的提前量倍数**（缺省 0.2 ≈ 8.4 天就开始提醒），
 *   不是替代 7 天窗口（#354 给了两个读法，这里选了这一个，理由见 D104）。
 * - `daysLeft` = `floor(availableQty / avgDailyOut)`，**不加 `GREATEST(0, …)`**：
 *   断货就是 0 天，负数要原样透给前端（`available_qty` 目前有 `>= 0` 的 DB 约束，
 *   所以今天最多到 0；约束一旦放宽，负数自然出现，表达式不用改）。
 * - **没有历史出库的批次不进预警**：新进的货还没开始卖，`avgDailyOut = 0` 会让
 *   `daysLeft` 变成 +∞，报出来只是噪音。`outbound` 里 `delta < 0` 先筛过一遍，
 *   `avg` 再取 `out_qty > 0`，join 时就天然排除了零出库批次。
 */
export async function listInventoryAlerts(
  ctx: InventoryRepoContext,
  query: InventoryAlertQuery,
): Promise<InventoryAlertItem[]> {
  const result = await ctx.tx.query<InventoryAlertRow>(
    `WITH outbound AS (
       SELECT f.batch_id,
              SUM(-f.delta) AS out_qty
         FROM inventory_flow f
        WHERE f.tenant_id = $1
          AND f.company_id = $2::uuid
          AND f.delta < 0
          AND f.occurred_at >= now() - interval '${ALERT_WINDOW_DAYS} days'
        GROUP BY f.batch_id
     ),
     avg AS (
       SELECT o.batch_id,
              round(o.out_qty / ${ALERT_WINDOW_DAYS}, 6) AS avg_daily_out
         FROM outbound o
        WHERE o.out_qty > 0
     )
     SELECT b.id AS batch_id,
            b.product_id,
            p.name AS product_name,
            b.batch_no,
            b.available_qty,
            a.avg_daily_out,
            floor(b.available_qty / a.avg_daily_out) AS days_left
       FROM inventory_batch b
       JOIN avg a
         ON a.batch_id = b.id
       JOIN product p
         ON p.id = b.product_id
        AND p.tenant_id = b.tenant_id
        AND p.company_id = b.company_id
      WHERE b.tenant_id = $1
        AND b.company_id = $2::uuid
        AND b.available_qty < a.avg_daily_out * ${ALERT_COVER_DAYS} * (1 + $3::numeric)
      ORDER BY days_left ASC, b.id
      LIMIT $4`,
    [ctx.tenantId, query.companyId, query.thresholdRatio, ALERT_LIMIT],
  );

  return result.rows.map((row) => ({
    batchId: row.batch_id,
    productId: row.product_id,
    productName: row.product_name,
    batchNo: row.batch_no,
    availableQty: decimal(row.available_qty),
    avgDailyOut: decimal(row.avg_daily_out),
    daysLeft: Number(row.days_left),
  }));
}

export async function exportInventoryBatches(
  ctx: InventoryRepoContext,
  query: InventoryBatchExportQuery,
): Promise<InventoryBatchExportResult> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['b.tenant_id = $1', 'b.company_id = ANY($2::uuid[])'];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`b.company_id = $${params.length}::uuid`);
  }
  if (query.productId !== undefined) {
    params.push(query.productId);
    where.push(`b.product_id = $${params.length}::uuid`);
  }
  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    const keywordParam = `$${params.length}`;
    where.push(`(
      b.batch_no ILIKE ${keywordParam} ESCAPE '\\'
      OR p.name ILIKE ${keywordParam} ESCAPE '\\'
    )`);
  }

  params.push(query.maxRows + 1);
  const result = await ctx.tx.query<BatchExportRow>(
    `SELECT ${BATCH_COLUMNS}
       FROM inventory_batch b
       JOIN product p
         ON p.id = b.product_id
        AND p.tenant_id = b.tenant_id
        AND p.company_id = b.company_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY b.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const exceedsMaxRows = result.rows.length > query.maxRows;
  const kept = exceedsMaxRows ? result.rows.slice(0, query.maxRows) : result.rows;
  return {
    rows: kept.map((row) => ({
      batchNo: row.batch_no,
      productNo: row.product_no,
      productName: row.product_name,
      lockedUnitCost: decimal(row.locked_unit_cost),
      inboundQty: decimal(row.inbound_qty),
      remainingQty: decimal(row.remaining_qty),
      availableQty: decimal(row.available_qty),
      inTransitQty: decimal(row.in_transit_qty),
      pendingExecutionQty: decimal(row.pending_execution_qty),
      custodianId: row.custodian_id,
      createdAt: toDate(row.created_at).toISOString(),
    })),
    exceedsMaxRows,
  };
}
