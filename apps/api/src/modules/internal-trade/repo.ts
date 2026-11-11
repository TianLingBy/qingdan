import {
  AppError,
  encodeCursor,
  type CursorPayload,
  type InternalTradeOrder,
  type InternalTradeOrderCreateInput,
  type InternalTradeOrderLine,
  type InternalTradeOrderLineInput,
  type InternalTradeOrderStatus,
  type InternalTradeOrderUpdateInput,
} from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 内部交易单 N 数据访问层（D15 / D16 / D21 / D22 / D54 / D68）。
 *
 * - 隔离：单头按「发出公司或接收公司」在调用者可见集合内收口；
 * - 金额：商品行金额和单头在途量全部由 SQL 计算 / 聚合，应用侧不出现浮点；
 * - 批次：只接受发出公司的批次，并要求批次商品与明细商品一致（D22）；
 * - 写：版本不匹配抛 VERSION_CONFLICT，查不到返回 null（由用例映射 404）；
 * - 取消：不物理删除，只把非终态改为「已取消」（D21 / D68②）。
 */

export interface InternalTradeOrderRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface InternalTradeOrderListQuery {
  readonly fromCompanyId?: string;
  readonly toCompanyId?: string;
  readonly status?: InternalTradeOrderStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

export type InternalTradeOrderInsertInput = InternalTradeOrderCreateInput & {
  readonly id: string;
  readonly orderNo: string;
};

export interface InternalTradeOrderPage {
  readonly items: InternalTradeOrder[];
  readonly nextCursor: string | null;
}

export interface InternalTradeOrderState {
  readonly id: string;
  readonly companyId: string;
  readonly fromCompanyId: string;
  readonly toCompanyId: string;
  readonly status: InternalTradeOrderStatus;
  readonly version: number;
}

interface HeaderRow {
  id: string;
  tenant_id: string;
  company_id: string;
  from_company_id: string;
  from_company_name: string;
  to_company_id: string;
  to_company_name: string;
  order_no: string;
  status: string;
  handler_id: string;
  internal_price: string | number;
  in_transit_qty: string | number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LineRow {
  id: string;
  product_id: string;
  qty: string | number;
  unit_price: string | number;
  amount: string | number;
}

interface StateRow {
  id: string;
  company_id: string;
  from_company_id: string;
  to_company_id: string;
  status: string;
  version: number;
}

interface CompanyRow {
  id: string;
  name: string;
}

interface BatchRow {
  id: string;
  product_id: string;
}

const HEADER_COLUMNS = `o.id,
  o.tenant_id,
  o.company_id,
  o.from_company_id,
  fc.name AS from_company_name,
  o.to_company_id,
  tc.name AS to_company_name,
  o.order_no,
  o.status,
  o.handler_id,
  trim_scale(o.internal_price) AS internal_price,
  trim_scale(o.in_transit_qty) AS in_transit_qty,
  o.version,
  o.created_at,
  o.updated_at`;

const HEADER_FROM = `internal_trade_order o
  JOIN company fc
    ON fc.id = o.from_company_id
   AND fc.tenant_id = o.tenant_id
  JOIN company tc
    ON tc.id = o.to_company_id
   AND tc.tenant_id = o.tenant_id`;

const LINE_COLUMNS = `l.id,
  l.product_id,
  trim_scale(l.qty) AS qty,
  trim_scale(l.unit_price) AS unit_price,
  trim_scale(l.amount) AS amount`;

const VISIBLE_ORDER_PREDICATE = `(
  o.from_company_id = ANY($2::uuid[])
  OR o.to_company_id = ANY($2::uuid[])
)`;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function decimal(value: string | number): string {
  return String(value);
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function mapHeader(row: HeaderRow): Omit<InternalTradeOrder, 'lines'> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fromCompanyId: row.from_company_id,
    fromCompanyName: row.from_company_name,
    toCompanyId: row.to_company_id,
    toCompanyName: row.to_company_name,
    orderNo: row.order_no,
    status: row.status as InternalTradeOrderStatus,
    handlerId: row.handler_id,
    internalPrice: decimal(row.internal_price),
    // D68：只有「在途」状态才代表真实锁定；进行中 / 终态都必须回 0。
    // 发货端点落地前，新单会一直保持 0；这里同时屏蔽历史错误派生值。
    inTransitQty: row.status === '在途' ? decimal(row.in_transit_qty) : '0',
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

async function queryHeader(
  ctx: InternalTradeOrderRepoContext,
  id: string,
): Promise<HeaderRow | null> {
  const result = await ctx.tx.query<HeaderRow>(
    `SELECT ${HEADER_COLUMNS}
       FROM ${HEADER_FROM}
      WHERE o.id = $1::uuid
        AND o.tenant_id = $2
        AND (
          o.from_company_id = ANY($3::uuid[])
          OR o.to_company_id = ANY($3::uuid[])
        )`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  return result.rows[0] ?? null;
}

async function queryLines(
  ctx: InternalTradeOrderRepoContext,
  orderIds: readonly string[],
): Promise<Map<string, InternalTradeOrderLine[]>> {
  const grouped = new Map<string, InternalTradeOrderLine[]>();
  if (orderIds.length === 0) return grouped;

  const [lineResult, batchResult] = await Promise.all([
    ctx.tx.query<LineRow & { order_id: string }>(
      `SELECT l.order_id,
              ${LINE_COLUMNS}
         FROM internal_trade_order_line l
        WHERE l.tenant_id = $1
          AND l.order_id = ANY($2::uuid[])
        ORDER BY l.order_id, l.line_no`,
      [ctx.tenantId, [...orderIds]],
    ),
    ctx.tx.query<{ order_line_id: string; batch_id: string }>(
      `SELECT b.order_line_id, b.batch_id
         FROM internal_trade_order_line_batch b
         JOIN internal_trade_order_line l
           ON l.id = b.order_line_id
          AND l.tenant_id = b.tenant_id
        WHERE b.tenant_id = $1
          AND l.order_id = ANY($2::uuid[])
        ORDER BY l.order_id, l.line_no, b.line_no`,
      [ctx.tenantId, [...orderIds]],
    ),
  ]);

  const batchesByLine = new Map<string, string[]>();
  for (const row of batchResult.rows) {
    const ids = batchesByLine.get(row.order_line_id) ?? [];
    ids.push(row.batch_id);
    batchesByLine.set(row.order_line_id, ids);
  }

  for (const row of lineResult.rows) {
    const list = grouped.get(row.order_id) ?? [];
    list.push({
      productId: row.product_id,
      batchIds: batchesByLine.get(row.id) ?? [],
      qty: decimal(row.qty),
      unitPrice: decimal(row.unit_price),
      amount: decimal(row.amount),
    });
    grouped.set(row.order_id, list);
  }
  return grouped;
}

/** N 单列表：租户内按发出 / 接收公司可见性收口，并按 UUIDv7 id 倒序分页。 */
export async function listInternalTradeOrders(
  ctx: InternalTradeOrderRepoContext,
  query: InternalTradeOrderListQuery,
): Promise<InternalTradeOrderPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = [`o.tenant_id = $1`, VISIBLE_ORDER_PREDICATE];

  if (query.fromCompanyId !== undefined) {
    params.push(query.fromCompanyId);
    where.push(`o.from_company_id = $${params.length}::uuid`);
  }
  if (query.toCompanyId !== undefined) {
    params.push(query.toCompanyId);
    where.push(`o.to_company_id = $${params.length}::uuid`);
  }
  if (query.status !== undefined) {
    params.push(query.status);
    where.push(`o.status = $${params.length}`);
  }
  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    where.push(`o.order_no ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`o.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);
  const result = await ctx.tx.query<HeaderRow>(
    `SELECT ${HEADER_COLUMNS}
       FROM ${HEADER_FROM}
      WHERE ${where.join('\n        AND ')}
      ORDER BY o.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const linesByOrder = await queryLines(
    ctx,
    pageRows.map((row) => row.id),
  );
  const items = pageRows.map((row) => ({
    ...mapHeader(row),
    lines: linesByOrder.get(row.id) ?? [],
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

/** N 单详情基础实体；查不到（含公司不可见）返回 null。 */
export async function getInternalTradeOrder(
  ctx: InternalTradeOrderRepoContext,
  id: string,
): Promise<InternalTradeOrder | null> {
  const row = await queryHeader(ctx, id);
  if (!row) return null;
  const linesByOrder = await queryLines(ctx, [id]);
  return {
    ...mapHeader(row),
    lines: linesByOrder.get(id) ?? [],
  };
}

/** 修改 / 取消前读取状态；发出或接收公司任一可见即可读取。 */
export async function loadInternalTradeOrderState(
  ctx: InternalTradeOrderRepoContext,
  id: string,
): Promise<InternalTradeOrderState | null> {
  const result = await ctx.tx.query<StateRow>(
    `SELECT id, company_id, from_company_id, to_company_id, status, version
       FROM internal_trade_order
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND (from_company_id = ANY($3::uuid[]) OR to_company_id = ANY($3::uuid[]))`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    fromCompanyId: row.from_company_id,
    toCompanyId: row.to_company_id,
    status: row.status as InternalTradeOrderStatus,
    version: row.version,
  };
}

export async function listBatchIdsForOrder(
  ctx: InternalTradeOrderRepoContext,
  orderId: string,
): Promise<readonly string[]> {
  const result = await ctx.tx.query<{ batch_id: string }>(
    `SELECT DISTINCT b.batch_id::text AS batch_id
       FROM internal_trade_order_line_batch b
       JOIN internal_trade_order_line l
         ON l.id = b.order_line_id
        AND l.tenant_id = b.tenant_id
       JOIN internal_trade_order o
         ON o.id = l.order_id
        AND o.tenant_id = l.tenant_id
      WHERE b.tenant_id = $1
        AND l.order_id = $2::uuid
        AND b.company_id = o.from_company_id`,
    [ctx.tenantId, orderId],
  );
  return result.rows.map((row) => row.batch_id);
}

/**
 * 直接下游判定（D21）：以 N 单为来源的库存流水存在，即视为下游已发生。
 * 发货 / 在途占用与到货转司端点不在本批范围，但历史 / 并发写入的流水仍须阻止取消。
 */
export async function hasDirectDownstream(
  ctx: InternalTradeOrderRepoContext,
  state: InternalTradeOrderState,
): Promise<boolean> {
  const result = await ctx.tx.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM inventory_flow f
        WHERE f.tenant_id = $1
          AND f.company_id = $2::uuid
          AND f.source_doc_id = $3::uuid
          AND f.source_doc_type IN ('N', 'internal_trade_order')
     ) AS exists`,
    [ctx.tenantId, state.companyId, state.id],
  );
  return result.rows[0]?.exists === true;
}

async function assertCompaniesVisible(
  ctx: InternalTradeOrderRepoContext,
  fromCompanyId: string,
  toCompanyId: string,
): Promise<void> {
  if (fromCompanyId === toCompanyId) {
    throw new AppError('VALIDATION_FAILED', '发出公司与接收公司不能相同');
  }
  if (
    !ctx.companyIds.includes(fromCompanyId) ||
    !ctx.companyIds.includes(toCompanyId)
  ) {
    throw new AppError('FORBIDDEN', '调用者对发出或接收公司无权限', {
      fromCompanyId,
      toCompanyId,
    });
  }

  const result = await ctx.tx.query<CompanyRow>(
    `SELECT id, name
       FROM company
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])`,
    [ctx.tenantId, [fromCompanyId, toCompanyId]],
  );
  const found = new Set(result.rows.map((row) => row.id));
  const missing = [fromCompanyId, toCompanyId].filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError('VALIDATION_FAILED', '发出或接收公司不存在', {
      companyIds: missing,
    });
  }
}

async function assertHandlerInTenant(
  ctx: InternalTradeOrderRepoContext,
  handlerId: string,
): Promise<void> {
  const result = await ctx.tx.query(
    `SELECT 1 FROM employee WHERE id = $1::uuid AND tenant_id = $2`,
    [handlerId, ctx.tenantId],
  );
  if (result.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', '经手人不存在', { handlerId });
  }
}

/** 只允许引用发出公司的批次，且每行的批次商品必须与该行商品一致（D22）。 */
async function assertBatchesBelongToFromCompany(
  ctx: InternalTradeOrderRepoContext,
  lines: readonly InternalTradeOrderLineInput[],
  fromCompanyId: string,
): Promise<void> {
  const batchIds = [...new Set(lines.flatMap((line) => line.batchIds))];
  const result = await ctx.tx.query<BatchRow>(
    `SELECT id, product_id
       FROM inventory_batch
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [ctx.tenantId, fromCompanyId, batchIds],
  );
  const productByBatch = new Map(
    result.rows.map((row) => [row.id, row.product_id]),
  );
  const missing = batchIds.filter((id) => !productByBatch.has(id));
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      '批次不存在或不属于发出公司',
      {
        batchIds: missing,
        fromCompanyId,
      },
    );
  }

  for (const [index, line] of lines.entries()) {
    for (const batchId of line.batchIds) {
      if (productByBatch.get(batchId) !== line.productId) {
        throw new AppError(
          'VALIDATION_FAILED',
          '商品明细商品与所引批次商品不一致',
          {
            lineNo: index + 1,
            productId: line.productId,
            batchId,
          },
        );
      }
    }
  }
}

async function insertLines(
  ctx: InternalTradeOrderRepoContext,
  orderId: string,
  fromCompanyId: string,
  lines: readonly InternalTradeOrderLineInput[],
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    const lineId = uuidv7();
    await ctx.tx.query(
      `INSERT INTO internal_trade_order_line
         (id, tenant_id, company_id, order_id, line_no, product_id,
          qty, unit_price, amount)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::uuid,
               $7::amount, $8::amount, ($7::amount * $8::amount))`,
      [
        lineId,
        ctx.tenantId,
        fromCompanyId,
        orderId,
        index + 1,
        line.productId,
        line.qty,
        line.unitPrice,
      ],
    );
    for (const [batchIndex, batchId] of line.batchIds.entries()) {
      await ctx.tx.query(
        `INSERT INTO internal_trade_order_line_batch
           (id, tenant_id, company_id, order_id, order_line_id, line_no, batch_id)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid)`,
        [
          uuidv7(),
          ctx.tenantId,
          fromCompanyId,
          orderId,
          lineId,
          batchIndex + 1,
          batchId,
        ],
      );
    }
  }
}

/** 新增 N 单：`id` / `orderNo` 由用例生成，状态固定从「进行中」开始。 */
export async function insertInternalTradeOrder(
  ctx: InternalTradeOrderRepoContext,
  input: InternalTradeOrderInsertInput,
): Promise<InternalTradeOrder> {
  await assertCompaniesVisible(ctx, input.fromCompanyId, input.toCompanyId);
  await assertHandlerInTenant(ctx, input.handlerId);
  await assertBatchesBelongToFromCompany(
    ctx,
    input.lines,
    input.fromCompanyId,
  );

  await ctx.tx.query(
    `INSERT INTO internal_trade_order
       (id, tenant_id, company_id, from_company_id, to_company_id, order_no,
        handler_id, status, internal_price, in_transit_qty, version)
     VALUES ($1::uuid, $2, $3::uuid, $3::uuid, $4::uuid, $5,
             $6::uuid, '进行中', $7::amount, 0, 1)`,
    [
      input.id,
      ctx.tenantId,
      input.fromCompanyId,
      input.toCompanyId,
      input.orderNo,
      input.handlerId,
      input.internalPrice,
    ],
  );
  await insertLines(ctx, input.id, input.fromCompanyId, input.lines);

  const created = await getInternalTradeOrder(ctx, input.id);
  if (!created) {
    throw new AppError('INTERNAL_ERROR', '内部交易单创建后读取失败', {
      id: input.id,
    });
  }
  return created;
}

/**
 * 修改 N 单：仅「进行中」可改（D68②），并校验强 ETag 版本。
 * 明细传入即整体替换；未传字段保持原值。
 */
export async function updateInternalTradeOrder(
  ctx: InternalTradeOrderRepoContext,
  id: string,
  input: InternalTradeOrderUpdateInput,
  expectedVersion: number,
): Promise<InternalTradeOrder | null> {
  const current = await loadInternalTradeOrderState(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '内部交易单版本与 If-Match 不一致，请重新读取后重试',
      {
        expected: expectedVersion,
        current: current.version,
      },
    );
  }
  if (current.status !== '进行中') {
    throw new AppError(
      'VALIDATION_FAILED',
      '只有「进行中」的内部交易单可修改，错账请走冲正单据',
      {
        status: current.status,
      },
    );
  }

  if (input.handlerId !== undefined) {
    await assertHandlerInTenant(ctx, input.handlerId);
  }
  if (input.lines !== undefined) {
    await assertBatchesBelongToFromCompany(
      ctx,
      input.lines,
      current.fromCompanyId,
    );
  }

  const updated = await ctx.tx.query<{ id: string }>(
    `UPDATE internal_trade_order
        SET handler_id = COALESCE($4::uuid, handler_id),
            internal_price = COALESCE($5::amount, internal_price),
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND (from_company_id = ANY($3::uuid[]) OR to_company_id = ANY($3::uuid[]))
        AND version = $6
        AND status = '进行中'
      RETURNING id`,
    [
      id,
      ctx.tenantId,
      [...ctx.companyIds],
      input.handlerId ?? null,
      input.internalPrice ?? null,
      expectedVersion,
    ],
  );
  if (updated.rows.length === 0) {
    throw new AppError(
      'VERSION_CONFLICT',
      '内部交易单已被并发修改，请重新读取后重试',
    );
  }

  if (input.lines !== undefined) {
    await ctx.tx.query(
      `DELETE FROM internal_trade_order_line_batch b
        USING internal_trade_order_line l
        WHERE b.order_line_id = l.id
          AND b.tenant_id = $2
          AND l.tenant_id = $2
          AND l.order_id = $1::uuid
          AND b.company_id = $3::uuid
          AND l.company_id = $3::uuid`,
      [id, ctx.tenantId, current.fromCompanyId],
    );
    await ctx.tx.query(
      `DELETE FROM internal_trade_order_line
        WHERE order_id = $1::uuid
          AND tenant_id = $2
          AND company_id = $3::uuid`,
      [id, ctx.tenantId, current.fromCompanyId],
    );
    await insertLines(ctx, id, current.fromCompanyId, input.lines);
  }

  return getInternalTradeOrder(ctx, id);
}

/**
 * 取消 N 单：只把「进行中 / 在途」改为「已取消」，不物理删除（D21 / D68②）。
 * 状态合法性由用例侧先按四态映射调用 `assertCancelable`。
 */
export async function cancelInternalTradeOrder(
  ctx: InternalTradeOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<InternalTradeOrder | null> {
  const current = await loadInternalTradeOrderState(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '内部交易单版本与 If-Match 不一致，请重新读取后重试',
      {
        expected: expectedVersion,
        current: current.version,
      },
    );
  }

  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE internal_trade_order
        SET status = '已取消',
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND (from_company_id = ANY($3::uuid[]) OR to_company_id = ANY($3::uuid[]))
        AND version = $4
        AND status IN ('进行中', '在途')
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (result.rows.length === 0) {
    throw new AppError(
      'VERSION_CONFLICT',
      '内部交易单已被并发修改，请重新读取后重试',
    );
  }

  return getInternalTradeOrder(ctx, id);
}

export async function receiveInternalTradeOrder(
  ctx: InternalTradeOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<InternalTradeOrder | null> {
  const current = await loadInternalTradeOrderState(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '内部交易单版本与 If-Match 不一致，请重新读取后重试',
      { expected: expectedVersion, current: current.version },
    );
  }
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE internal_trade_order
        SET status = '已完成',
            in_transit_qty = 0,
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND to_company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '在途'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (result.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '只有在途状态的内部交易单可以确认到货');
  }
  return getInternalTradeOrder(ctx, id);
}
