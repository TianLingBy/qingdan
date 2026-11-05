import {
  AppError,
  encodeCursor,
  type CursorPayload,
  type PurchaseOrder,
  type PurchaseOrderCreateInput,
  type PurchaseOrderFee,
  type PurchaseOrderLine,
  type PurchaseOrderStatus,
  type PurchaseOrderUpdateInput,
} from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 采购单 A 数据访问层（D15 / D16 / D21 / D39 / D54）。
 *
 * - 隔离：所有查询都带 `tenant_id` + `company_id = ANY(可见公司集合)`，跨公司行等同不存在；
 * - 金额：全部保持 decimal 字符串，累加一律交给 SQL（SUM），本层不做浮点运算；
 * - 明细金额：`amount = qty × unit_price` 由 INSERT 的 SQL 表达式计算（契约 §5.1）；
 * - 写：版本不匹配抛 `VERSION_CONFLICT`，查不到返回 `null`（由用例映射 404）；
 * - 取消：不物理删除（D21 / D47），只改状态；下游判定按库存流水的来源单据反查。
 *
 * repo 只接收调用方已开好的事务（`tx`）：create / update / cancel 需要与审计同事务（D51）。
 */

export interface PurchaseOrderRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface PurchaseOrderListQuery {
  readonly companyId?: string;
  readonly supplierId?: string;
  readonly status?: PurchaseOrderStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 创建输入 = 契约创建体 + 用例生成的 uuid / 单号（审计需要提前知道 objectId）。 */
export type PurchaseOrderInsertInput = PurchaseOrderCreateInput & {
  readonly id: string;
  readonly orderNo: string;
};

export interface PurchaseOrderPage {
  readonly items: PurchaseOrder[];
  readonly nextCursor: string | null;
}

/** 修改 / 取消前读取的最小状态（含可见公司内的归属公司）。 */
export interface PurchaseOrderState {
  readonly id: string;
  readonly companyId: string;
  readonly status: PurchaseOrderStatus;
  readonly version: number;
}

interface HeaderRow {
  id: string;
  tenant_id: string;
  company_id: string;
  order_no: string;
  supplier_id: string;
  supplier_name: string;
  status: string;
  handler_id: string;
  goods_amount: string | number;
  fee_amount: string | number;
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
  id: string;
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

/**
 * 单头查询列：金额用 `trim_scale` 输出最短 decimal 字符串
 * （契约只要求最多 6 位小数，不要求补零）。
 * supplierName 只读回显，与单头同租户同公司。
 */
const HEADER_COLUMNS = `o.id,
  o.tenant_id,
  o.company_id,
  o.order_no,
  o.supplier_id,
  s.name AS supplier_name,
  o.status,
  o.handler_id,
  trim_scale(o.goods_amount) AS goods_amount,
  trim_scale(o.fee_amount) AS fee_amount,
  trim_scale(o.total_amount) AS total_amount,
  o.version,
  o.created_at,
  o.updated_at`;

const HEADER_FROM = `purchase_order o
  JOIN supplier s
    ON s.id = o.supplier_id
   AND s.tenant_id = o.tenant_id
   AND s.company_id = o.company_id`;

const LINE_COLUMNS = `l.id,
  l.product_id,
  trim_scale(l.qty) AS qty,
  trim_scale(l.unit_price) AS unit_price,
  trim_scale(l.amount) AS amount`;

const FEE_COLUMNS = `f.id,
  f.fee_name,
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

function mapLine(row: LineRow): PurchaseOrderLine {
  return {
    productId: row.product_id,
    qty: decimal(row.qty),
    unitPrice: decimal(row.unit_price),
    amount: decimal(row.amount),
  };
}

function mapFee(row: FeeRow): PurchaseOrderFee {
  return {
    feeName: row.fee_name,
    qty: decimal(row.qty),
    unitPrice: decimal(row.unit_price),
    amount: decimal(row.amount),
    remark: row.remark,
  };
}

function mapHeader(row: HeaderRow): Omit<PurchaseOrder, 'lines' | 'fees'> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    orderNo: row.order_no,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    status: row.status as PurchaseOrderStatus,
    handlerId: row.handler_id,
    goodsAmount: decimal(row.goods_amount),
    feeAmount: decimal(row.fee_amount),
    totalAmount: decimal(row.total_amount),
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

/** LIKE / ILIKE 模式串：转义用户输入里的 `\`、`%`、`_`，避免把关键词当通配符。 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

async function queryHeader(
  ctx: PurchaseOrderRepoContext,
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
  ctx: PurchaseOrderRepoContext,
  orderIds: readonly string[],
): Promise<Map<string, PurchaseOrderLine[]>> {
  const grouped = new Map<string, PurchaseOrderLine[]>();
  if (orderIds.length === 0) return grouped;

  const result = await ctx.tx.query<LineRow & { order_id: string }>(
    `SELECT l.order_id,
            ${LINE_COLUMNS}
       FROM purchase_order_line l
      WHERE l.tenant_id = $1
        AND l.order_id = ANY($2::uuid[])
      ORDER BY l.order_id, l.line_no`,
    [ctx.tenantId, [...orderIds]],
  );
  for (const row of result.rows) {
    const list = grouped.get(row.order_id) ?? [];
    list.push(mapLine(row));
    grouped.set(row.order_id, list);
  }
  return grouped;
}

async function queryFees(
  ctx: PurchaseOrderRepoContext,
  orderIds: readonly string[],
): Promise<Map<string, PurchaseOrderFee[]>> {
  const grouped = new Map<string, PurchaseOrderFee[]>();
  if (orderIds.length === 0) return grouped;

  const result = await ctx.tx.query<FeeRow & { order_id: string }>(
    `SELECT f.order_id,
            ${FEE_COLUMNS}
       FROM purchase_order_fee f
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

/**
 * 采购单列表：租户 + 可见公司内，按公司 / 供应商 / 状态 / 关键字（单号或供应商名）过滤，
 * 按 uuidv7 `id DESC` 做 keyset 分页（与 masterdata / inventory 一致）。
 * 显式点不可见公司时返回空列表（范围过滤优先，不越权也不报错）。
 */
export async function listPurchaseOrders(
  ctx: PurchaseOrderRepoContext,
  query: PurchaseOrderListQuery,
): Promise<PurchaseOrderPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['o.tenant_id = $1', 'o.company_id = ANY($2::uuid[])'];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`o.company_id = $${params.length}::uuid`);
  }
  if (query.supplierId !== undefined) {
    params.push(query.supplierId);
    where.push(`o.supplier_id = $${params.length}::uuid`);
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
      OR s.name ILIKE ${keywordParam} ESCAPE '\\'
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
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/** 采购单详情：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getPurchaseOrder(
  ctx: PurchaseOrderRepoContext,
  id: string,
): Promise<PurchaseOrder | null> {
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
export async function loadPurchaseOrderState(
  ctx: PurchaseOrderRepoContext,
  id: string,
): Promise<PurchaseOrderState | null> {
  const result = await ctx.tx.query<StateRow>(
    `SELECT id, company_id, status, version
       FROM purchase_order
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
    status: row.status as PurchaseOrderStatus,
    version: row.version,
  };
}

/**
 * 直接下游判定（D21）：库存流水以 A 单为来源即视为下游已发生。
 *
 * 本批不实现「完成 / 入库」，所以正常情况下恒为 false；保留查询是为了
 * 后续 inventory 入库落地后，取消能自动按 D21 拦住下游。
 */
export async function hasDirectDownstream(
  ctx: PurchaseOrderRepoContext,
  state: PurchaseOrderState,
): Promise<boolean> {
  const result = await ctx.tx.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM inventory_flow f
        WHERE f.tenant_id = $1
          AND f.company_id = $2::uuid
          AND f.source_doc_id = $3::uuid
          AND f.source_doc_type IN ('A', 'purchase_order')
     ) AS exists`,
    [ctx.tenantId, state.companyId, state.id],
  );
  return result.rows[0]?.exists === true;
}

/** 供应商必须存在、启用状态不限，但必须与单头同公司（D15）。 */
async function assertSupplierInCompany(
  ctx: PurchaseOrderRepoContext,
  supplierId: string,
  companyId: string,
): Promise<void> {
  const result = await ctx.tx.query(
    `SELECT 1 FROM supplier
      WHERE id = $1::uuid AND tenant_id = $2 AND company_id = $3::uuid`,
    [supplierId, ctx.tenantId, companyId],
  );
  if (result.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', '供应商不存在或不属于该采购单的公司', {
      supplierId,
      companyId,
    });
  }
}

/**
 * 商品明细必须属于采购单所在公司（D15）：跨公司引用等同不存在，直接拒绝。
 * 去重后一次查询，避免逐行往返。
 */
async function assertProductsInCompany(
  ctx: PurchaseOrderRepoContext,
  productIds: readonly string[],
  companyId: string,
): Promise<void> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return;

  const result = await ctx.tx.query<{ id: string }>(
    `SELECT id FROM product
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [ctx.tenantId, companyId, unique],
  );
  const found = new Set(result.rows.map((row) => row.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError('VALIDATION_FAILED', '商品不存在或不属于该采购单的公司', {
      productIds: missing,
      companyId,
    });
  }
}

