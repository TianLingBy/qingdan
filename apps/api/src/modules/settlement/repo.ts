import {
  AppError,
  encodeCursor,
  type CommissionRate,
  type CursorPayload,
  type SettlementOrder,
  type SettlementOrderStatus,
  type SettlementSourceDocType,
} from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * C 结算单 + 提成比例配置数据访问层（D15 / D19 / D26 / D69 / D77）。
 *
 * - 所有查询都带 tenant_id + company_id = ANY(可见公司集合)；
 * - 金额保持 decimal 字符串，单头字段由 SQL trim_scale 规范化；
 * - 已结算单读取 related_loss_amount_snapshot，确保 D69 快照冻结；
 * - confirm 使用 version + status 条件原子更新，保证一期一单一次结算；
 * - 提成比例在确认同一原子 UPDATE 内落快照与金额（D77 ③），并发下不会读到配置变化。
 *
 * D19 现状：E 单完成态已由 sales 模块经 D70 跨模块公开用例通道
 * （platform/services/registry.ts 的 settlementDraftPort → 本模块 services/drafts.ts）
 * 自动生成 C 单草稿；N 单（内部交易）完成态尚未接入，属于 internal-trade 模块的接线工作。
 * 本 repo 仍不直读 E / N 表，也不在 settlement 模块内伪造来源单状态。
 *
 * 注：migrations/0016_settlement_orders.sql 里「草稿生成通道尚未接入」的注释已过期，
 * 但迁移文件受 checksum 保护（改历史迁移会让已部署库启动失败），故不在该文件内修改。
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
  /** 提成归属人（D77 ②）；历史草稿可能为 null。 */
  readonly commissionOwnerId: string | null;
}

export interface CommissionRateListQuery {
  readonly companyId?: string;
  readonly employeeId?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

export interface CommissionRatePage {
  readonly items: CommissionRate[];
  readonly nextCursor: string | null;
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
  commission_owner_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SettlementOrderStateRow {
  id: string;
  company_id: string;
  status: string;
  version: number;
  commission_owner_id: string | null;
}

interface CommissionRateRow {
  id: string;
  tenant_id: string;
  company_id: string;
  employee_id: string;
  rate: string | number;
  effective_from: Date | string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
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
  s.commission_owner_id,
  s.version,
  s.created_at,
  s.updated_at`;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function decimal(value: string | number): string {
  return String(value);
}

function dateOnly(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
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
    commissionOwnerId: row.commission_owner_id,
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

function mapCommissionRate(row: CommissionRateRow): CommissionRate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    rate: decimal(row.rate),
    effectiveFrom: dateOnly(row.effective_from),
    createdBy: row.created_by,
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
    `SELECT id, company_id, status, version, commission_owner_id
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
    commissionOwnerId: row.commission_owner_id,
  };
}

/**
 * 解析提成比例（D77 ③）：本公司内该员工 `effectiveFrom <= 今天` 的最新一条。
 * 没有配置返回 null（调用方按 0 处理）。
 */
export async function resolveCommissionRate(
  ctx: SettlementOrderRepoContext,
  companyId: string,
  employeeId: string,
): Promise<string | null> {
  const result = await ctx.tx.query<{ rate: string | number }>(
    `SELECT trim_scale(rate) AS rate
       FROM commission_rate
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND employee_id = $3::uuid
        AND effective_from <= CURRENT_DATE
      ORDER BY effective_from DESC
      LIMIT 1`,
    [ctx.tenantId, companyId, employeeId],
  );
  const row = result.rows[0];
  return row ? decimal(row.rate) : null;
}

/** 提成比例配置列表：租户 + 可见公司内过滤，按 UUIDv7 id 倒序分页。 */
export async function listCommissionRates(
  ctx: SettlementOrderRepoContext,
  query: CommissionRateListQuery,
): Promise<CommissionRatePage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = [
    'c.tenant_id = $1',
    'c.company_id = ANY($2::uuid[])',
  ];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`c.company_id = $${params.length}::uuid`);
  }
  if (query.employeeId !== undefined) {
    params.push(query.employeeId);
    where.push(`c.employee_id = $${params.length}::uuid`);
  }
  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`c.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);
  const result = await ctx.tx.query<CommissionRateRow>(
    `SELECT c.id, c.tenant_id, c.company_id, c.employee_id,
            trim_scale(c.rate) AS rate, c.effective_from, c.created_by,
            c.created_at, c.updated_at
       FROM commission_rate c
      WHERE ${where.join('\n        AND ')}
      ORDER BY c.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const items = pageRows.map(mapCommissionRate);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

