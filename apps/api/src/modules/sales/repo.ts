import {
  AppError,
  encodeCursor,
  type CustomerReturn,
  type CustomerReturnCreateInput,
  type CustomerReturnLine,
  type CustomerReturnStatus,
  type CursorPayload,
  type OnlyRefundKind,
  type RefundMode,
  type SalesReceipt,
  type SalesReceiptCreateInput,
  type SalesOrder,
  type SalesOrderCreateInput,
  type SalesOrderFee,
  type SalesOrderLine,
  type SalesOrderStatus,
  type SalesOrderUpdateInput,
} from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 销售单 E 数据访问层（D15 / D16 / D20 / D21 / D22 / D39 / D54）。
 *
 * - 隔离：所有查询都带 tenant_id + company_id = ANY(可见公司集合)；
 * - 金额：全部保持 decimal 字符串，映射金额与单头合计统一交给 SQL；
 * - 改价下限：本行所引批次的 weighted_unit_cost 平均值在 SQL 中计算；契约仅传
 *   batchIds，未提供逐批分配量，因此每个引用视为等额引用（相当于 SQL AVG）；
 * - 写：版本不匹配抛 VERSION_CONFLICT，查不到返回 null（由用例映射 404）；
 * - 取消：不物理删除（D21 / D47），只改状态。
 */