/** 经手人必须存在且属于同一租户。 */
async function assertHandlerInTenant(
  ctx: PurchaseOrderRepoContext,
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

async function insertLines(
  ctx: PurchaseOrderRepoContext,
  orderId: string,
  companyId: string,
  lines: readonly PurchaseOrderLine[],
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    await ctx.tx.query(
      `INSERT INTO purchase_order_line
         (id, tenant_id, company_id, order_id, line_no, product_id, qty, unit_price, amount)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::uuid,
               $7::amount, $8::amount, ($7::amount * $8::amount))`,
      [
        uuidv7(),
        ctx.tenantId,
        companyId,
        orderId,
        index + 1,
        line.productId,
        line.qty,
        line.unitPrice,
      ],
    );
  }
}

async function insertFees(
  ctx: PurchaseOrderRepoContext,
  orderId: string,
  companyId: string,
  fees: PurchaseOrderInsertInput['fees'],
): Promise<void> {
  for (const [index, fee] of (fees ?? []).entries()) {
    await ctx.tx.query(
      `INSERT INTO purchase_order_fee
         (id, tenant_id, company_id, order_id, line_no, fee_name, qty, unit_price, amount, remark)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7::amount, $8::amount, $9::amount, $10)`,
      [
        uuidv7(),
        ctx.tenantId,
        companyId,
        orderId,
        index + 1,
        fee.feeName,
        fee.qty,
        fee.unitPrice,
        fee.amount,
        fee.remark ?? null,
      ],
    );
  }
}

