import {
  AppError,
  encodeCursor,
  type CursorPayload,
  type InventoryBatch,
  type InventoryBatchDetail,
  type InventoryFlow,
} from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';

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
  readonly limit: number;
}

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
  b.version,
  b.created_at,
  b.updated_at`;

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

/** 批次列表：按公司 / 商品 / 批次号或商品名检索，id 倒序游标分页。 */
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
  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`b.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);
  const result = await ctx.tx.query<InventoryBatchRow>(
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

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const items = pageRows.map(mapBatch);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

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