/**
 * 新增提成比例配置（D77 ①）：同员工 + 公司 + 生效日唯一。
 * 重复插入抛 409（不静默覆盖——让财务看见冲突）。
 */
export async function createCommissionRate(
  ctx: SettlementOrderRepoContext,
  input: {
    readonly companyId: string;
    readonly employeeId: string;
    readonly rate: string;
    readonly effectiveFrom: string;
    readonly createdBy: string;
  },
): Promise<CommissionRate> {
  const id = uuidv7();
  const result = await ctx.tx.query<CommissionRateRow>(
    `INSERT INTO commission_rate
       (id, tenant_id, company_id, employee_id, rate, effective_from, created_by)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::numeric, $6::date, $7::uuid)
     ON CONFLICT (tenant_id, company_id, employee_id, effective_from) DO NOTHING
     RETURNING id, tenant_id, company_id, employee_id,
               trim_scale(rate) AS rate, effective_from, created_by,
               created_at, updated_at`,
    [
      id,
      ctx.tenantId,
      input.companyId,
      input.employeeId,
      input.rate,
      input.effectiveFrom,
      input.createdBy,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(
      'VERSION_CONFLICT',
      '该员工在该公司同一生效日已有提成比例配置（D77 ①：同生效日唯一，请改期或用新日期新增）',
      { employeeId: input.employeeId, effectiveFrom: input.effectiveFrom },
    );
  }
  return mapCommissionRate(row);
}

/** 删除提成比例配置：已结算单靠快照冻结（D77 ④），不影响历史。 */
export async function deleteCommissionRate(
  ctx: SettlementOrderRepoContext,
  id: string,
): Promise<CommissionRate | null> {
  const result = await ctx.tx.query<CommissionRateRow>(
    `DELETE FROM commission_rate c
      WHERE c.id = $1::uuid
        AND c.tenant_id = $2
        AND c.company_id = ANY($3::uuid[])
     RETURNING c.id, c.tenant_id, c.company_id, c.employee_id,
               trim_scale(c.rate) AS rate, c.effective_from, c.created_by,
               c.created_at, c.updated_at`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  return row ? mapCommissionRate(row) : null;
}

/**
 * 确认结算：待确认 -> 已结算，一次且仅一次（D19）。
 *
 * related_loss_amount_snapshot 与 net_profit 在同一原子 UPDATE 内落库，
 * 后续来源损耗变化不再影响本单（D69）；提成比例与金额同一条 SQL 落快照（D77 ③）：
 * `commissionAmount = round(max(gross_profit, 0) × rate, 6)`，负毛利记 0（D5④）。
 * `settled_at` 也在这里一次性写入（0026）：触发器会让 updated_at 随任何更新变化，
 * 期间报表只认 settled_at，不再拿 updated_at 推断结算时间。
 * 版本或状态已被并发修改时返回 null。
 */
export async function confirmSettlementOrder(
  ctx: SettlementOrderRepoContext,
  id: string,
  expectedVersion: number,
  commissionRate: string,
): Promise<SettlementOrder | null> {
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE settlement_order
        SET status = '已结算',
            settled_at = now(),
            related_loss_amount_snapshot = related_loss_amount,
            net_profit = gross_profit - related_loss_amount,
            commission_rate_snapshot = $5::numeric,
            commission_amount = round(GREATEST(gross_profit, 0) * $5::numeric, 6),
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '待确认'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion, commissionRate],
  );
  if (result.rows.length === 0) return null;
  return getSettlementOrder(ctx, id);
}