/**
 * 汇总单头金额：全部交给 SQL 聚合，应用侧不出现浮点。
 * 货款 = 商品明细合计；费用合计可为负（D39）；总金额 = 货款 + 费用合计。
 */
async function recalcTotals(ctx: PurchaseOrderRepoContext, orderId: string): Promise<void> {
  await ctx.tx.query(
    `UPDATE purchase_order o
        SET goods_amount = COALESCE(
              (SELECT SUM(l.amount) FROM purchase_order_line l WHERE l.order_id = o.id), 0
            ),
            fee_amount = COALESCE(
              (SELECT SUM(f.amount) FROM purchase_order_fee f WHERE f.order_id = o.id), 0
            ),
            total_amount = COALESCE(
              (SELECT SUM(l.amount) FROM purchase_order_line l WHERE l.order_id = o.id), 0
            ) + COALESCE(
              (SELECT SUM(f.amount) FROM purchase_order_fee f WHERE f.order_id = o.id), 0
            )
      WHERE o.id = $1::uuid
        AND o.tenant_id = $2`,
    [orderId, ctx.tenantId],
  );
}

/** 新增采购单：`id` / `orderNo` 由用例生成（同事务审计要先拿到 objectId）。 */
export async function insertPurchaseOrder(
  ctx: PurchaseOrderRepoContext,
  input: PurchaseOrderInsertInput,
): Promise<PurchaseOrder> {
  await assertSupplierInCompany(ctx, input.supplierId, input.companyId);
  await assertHandlerInTenant(ctx, input.handlerId);

  await ctx.tx.query(
    `INSERT INTO purchase_order
       (id, tenant_id, company_id, order_no, supplier_id, handler_id, status)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, '进行中')`,
    [input.id, ctx.tenantId, input.companyId, input.orderNo, input.supplierId, input.handlerId],
  );
  await insertLines(ctx, input.id, input.companyId, input.lines);
  await insertFees(ctx, input.id, input.companyId, input.fees);
  await recalcTotals(ctx, input.id);

  const created = await getPurchaseOrder(ctx, input.id);
  if (!created) {
    throw new AppError('INTERNAL_ERROR', '采购单创建后读取失败', { id: input.id });
  }
  return created;
}