export interface SalesOrderRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface SalesOrderListQuery {
  readonly companyId?: string;
  readonly customerId?: string;
  readonly status?: SalesOrderStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 创建输入 = 契约创建体 + 用例生成的 uuid / 单号。 */
export type SalesOrderInsertInput = SalesOrderCreateInput & {
  readonly id: string;
  readonly orderNo: string;
};

export interface SalesOrderPage {
  readonly items: SalesOrder[];
  readonly nextCursor: string | null;
}

export interface SalesOrderState {
  readonly id: string;
  readonly companyId: string;
  readonly status: SalesOrderStatus;
  readonly version: number;
}

interface HeaderRow {
  id: string;
  tenant_id: string;
  company_id: string;
  order_no: string;
  customer_id: string;
  customer_name: string;
  status: string;
  handler_id: string;
  total_amount: string | number;
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

interface FeeRow {
  fee_name: string;
  qty: string | number;
  unit_price: string | number;
  amount: string | number;
  remark: string | null;
}

interface StateRow {
  id: string;
  company_id: string;
  status: string;
  version: number;
}

interface BatchRow {
  id: string;
  product_id: string;
}

const HEADER_COLUMNS = `o.id,
  o.tenant_id,
  o.company_id,
  o.order_no,
  o.customer_id,
  c.name AS customer_name,
  o.status,
  o.handler_id,
  trim_scale(o.total_amount) AS total_amount,
  o.version,
  o.created_at,
  o.updated_at`;

const HEADER_FROM = `sales_order o
  JOIN customer c
    ON c.id = o.customer_id
   AND c.tenant_id = o.tenant_id
   AND c.company_id = o.company_id`;

const LINE_COLUMNS = `l.id,
  l.product_id,
  trim_scale(l.qty) AS qty,
  trim_scale(l.unit_price) AS unit_price,
  trim_scale(l.amount) AS amount`;

const FEE_COLUMNS = `f.fee_name,
  trim_scale(f.qty) AS qty,
  trim_scale(f.unit_price) AS unit_price,
  trim_scale(f.amount) AS amount,
  f.remark`;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function decimal(value: string | number): string {
  return String(value);
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function mapHeader(row: HeaderRow): Omit<SalesOrder, 'lines' | 'fees'> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    orderNo: row.order_no,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status as SalesOrderStatus,
    handlerId: row.handler_id,
    totalAmount: decimal(row.total_amount),
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

function mapFee(row: FeeRow): SalesOrderFee {
  return {
    feeName: row.fee_name,
    qty: decimal(row.qty),
    unitPrice: decimal(row.unit_price),
    amount: decimal(row.amount),
    remark: row.remark,
  };
}

async function queryHeader(
  ctx: SalesOrderRepoContext,
  id: string,
): Promise<HeaderRow | null> {
  const result = await ctx.tx.query<HeaderRow>(
    `SELECT ${HEADER_COLUMNS}
       FROM ${HEADER_FROM}
      WHERE o.id = $1::uuid
        AND o.tenant_id = $2
        AND o.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  return result.rows[0] ?? null;
}

async function queryLines(
  ctx: SalesOrderRepoContext,
  orderIds: readonly string[],
): Promise<Map<string, SalesOrderLine[]>> {
  const grouped = new Map<string, SalesOrderLine[]>();
  if (orderIds.length === 0) return grouped;

  const [lineResult, batchResult] = await Promise.all([
    ctx.tx.query<LineRow & { order_id: string }>(
      `SELECT l.order_id,
              ${LINE_COLUMNS}
         FROM sales_order_line l
        WHERE l.tenant_id = $1
          AND l.order_id = ANY($2::uuid[])
        ORDER BY l.order_id, l.line_no`,
      [ctx.tenantId, [...orderIds]],
    ),
    ctx.tx.query<{ order_line_id: string; batch_id: string }>(
      `SELECT b.order_line_id, b.batch_id
         FROM sales_order_line_batch b
         JOIN sales_order_line l
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

async function queryFees(
  ctx: SalesOrderRepoContext,
  orderIds: readonly string[],
): Promise<Map<string, SalesOrderFee[]>> {
  const grouped = new Map<string, SalesOrderFee[]>();
  if (orderIds.length === 0) return grouped;

  const result = await ctx.tx.query<FeeRow & { order_id: string }>(
    `SELECT f.order_id,
            ${FEE_COLUMNS}
       FROM sales_order_fee f
      WHERE f.tenant_id = $1
        AND f.order_id = ANY($2::uuid[])
      ORDER BY f.order_id, f.line_no`,
    [ctx.tenantId, [...orderIds]],
  );
  for (const row of result.rows) {
    const list = grouped.get(row.order_id) ?? [];
    list.push(mapFee(row));
    grouped.set(row.order_id, list);
  }
  return grouped;
}

/** 销售单列表：租户 + 可见公司内过滤，按 UUIDv7 id 倒序分页。 */
export async function listSalesOrders(
  ctx: SalesOrderRepoContext,
  query: SalesOrderListQuery,
): Promise<SalesOrderPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = [
    'o.tenant_id = $1',
    'o.company_id = ANY($2::uuid[])',
  ];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`o.company_id = $${params.length}::uuid`);
  }
  if (query.customerId !== undefined) {
    params.push(query.customerId);
    where.push(`o.customer_id = $${params.length}::uuid`);
  }
  if (query.status !== undefined) {
    params.push(query.status);
    where.push(`o.status = $${params.length}`);
  }
  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    const keywordParam = `$${params.length}`;
    where.push(`(
      o.order_no ILIKE ${keywordParam} ESCAPE '\\'
      OR c.name ILIKE ${keywordParam} ESCAPE '\\'
    )`);
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
  const ids = pageRows.map((row) => row.id);
  const [linesByOrder, feesByOrder] = await Promise.all([
    queryLines(ctx, ids),
    queryFees(ctx, ids),
  ]);
  const items = pageRows.map((row) => ({
    ...mapHeader(row),
    lines: linesByOrder.get(row.id) ?? [],
    fees: feesByOrder.get(row.id) ?? [],
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

/** 销售单详情基础实体：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getSalesOrder(
  ctx: SalesOrderRepoContext,
  id: string,
): Promise<SalesOrder | null> {
  const row = await queryHeader(ctx, id);
  if (!row) return null;
  const [linesByOrder, feesByOrder] = await Promise.all([
    queryLines(ctx, [id]),
    queryFees(ctx, [id]),
  ]);
  return {
    ...mapHeader(row),
    lines: linesByOrder.get(id) ?? [],
    fees: feesByOrder.get(id) ?? [],
  };
}

/** 修改 / 取消前读取状态；跨公司等同不存在。 */
export async function loadSalesOrderState(
  ctx: SalesOrderRepoContext,
  id: string,
): Promise<SalesOrderState | null> {
  const result = await ctx.tx.query<StateRow>(
    `SELECT id, company_id, status, version
       FROM sales_order
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
    status: row.status as SalesOrderStatus,
    version: row.version,
  };
}

/** 直接下游判定（D21）：库存流水以 E 单为来源即视为下游已发生。 */
export async function hasDirectDownstream(
  ctx: SalesOrderRepoContext,
  state: SalesOrderState,
): Promise<boolean> {
  const result = await ctx.tx.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM inventory_flow f
        WHERE f.tenant_id = $1
          AND f.company_id = $2::uuid
          AND f.source_doc_id = $3::uuid
          AND f.source_doc_type IN ('E', 'sales_order')
     ) AS exists`,
    [ctx.tenantId, state.companyId, state.id],
  );
  return result.rows[0]?.exists === true;
}

async function assertCustomerInCompany(
  ctx: SalesOrderRepoContext,
  customerId: string,
  companyId: string,
): Promise<void> {
  const result = await ctx.tx.query(
    `SELECT 1
       FROM customer
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid`,
    [customerId, ctx.tenantId, companyId],
  );
  if (result.rows.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      '客户不存在或不属于该销售单的公司',
      {
        customerId,
        companyId,
      },
    );
  }
}

async function assertHandlerInTenant(
  ctx: SalesOrderRepoContext,
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

/**
 * 一次性校验所有商品 / 批次归属（D22），并逐行用 SQL 计算 D20 下限。
 * 契约的 batchIds 未携带逐批引用量，故同一行内每个批次按等额引用处理。
 */
async function resolveLineCostFloors(
  ctx: SalesOrderRepoContext,
  lines: readonly SalesOrderLine[],
  companyId: string,
): Promise<string[]> {
  const batchIds = [...new Set(lines.flatMap((line) => line.batchIds))];
  const batchResult = await ctx.tx.query<BatchRow>(
    `SELECT id, product_id
       FROM inventory_batch
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [ctx.tenantId, companyId, batchIds],
  );
  const productByBatch = new Map(
    batchResult.rows.map((row) => [row.id, row.product_id]),
  );
  const missing = batchIds.filter((id) => !productByBatch.has(id));
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      '批次不存在或不属于该销售单的公司',
      {
        batchIds: missing,
        companyId,
      },
    );
  }

  const floors: string[] = [];
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

    const result = await ctx.tx.query<{
      cost_floor: string | number;
      below_floor: boolean;
    }>(
      `SELECT trim_scale(AVG(locked_unit_cost)) AS cost_floor,
              COALESCE($2::amount < AVG(locked_unit_cost), false) AS below_floor
         FROM inventory_batch
        WHERE tenant_id = $1
          AND company_id = $3::uuid
          AND id = ANY($4::uuid[])`,
      [ctx.tenantId, line.unitPrice, companyId, line.batchIds],
    );
    const row = result.rows[0];
    if (!row || row.cost_floor === null) {
      throw new AppError('VALIDATION_FAILED', '无法计算商品行改价下限', {
        lineNo: index + 1,
        batchIds: line.batchIds,
      });
    }
    if (row.below_floor) {
      throw new AppError(
        'VALIDATION_FAILED',
        '售价低于该行加权平均批次成本；契约本批未开放审批字段，须完成 platform 审批后重试',
        {
          lineNo: index + 1,
          unitPrice: line.unitPrice,
          costFloor: decimal(row.cost_floor),
        },
      );
    }
    floors.push(decimal(row.cost_floor));
  }
  return floors;
}

async function insertLines(
  ctx: SalesOrderRepoContext,
  orderId: string,
  companyId: string,
  lines: readonly SalesOrderLine[],
  costFloors: readonly string[],
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    const lineId = uuidv7();
    await ctx.tx.query(
      `INSERT INTO sales_order_line
         (id, tenant_id, company_id, order_id, line_no, product_id,
          qty, unit_price, amount, cost_floor)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::uuid,
               $7::amount, $8::amount, ($7::amount * $8::amount), $9::amount)`,
      [
        lineId,
        ctx.tenantId,
        companyId,
        orderId,
        index + 1,
        line.productId,
        line.qty,
        line.unitPrice,
        costFloors[index],
      ],
    );
    for (const [batchIndex, batchId] of line.batchIds.entries()) {
      await ctx.tx.query(
        `INSERT INTO sales_order_line_batch
           (id, tenant_id, company_id, order_id, order_line_id, line_no, batch_id)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid)`,
        [
          uuidv7(),
          ctx.tenantId,
          companyId,
          orderId,
          lineId,
          batchIndex + 1,
          batchId,
        ],
      );
    }
  }
}

async function insertFees(
  ctx: SalesOrderRepoContext,
  orderId: string,
  companyId: string,
  fees: SalesOrderInsertInput['fees'],
): Promise<void> {
  for (const [index, fee] of (fees ?? []).entries()) {
    await ctx.tx.query(
      `INSERT INTO sales_order_fee
         (id, tenant_id, company_id, order_id, line_no, fee_name,
          qty, unit_price, amount, remark)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6,
               $7::amount, $8::amount, ($7::amount * $8::amount), $9)`,
      [
        uuidv7(),
        ctx.tenantId,
        companyId,
        orderId,
        index + 1,
        fee.feeName,
        fee.qty,
        fee.unitPrice,
        fee.remark ?? null,
      ],
    );
  }
}

/** 单头金额全部交给 SQL 聚合，应用侧不出现浮点。 */
async function recalcTotals(
  ctx: SalesOrderRepoContext,
  orderId: string,
): Promise<void> {
  await ctx.tx.query(
    `UPDATE sales_order o
        SET goods_amount = COALESCE(
              (SELECT SUM(l.amount)
                 FROM sales_order_line l
                WHERE l.order_id = o.id
                  AND l.tenant_id = o.tenant_id),
              0
            ),
            fee_amount = COALESCE(
              (SELECT SUM(f.amount)
                 FROM sales_order_fee f
                WHERE f.order_id = o.id
                  AND f.tenant_id = o.tenant_id),
              0
            ),
            total_amount = COALESCE(
              (SELECT SUM(l.amount)
                 FROM sales_order_line l
                WHERE l.order_id = o.id
                  AND l.tenant_id = o.tenant_id),
              0
            ) + COALESCE(
              (SELECT SUM(f.amount)
                 FROM sales_order_fee f
                WHERE f.order_id = o.id
                  AND f.tenant_id = o.tenant_id),
              0
            )
      WHERE o.id = $1::uuid
        AND o.tenant_id = $2`,
    [orderId, ctx.tenantId],
  );
}

/** 新增销售单：`id` / `orderNo` 由用例生成。 */
export async function insertSalesOrder(
  ctx: SalesOrderRepoContext,
  input: SalesOrderInsertInput,
): Promise<SalesOrder> {
  await assertCustomerInCompany(ctx, input.customerId, input.companyId);
  await assertHandlerInTenant(ctx, input.handlerId);
  const costFloors = await resolveLineCostFloors(
    ctx,
    input.lines,
    input.companyId,
  );

  await ctx.tx.query(
    `INSERT INTO sales_order
       (id, tenant_id, company_id, order_no, customer_id, handler_id, status)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, '进行中')`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.orderNo,
      input.customerId,
      input.handlerId,
    ],
  );
  await insertLines(ctx, input.id, input.companyId, input.lines, costFloors);
  await insertFees(ctx, input.id, input.companyId, input.fees);
  await recalcTotals(ctx, input.id);

  const created = await getSalesOrder(ctx, input.id);
  if (!created) {
    throw new AppError('INTERNAL_ERROR', '销售单创建后读取失败', {
      id: input.id,
    });
  }
  return created;
}

/**
 * 修改销售单：只有「进行中」可改，并校验强 ETag 版本。
 * 商品 / 费用传入即整体替换；未传字段保持原值。
 */
export async function updateSalesOrder(
  ctx: SalesOrderRepoContext,
  id: string,
  input: SalesOrderUpdateInput,
  expectedVersion: number,
): Promise<SalesOrder | null> {
  const current = await loadSalesOrderState(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '销售单版本与 If-Match 不一致，请重新读取后重试',
      {
        expected: expectedVersion,
        current: current.version,
      },
    );
  }
  if (current.status !== '进行中') {
    throw new AppError(
      'VALIDATION_FAILED',
      '只有「进行中」的销售单可修改，错账请走冲正单据',
      {
        status: current.status,
      },
    );
  }

  if (input.customerId !== undefined) {
    await assertCustomerInCompany(ctx, input.customerId, current.companyId);
  }
  if (input.handlerId !== undefined) {
    await assertHandlerInTenant(ctx, input.handlerId);
  }
  const costFloors =
    input.lines === undefined
      ? null
      : await resolveLineCostFloors(ctx, input.lines, current.companyId);

  const updated = await ctx.tx.query<{ id: string }>(
    `UPDATE sales_order
        SET customer_id = COALESCE($4::uuid, customer_id),
            handler_id = COALESCE($5::uuid, handler_id),
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $6
        AND status = '进行中'
      RETURNING id`,
    [
      id,
      ctx.tenantId,
      [...ctx.companyIds],
      input.customerId ?? null,
      input.handlerId ?? null,
      expectedVersion,
    ],
  );
  if (updated.rows.length === 0) {
    throw new AppError(
      'VERSION_CONFLICT',
      '销售单已被并发修改，请重新读取后重试',
    );
  }

  if (input.lines !== undefined) {
    await ctx.tx.query(
      `DELETE FROM sales_order_line_batch b
        USING sales_order_line l
        WHERE b.order_line_id = l.id
          AND b.tenant_id = $2
          AND l.tenant_id = $2
          AND l.order_id = $1::uuid
          AND b.company_id = $3::uuid
          AND l.company_id = $3::uuid`,
      [id, ctx.tenantId, current.companyId],
    );
    await ctx.tx.query(
      `DELETE FROM sales_order_line
        WHERE order_id = $1::uuid
          AND tenant_id = $2
          AND company_id = $3::uuid`,
      [id, ctx.tenantId, current.companyId],
    );
    await insertLines(
      ctx,
      id,
      current.companyId,
      input.lines,
      costFloors ?? [],
    );
  }
  if (input.fees !== undefined) {
    await ctx.tx.query(
      `DELETE FROM sales_order_fee
        WHERE order_id = $1::uuid
          AND tenant_id = $2
          AND company_id = $3::uuid`,
      [id, ctx.tenantId, current.companyId],
    );
    await insertFees(ctx, id, current.companyId, input.fees);
  }

  await recalcTotals(ctx, id);
  return getSalesOrder(ctx, id);
}

/** 取消销售单：只改状态、不物理删除（D21 / D47）。 */
export async function cancelSalesOrder(
  ctx: SalesOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<SalesOrder | null> {
  const current = await loadSalesOrderState(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '销售单版本与 If-Match 不一致，请重新读取后重试',
      {
        expected: expectedVersion,
        current: current.version,
      },
    );
  }

  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE sales_order
        SET status = '已取消',
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '进行中'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (result.rows.length === 0) {
    throw new AppError(
      'VERSION_CONFLICT',
      '销售单已被并发修改，请重新读取后重试',
    );
  }

  return getSalesOrder(ctx, id);
}

/** 完成态所需的行/批次快照（D72：按行均分到所引批次，末尾批次承余量）。 */
export interface SalesOrderCompletionSource {
  readonly order: SalesOrder;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly qty: string;
    readonly costFloor: string;
    readonly batchIds: readonly string[];
  }[];
}

/**
 * 读取「完成」所需数据：单头 + 行 + 引用批次。
 *
 * 只读、不开事务（由用例在 `withAudit` 的事务里调用），
 * 跨公司 / 跨租户等同不存在（D15）。
 */
export async function loadSalesOrderCompletionSource(
  ctx: SalesOrderRepoContext,
  id: string,
): Promise<SalesOrderCompletionSource | null> {
  const order = await getSalesOrder(ctx, id);
  if (!order) return null;

  const result = await ctx.tx.query<{
    line_no: number;
    qty: string;
    cost_floor: string;
    batch_ids: string[];
  }>(
    `SELECT l.line_no,
            trim_scale(l.qty) AS qty,
            trim_scale(l.cost_floor) AS cost_floor,
            COALESCE(
              array_agg(b.batch_id ORDER BY b.line_no)
                FILTER (WHERE b.batch_id IS NOT NULL),
              '{}'
            ) AS batch_ids
       FROM sales_order_line l
       LEFT JOIN sales_order_line_batch b
         ON b.order_line_id = l.id
        AND b.tenant_id = l.tenant_id
      WHERE l.order_id = $1::uuid
        AND l.tenant_id = $2
      GROUP BY l.id, l.line_no, l.qty, l.cost_floor
      ORDER BY l.line_no`,
    [id, ctx.tenantId],
  );

  return {
    order,
    lines: result.rows.map((row) => ({
      lineNo: row.line_no,
      qty: row.qty,
      costFloor: row.cost_floor,
      batchIds: row.batch_ids,
    })),
  };
}

/**
 * 完成销售单：仅「进行中」可完成（D19 三态）。
 *
 * 库存扣减与 C 草稿由用例在同一事务内调 D70 端口完成，本函数只改状态。
 */
export async function completeSalesOrder(
  ctx: SalesOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<SalesOrder | null> {
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE sales_order
        SET status = '已完成',
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '进行中'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (result.rows.length === 0) {
    const current = await loadSalesOrderState(ctx, id);
    if (!current) return null;
    if (current.version !== expectedVersion) {
      throw new AppError(
        'VERSION_CONFLICT',
        '销售单版本与 If-Match 不一致，请重新读取后重试',
        { expected: expectedVersion, current: current.version },
      );
    }
    throw new AppError(
      'VALIDATION_FAILED',
      '只有「进行中」的销售单可完成，已完成/已取消不可再次完成',
      { status: current.status },
    );
  }

  return getSalesOrder(ctx, id);
}

/**
 * E 单收款记录（D24 / D34）。
 *
 * 收款与退款共用一张只追加表；金额保持 decimal 字符串，余额由 SQL SUM 聚合。
 */

interface SalesReceiptRow {
  id: string;
  tenant_id: string;
  company_id: string;
  sales_order_id: string;
  direction: string;
  amount: string | number;
  method: string;
  occurred_at: Date | string;
  reversal_doc_id: string | null;
  remark: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const SALES_RECEIPT_COLUMNS = `r.id,
  r.tenant_id,
  r.company_id,
  r.sales_order_id,
  r.direction,
  trim_scale(r.amount) AS amount,
  r.method,
  r.occurred_at,
  r.reversal_doc_id,
  r.remark,
  r.version,
  r.created_at,
  r.updated_at`;

export type SalesReceiptInsertInput = SalesReceiptCreateInput & {
  readonly id: string;
  readonly companyId: string;
  readonly salesOrderId: string;
};

function mapSalesReceipt(row: SalesReceiptRow): SalesReceipt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    salesOrderId: row.sales_order_id,
    direction: row.direction as SalesReceipt['direction'],
    amount: decimal(row.amount),
    method: row.method as SalesReceipt['method'],
    occurredAt: toDate(row.occurred_at).toISOString(),
    reversalDocId: row.reversal_doc_id,
    remark: row.remark,
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

/** E 单收款块：按发生时间与 UUIDv7 稳定排序。 */
export async function listSalesReceipts(
  ctx: SalesOrderRepoContext,
  salesOrderId: string,
): Promise<SalesReceipt[]> {
  const result = await ctx.tx.query<SalesReceiptRow>(
    `SELECT ${SALES_RECEIPT_COLUMNS}
       FROM sales_receipt r
      WHERE r.tenant_id = $1
        AND r.company_id = ANY($2::uuid[])
        AND r.sales_order_id = $3::uuid
      ORDER BY r.occurred_at, r.id`,
    [ctx.tenantId, [...ctx.companyIds], salesOrderId],
  );
  return result.rows.map(mapSalesReceipt);
}

/** D24：收款块余额 = 收款合计 - 退款合计（退款本身已存负数）。 */
export async function getSalesReceiptBalance(
  ctx: SalesOrderRepoContext,
  salesOrderId: string,
): Promise<string> {
  const result = await ctx.tx.query<{ balance: string | number }>(
    `SELECT trim_scale(COALESCE(SUM(r.amount), 0)) AS balance
       FROM sales_receipt r
      WHERE r.tenant_id = $1
        AND r.company_id = ANY($2::uuid[])
        AND r.sales_order_id = $3::uuid`,
    [ctx.tenantId, [...ctx.companyIds], salesOrderId],
  );
  return decimal(result.rows[0]?.balance ?? '0');
}

async function getSalesReceipt(
  ctx: SalesOrderRepoContext,
  id: string,
): Promise<SalesReceipt | null> {
  const result = await ctx.tx.query<SalesReceiptRow>(
    `SELECT ${SALES_RECEIPT_COLUMNS}
       FROM sales_receipt r
      WHERE r.id = $1::uuid
        AND r.tenant_id = $2
        AND r.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  return row ? mapSalesReceipt(row) : null;
}

/** 追加收款 / 退款行；历史行不更新、不删除（D34 / D47）。 */
export async function insertSalesReceipt(
  ctx: SalesOrderRepoContext,
  input: SalesReceiptInsertInput,
): Promise<SalesReceipt> {
  await ctx.tx.query(
    `INSERT INTO sales_receipt
       (id, tenant_id, company_id, sales_order_id, direction, amount, method,
        occurred_at, reversal_doc_id, remark, version)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::amount, $7,
             $8::timestamptz, $9::uuid, $10, 1)`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.salesOrderId,
      input.direction,
      input.amount,
      input.method,
      input.occurredAt,
      input.reversalDocId ?? null,
      input.remark ?? null,
    ],
  );

  const created = await getSalesReceipt(ctx, input.id);
  if (!created) {
    throw new AppError('INTERNAL_ERROR', '收款记录创建后读取失败', {
      id: input.id,
    });
  }
  return created;
}

/**
 * R 客户退货（D36 / D40 / D47）。
 *
 * R 单与明细均只追加；商品行金额由 SQL 计算，单头应退金额按 decimal 域规范化。
 */

export interface CustomerReturnListQuery {
  readonly companyId?: string;
  readonly originalSalesOrderId?: string;
  readonly status?: CustomerReturnStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

export type CustomerReturnInsertInput = CustomerReturnCreateInput & {
  readonly id: string;
  readonly returnNo: string;
};

export interface CustomerReturnPage {
  readonly items: CustomerReturn[];
  readonly nextCursor: string | null;
}

interface CustomerReturnHeaderRow {
  id: string;
  tenant_id: string;
  company_id: string;
  return_no: string;
  original_sales_order_id: string;
  original_settlement_order_id: string | null;
  return_type: string;
  only_refund_kind: string | null;
  refund_mode: string;
  status: string;
  refund_amount: string | number;
  remark: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CustomerReturnLineRow {
  id: string;
  product_id: string;
  qty: string | number;
  unit_price: string | number;
  amount: string | number;
}

interface CustomerReturnBatchRow {
  return_line_id: string;
  batch_id: string;
}

const CUSTOMER_RETURN_HEADER_COLUMNS = `r.id,
  r.tenant_id,
  r.company_id,
  r.return_no,
  r.original_sales_order_id,
  r.original_settlement_order_id,
  r.return_type,
  r.only_refund_kind,
  r.refund_mode,
  r.status,
  trim_scale(r.refund_amount) AS refund_amount,
  r.remark,
  r.version,
  r.created_at,
  r.updated_at`;

const CUSTOMER_RETURN_LINE_COLUMNS = `l.id,
  l.product_id,
  trim_scale(l.qty) AS qty,
  trim_scale(l.unit_price) AS unit_price,
  trim_scale(l.amount) AS amount`;

function mapCustomerReturnHeader(
  row: CustomerReturnHeaderRow,
): Omit<CustomerReturn, 'lines'> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    returnNo: row.return_no,
    originalSalesOrderId: row.original_sales_order_id,
    originalSettlementOrderId: row.original_settlement_order_id,
    returnType: row.return_type as CustomerReturn['returnType'],
    onlyRefundKind: row.only_refund_kind as OnlyRefundKind | null,
    refundMode: row.refund_mode as RefundMode,
    status: row.status as CustomerReturnStatus,
    refundAmount: decimal(row.refund_amount),
    remark: row.remark,
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

function mapCustomerReturnLine(
  row: CustomerReturnLineRow,
  batchIds: readonly string[],
): CustomerReturnLine {
  return {
    productId: row.product_id,
    batchIds: [...batchIds],
    qty: decimal(row.qty),
    unitPrice: decimal(row.unit_price),
    amount: decimal(row.amount),
  };
}

async function queryCustomerReturnHeader(
  ctx: SalesOrderRepoContext,
  id: string,
): Promise<CustomerReturnHeaderRow | null> {
  const result = await ctx.tx.query<CustomerReturnHeaderRow>(
    `SELECT ${CUSTOMER_RETURN_HEADER_COLUMNS}
       FROM customer_return r
      WHERE r.id = $1::uuid
        AND r.tenant_id = $2
        AND r.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  return result.rows[0] ?? null;
}

async function queryCustomerReturnLines(
  ctx: SalesOrderRepoContext,
  returnIds: readonly string[],
): Promise<Map<string, CustomerReturnLine[]>> {
  const grouped = new Map<string, CustomerReturnLine[]>();
  if (returnIds.length === 0) return grouped;

  const [lineResult, batchResult] = await Promise.all([
    ctx.tx.query<CustomerReturnLineRow & { return_id: string }>(
      `SELECT l.return_id,
              ${CUSTOMER_RETURN_LINE_COLUMNS}
         FROM customer_return_line l
        WHERE l.tenant_id = $1
          AND l.return_id = ANY($2::uuid[])
        ORDER BY l.return_id, l.line_no`,
      [ctx.tenantId, [...returnIds]],
    ),
    ctx.tx.query<CustomerReturnBatchRow>(
      `SELECT b.return_line_id, b.batch_id
         FROM customer_return_line_batch b
         JOIN customer_return_line l
           ON l.id = b.return_line_id
          AND l.tenant_id = b.tenant_id
        WHERE b.tenant_id = $1
          AND b.return_id = ANY($2::uuid[])
        ORDER BY b.return_line_id, b.line_no`,
      [ctx.tenantId, [...returnIds]],
    ),
  ]);

  const batchesByLine = new Map<string, string[]>();
  for (const row of batchResult.rows) {
    const ids = batchesByLine.get(row.return_line_id) ?? [];
    ids.push(row.batch_id);
    batchesByLine.set(row.return_line_id, ids);
  }

  for (const row of lineResult.rows) {
    const list = grouped.get(row.return_id) ?? [];
    list.push(mapCustomerReturnLine(row, batchesByLine.get(row.id) ?? []));
    grouped.set(row.return_id, list);
  }
  return grouped;
}

/** R 客户退货列表：租户 + 可见公司内过滤，按 UUIDv7 id 倒序分页。 */
export async function listCustomerReturns(
  ctx: SalesOrderRepoContext,
  query: CustomerReturnListQuery,
): Promise<CustomerReturnPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = [
    'r.tenant_id = $1',
    'r.company_id = ANY($2::uuid[])',
  ];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`r.company_id = $${params.length}::uuid`);
  }
  if (query.originalSalesOrderId !== undefined) {
    params.push(query.originalSalesOrderId);
    where.push(`r.original_sales_order_id = $${params.length}::uuid`);
  }
  if (query.status !== undefined) {
    params.push(query.status);
    where.push(`r.status = $${params.length}`);
  }
  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    where.push(`r.return_no ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`r.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);
  const result = await ctx.tx.query<CustomerReturnHeaderRow>(
    `SELECT ${CUSTOMER_RETURN_HEADER_COLUMNS}
       FROM customer_return r
      WHERE ${where.join('\n        AND ')}
      ORDER BY r.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const linesByReturn = await queryCustomerReturnLines(
    ctx,
    pageRows.map((row) => row.id),
  );
  const items = pageRows.map((row) => ({
    ...mapCustomerReturnHeader(row),
    lines: linesByReturn.get(row.id) ?? [],
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

/** R 客户退货详情：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getCustomerReturn(
  ctx: SalesOrderRepoContext,
  id: string,
): Promise<CustomerReturn | null> {
  const row = await queryCustomerReturnHeader(ctx, id);
  if (!row) return null;
  const linesByReturn = await queryCustomerReturnLines(ctx, [id]);
  return {
    ...mapCustomerReturnHeader(row),
    lines: linesByReturn.get(id) ?? [],
  };
}

export async function completeCustomerReturn(ctx: SalesOrderRepoContext, id: string, expectedVersion: number): Promise<CustomerReturn | null> {
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE customer_return SET status = '已完成', version = version + 1
      WHERE id = $1::uuid AND tenant_id = $2 AND company_id = ANY($3::uuid[])
        AND version = $4 AND status = '进行中' RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (result.rows.length === 0) throw new AppError('VERSION_CONFLICT', '客户退货单已被并发修改或不是进行中状态');
  return getCustomerReturn(ctx, id);
}

/** D47：客户退货录入 / 审批人限定老板、经理、财务岗位（老板标识同时短路）。 */
export async function hasCustomerReturnApprovalPosition(
  ctx: SalesOrderRepoContext,
  employeeId: string,
  companyId: string,
): Promise<boolean> {
  const result = await ctx.tx.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM employee e
        WHERE e.id = $1::uuid
          AND e.tenant_id = $2
          AND e.status = '在职'
          AND (
            e.is_owner
            OR EXISTS (
              SELECT 1
                FROM employee_company_position ecp
                JOIN position p
                  ON p.id = ecp.position_id
                 AND p.tenant_id = ecp.tenant_id
               WHERE ecp.tenant_id = $2
                 AND ecp.employee_id = e.id
                 AND ecp.company_id = $3::uuid
                 AND p.status = '启用'
                 AND p.preset_key IN ('owner', 'manager', 'finance')
            )
          )
     ) AS allowed`,
    [employeeId, ctx.tenantId, companyId],
  );
  return result.rows[0]?.allowed === true;
}

async function assertOriginalSalesOrder(
  ctx: SalesOrderRepoContext,
  originalSalesOrderId: string,
  companyId: string,
): Promise<void> {
  const result = await ctx.tx.query<{ id: string }>(
    `SELECT id
       FROM sales_order
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid`,
    [originalSalesOrderId, ctx.tenantId, companyId],
  );
  if (result.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', '原销售单不存在或不属于本公司', {
      originalSalesOrderId,
      companyId,
    });
  }
}

async function assertCustomerReturnProducts(
  ctx: SalesOrderRepoContext,
  productIds: readonly string[],
  companyId: string,
): Promise<void> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return;
  const result = await ctx.tx.query<{ id: string }>(
    `SELECT id
       FROM product
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [ctx.tenantId, companyId, unique],
  );
  const found = new Set(result.rows.map((row) => row.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError('VALIDATION_FAILED', '商品不存在或不属于客户退货公司', {
      productIds: missing,
      companyId,
    });
  }
}

async function assertCustomerReturnBatches(
  ctx: SalesOrderRepoContext,
  input: CustomerReturnCreateInput,
): Promise<void> {
  const lines = input.lines ?? [];
  const batchIds = [...new Set(lines.flatMap((line) => line.batchIds))];
  if (batchIds.length === 0) return;

  const result = await ctx.tx.query<{ id: string; product_id: string }>(
    `SELECT id, product_id
       FROM inventory_batch
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [ctx.tenantId, input.companyId, batchIds],
  );
  const productByBatch = new Map(
    result.rows.map((row) => [row.id, row.product_id]),
  );
  const missing = batchIds.filter((id) => !productByBatch.has(id));
  if (missing.length > 0) {
    throw new AppError('VALIDATION_FAILED', '批次不存在或不属于客户退货公司', {
      batchIds: missing,
      companyId: input.companyId,
    });
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

async function normalizeCustomerReturnRefund(
  ctx: SalesOrderRepoContext,
  refundAmount: string,
): Promise<string> {
  const result = await ctx.tx.query<{
    refund_amount: string | number;
    positive: boolean;
  }>(
    `SELECT trim_scale($1::amount) AS refund_amount,
            COALESCE($1::amount > 0, false) AS positive`,
    [refundAmount],
  );
  const row = result.rows[0];
  if (!row?.positive) {
    throw new AppError('VALIDATION_FAILED', '退款金额必须大于 0（D40）');
  }
  return decimal(row.refund_amount);
}

/**
 * 新增 R 客户退货：客户端行金额不落库，统一按 qty × unit_price 由 SQL 计算。
 */
export async function insertCustomerReturn(
  ctx: SalesOrderRepoContext,
  input: CustomerReturnInsertInput,
): Promise<CustomerReturn> {
  await assertOriginalSalesOrder(
    ctx,
    input.originalSalesOrderId,
    input.companyId,
  );
  const lines = input.lines ?? [];
  await assertCustomerReturnProducts(
    ctx,
    lines.map((line) => line.productId),
    input.companyId,
  );
  await assertCustomerReturnBatches(ctx, input);
  const refundAmount = await normalizeCustomerReturnRefund(
    ctx,
    input.refundAmount,
  );

  await ctx.tx.query(
    `INSERT INTO customer_return
       (id, tenant_id, company_id, return_no, original_sales_order_id,
        original_settlement_order_id, return_type, only_refund_kind,
        refund_mode, status, refund_amount, remark, version)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8,
             $9, '进行中', $10::amount, NULL, 1)`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.returnNo,
      input.originalSalesOrderId,
      input.originalSettlementOrderId ?? null,
      input.returnType,
      input.onlyRefundKind ?? null,
      input.refundMode,
      refundAmount,
    ],
  );

  for (const [index, line] of lines.entries()) {
    const lineId = uuidv7();
    await ctx.tx.query(
      `INSERT INTO customer_return_line
         (id, tenant_id, company_id, return_id, line_no, product_id,
          qty, unit_price, amount)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::uuid,
               $7::amount, $8::amount, ($7::amount * $8::amount))`,
      [
        lineId,
        ctx.tenantId,
        input.companyId,
        input.id,
        index + 1,
        line.productId,
        line.qty,
        line.unitPrice,
      ],
    );
    for (const [batchIndex, batchId] of line.batchIds.entries()) {
      await ctx.tx.query(
        `INSERT INTO customer_return_line_batch
           (id, tenant_id, company_id, return_id, return_line_id, line_no, batch_id)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid)`,
        [
          uuidv7(),
          ctx.tenantId,
          input.companyId,
          input.id,
          lineId,
          batchIndex + 1,
          batchId,
        ],
      );
    }
  }

  const created = await getCustomerReturn(ctx, input.id);
  if (!created) {
    throw new AppError('INTERNAL_ERROR', '客户退货创建后读取失败', {
      id: input.id,
    });
  }
  return created;
}
