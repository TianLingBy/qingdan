import {
  encodeCursor,
  type CursorPayload,
  type SettlementOrder,
  type SettlementOrderStatus,
  type SettlementSourceDocType,
} from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * C 结算单数据访问层（D15 / D19 / D26 / D69）。
 *
 * - 所有查询都带 tenant_id + company_id = ANY(可见公司集合)；
 * - 金额保持 decimal 字符串，单头字段由 SQL trim_scale 规范化；
 * - 已结算单读取 related_loss_amount_snapshot，确保 D69 快照冻结；
 * - confirm 使用 version + status 条件原子更新，保证一期一单一次结算。
 *
 * TODO(D19)：E / N 完成态自动生成草稿需要跨模块公开用例通道；本 repo 不直读
 * E / N 表，也不在 settlement 模块内伪造来源单状态。
 */

export interface SettlementOrderRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface SettlementOrderListQuery {
  readonly companyId?: string;
  readonly status?: SettlementOrderStatus;
  readonly sourceDocType?: SettlementSourceDocType;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

export interface SettlementOrderPage {
  readonly items: SettlementOrder[];
  readonly nextCursor: string | null;
}

export interface SettlementOrderState {
  readonly id: string;
  readonly companyId: string;
  readonly status: SettlementOrderStatus;
  readonly version: number;
}

interface SettlementOrderRow {
  id: string;
  tenant_id: string;
  company_id: string;
  order_no: string;
  source_doc_type: string;
  source_doc_id: string;
  status: string;
  total_sale_amount: string | number;
  total_cost_amount: string | number;
  gross_profit: string | number;
  gross_margin_rate: string | number;
  related_loss_amount: string | number;
  net_profit: string | number;
  commission_rate_snapshot: string | number;
  commission_amount: string | number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SettlementOrderStateRow {
  id: string;
  company_id: string;
  status: string;
  version: number;
}

const SETTLEMENT_ORDER_COLUMNS = `s.id,
  s.tenant_id,
  s.company_id,
  s.order_no,
  s.source_doc_type,
  s.source_doc_id,
  s.status,
  trim_scale(s.total_sale_amount) AS total_sale_amount,
  trim_scale(s.total_cost_amount) AS total_cost_amount,
  trim_scale(s.gross_profit) AS gross_profit,
  trim_scale(s.gross_margin_rate) AS gross_margin_rate,
  trim_scale(
    COALESCE(s.related_loss_amount_snapshot, s.related_loss_amount)
  ) AS related_loss_amount,
  trim_scale(s.net_profit) AS net_profit,
  trim_scale(s.commission_rate_snapshot) AS commission_rate_snapshot,
  trim_scale(s.commission_amount) AS commission_amount,
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

function mapSettlementOrder(row: SettlementOrderRow): SettlementOrder {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    orderNo: row.order_no,
    sourceDocType: row.source_doc_type as SettlementSourceDocType,
    sourceDocId: row.source_doc_id,
    status: row.status as SettlementOrderStatus,
    totalSaleAmount: decimal(row.total_sale_amount),
    totalCostAmount: decimal(row.total_cost_amount),
    grossProfit: decimal(row.gross_profit),
    grossMarginRate: decimal(row.gross_margin_rate),
    relatedLossAmount: decimal(row.related_loss_amount),
    netProfit: decimal(row.net_profit),
    commissionRateSnapshot: decimal(row.commission_rate_snapshot),
    commissionAmount: decimal(row.commission_amount),
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

/** C 结算单列表：租户 + 可见公司内过滤，按 UUIDv7 id 倒序分页。 */
export async function listSettlementOrders(
  ctx: SettlementOrderRepoContext,
  query: SettlementOrderListQuery,
): Promise<SettlementOrderPage> {
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
  if (query.sourceDocType !== undefined) {
    params.push(query.sourceDocType);
    where.push(`s.source_doc_type = $${params.length}`);
  }
  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    where.push(`s.order_no ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`s.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);
  const result = await ctx.tx.query<SettlementOrderRow>(
    `SELECT ${SETTLEMENT_ORDER_COLUMNS}
       FROM settlement_order s
      WHERE ${where.join('\n        AND ')}
      ORDER BY s.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const items = pageRows.map(mapSettlementOrder);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

/** C 结算单详情：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getSettlementOrder(
  ctx: SettlementOrderRepoContext,
  id: string,
): Promise<SettlementOrder | null> {
  const result = await ctx.tx.query<SettlementOrderRow>(
    `SELECT ${SETTLEMENT_ORDER_COLUMNS}
       FROM settlement_order s
      WHERE s.id = $1::uuid
        AND s.tenant_id = $2
        AND s.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  return row ? mapSettlementOrder(row) : null;
}

/** 确认前读取状态；跨公司等同不存在。 */
export async function loadSettlementOrderState(
  ctx: SettlementOrderRepoContext,
  id: string,
): Promise<SettlementOrderState | null> {
  const result = await ctx.tx.query<SettlementOrderStateRow>(
    `SELECT id, company_id, status, version
       FROM settlement_order
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    status: row.status as SettlementOrderStatus,
    version: row.version,
  };
}

/**
 * 确认结算：待确认 -> 已结算，一次且仅一次（D19）。
 *
 * related_loss_amount_snapshot 与 net_profit 在同一原子 UPDATE 内落库，
 * 后续来源损耗变化不再影响本单（D69）。版本或状态已被并发修改时返回 null。
 */
export async function confirmSettlementOrder(
  ctx: SettlementOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<SettlementOrder | null> {
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE settlement_order
        SET status = '已结算',
            related_loss_amount_snapshot = related_loss_amount,
            net_profit = gross_profit - related_loss_amount,
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '待确认'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (result.rows.length === 0) return null;
  return getSettlementOrder(ctx, id);
}