/**
 * 修改采购单：只有「进行中」可改（D4 状态机），并校验强 ETag 版本。
 * 查不到（含跨公司）→ null；版本不匹配 / 并发抢先 → `VERSION_CONFLICT`。
 */
export async function updatePurchaseOrder(
  ctx: PurchaseOrderRepoContext,
  id: string,
  input: PurchaseOrderUpdateInput,
  expectedVersion: number,
): Promise<PurchaseOrder | null> {
  const current = await loadPurchaseOrderState(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '采购单版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }
  if (current.status !== '进行中') {
    throw new AppError('VALIDATION_FAILED', '只有「进行中」的采购单可修改，错账请走冲正单据', {
      status: current.status,
    });
  }

  if (input.supplierId !== undefined) {
    await assertSupplierInCompany(ctx, input.supplierId, current.companyId);
  }
  if (input.handlerId !== undefined) {
    await assertHandlerInTenant(ctx, input.handlerId);
  }

  const updated = await ctx.tx.query<{ id: string }>(
    `UPDATE purchase_order
        SET supplier_id = COALESCE($4::uuid, supplier_id),
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
      input.supplierId ?? null,
      input.handlerId ?? null,
      expectedVersion,
    ],
  );
  if (updated.rows.length === 0) {
    // 读取后到 UPDATE 之间被并发改过版本 / 状态。
    throw new AppError('VERSION_CONFLICT', '采购单已被并发修改，请重新读取后重试');
  }

  if (input.lines !== undefined) {
    await ctx.tx.query(
      `DELETE FROM purchase_order_line WHERE order_id = $1::uuid AND tenant_id = $2`,
      [id, ctx.tenantId],
    );
    await insertLines(ctx, id, current.companyId, input.lines);
  }
  if (input.fees !== undefined) {
    await ctx.tx.query(
      `DELETE FROM purchase_order_fee WHERE order_id = $1::uuid AND tenant_id = $2`,
      [id, ctx.tenantId],
    );
    await insertFees(ctx, id, current.companyId, input.fees);
  }

  await recalcTotals(ctx, id);
  return getPurchaseOrder(ctx, id);
}

/**
 * 取消采购单：只改状态、不物理删除（D21 / D47）。
 * 查不到（含跨公司）→ null；版本不匹配 / 并发抢先 → `VERSION_CONFLICT`。
 */
export async function cancelPurchaseOrder(
  ctx: PurchaseOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<PurchaseOrder | null> {
  const current = await loadPurchaseOrderState(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '采购单版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }

  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE purchase_order
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
    throw new AppError('VERSION_CONFLICT', '采购单已被并发修改，请重新读取后重试');
  }

  return getPurchaseOrder(ctx, id);
}
