import {
  AppError,
  encodeCursor,
  resolvePaging,
  type CursorPayload,
  type PurchaseOrder,
  type PurchaseOrderCreateInput,
  type PurchaseOrderFee,
  type PurchaseOrderLine,
  type PurchaseOrderShipLine,
  type PurchaseOrderStatus,
  type PurchaseOrderUpdateInput,
  type SupplierReturn,
  type SupplierReturnCreateInput,
  type SupplierReturnLine,
  type SupplierReturnStatus,
  type SortOrder,
} from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../platform/db/client.js';
import { buildOrderBy } from '../../platform/db/order-by.js';

/**
 * 采购单 A 数据访问层（D15 / D16 / D21 / D39 / D54）。
 *
 * - 隔离：所有查询都带 `tenant_id` + `company_id = ANY(可见公司集合)`，跨公司行等同不存在；
 * - 金额：全部保持 decimal 字符串，累加一律交给 SQL（SUM），本层不做浮点运算；
 * - 明细金额：S 退货款按批次锁价由服务端算（D105），其余单据 `amount = qty × unit_price` 由 INSERT 的 SQL 表达式计算（契约 §5.1）；
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
  /** 按对接人筛（#368）。 */
  readonly supplierContactId?: string;
  readonly status?: PurchaseOrderStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  /** 省略表示调用方没传 limit——由 resolvePaging 决定是游标默认 50 还是页码默认 20。 */
  readonly limit?: number;
  /** 页码模式（D95）：与 cursor 互斥，同时给由 resolvePaging 抛 422。 */
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: PurchaseOrderSortKey;
  readonly order?: SortOrder;
}

/** 排序白名单（与契约 `PurchaseOrderListQuerySchema.sort` 一一对应，列名核对自 0010 建表语句）。 */
export type PurchaseOrderSortKey = 'orderNo' | 'totalAmount' | 'createdAt';

/** 创建输入 = 契约创建体 + 用例生成的 uuid / 单号（审计需要提前知道 objectId）。 */
/** `supplierId` 由用例解析后必填（D100，同 E 单的 `customerId`）。 */
export type PurchaseOrderInsertInput = Omit<
  PurchaseOrderCreateInput,
  'supplierId' | 'supplierDraft'
> & {
  readonly supplierId: string;
  readonly id: string;
  readonly orderNo: string;
};

export interface PurchaseOrderPage {
  readonly items: PurchaseOrder[];
  /** 页码模式下的总条数；游标模式恒为 null（老调用方不读这几个字段）。 */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number | null;
  readonly nextCursor: string | null;
}

export interface SupplierReturnListQuery {
  readonly companyId?: string;
  readonly originalPurchaseOrderId?: string;
  readonly status?: SupplierReturnStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

export type SupplierReturnInsertInput = SupplierReturnCreateInput & {
  readonly id: string;
  readonly returnNo: string;
};

export interface SupplierReturnPage {
  readonly items: SupplierReturn[];
  readonly nextCursor: string | null;
}

/** 修改 / 取消前读取的最小状态（含可见公司内的归属公司）。 */
export interface PurchaseOrderState {
  readonly id: string;
  readonly companyId: string;
  /** 单头供应商：改单换对接人时要拿它校验「同供应商」（#306）。 */
  readonly supplierId: string;
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
  /** 下单对接人（#306）：可空；停用后名字仍回（LEFT JOIN 保留历史可读）。 */
  supplier_contact_id: string | null;
  supplier_contact_name: string | null;
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
  line_no: number;
  product_id: string;
  qty: string | number;
  unit_price: string | number;
  amount: string | number;
  transit_to: 'warehouse' | 'processor' | null;
  processor_id: string | null;
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
  supplier_id: string;
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
  o.supplier_contact_id,
  k.name AS supplier_contact_name,
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
   AND s.company_id = o.company_id
  LEFT JOIN supplier_contact k
    ON k.id = o.supplier_contact_id
   AND k.tenant_id = o.tenant_id
   AND k.company_id = o.company_id`;

const LINE_COLUMNS = `l.id,
  l.line_no,
  l.product_id,
  trim_scale(l.qty) AS qty,
  trim_scale(l.unit_price) AS unit_price,
  trim_scale(l.amount) AS amount,
  l.transit_to,
  l.processor_id`;

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

function mapLine(row: LineRow): PurchaseOrder['lines'][number] {
  return {
    // 行号必须回给前端：发货入参按它定位行（`PurchaseOrderShipInputSchema`），
    // 前端拿不到就只能用数组下标，并发改单后会指错行。
    lineNo: row.line_no,
    productId: row.product_id,
    qty: decimal(row.qty),
    unitPrice: decimal(row.unit_price),
    amount: decimal(row.amount),
    ...(row.transit_to === null ? {} : { transitTo: row.transit_to }),
    ...(row.processor_id === null ? {} : { processorId: row.processor_id }),
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
    supplierContactId: row.supplier_contact_id,
    supplierContactName: row.supplier_contact_name,
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
): Promise<Map<string, PurchaseOrder['lines'][number][]>> {
  const grouped = new Map<string, PurchaseOrder['lines'][number][]>();
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
  // 按对接人筛（#368）：老单据的 supplier_contact_id 是 NULL，等值比较不命中。
  if (query.supplierContactId !== undefined) {
    params.push(query.supplierContactId);
    where.push(`o.supplier_contact_id = $${params.length}::uuid`);
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
  const paging = resolvePaging({
    // resolvePaging 只看「有没有 cursor」这一个事实，解码后的 id 就够当凭据。
    cursor: query.cursor === undefined ? undefined : query.cursor.id,
    limit: query.limit,
    page: query.page,
    pageSize: query.pageSize,
  });
  if (paging.mode === 'cursor' && query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`o.id < $${params.length}::uuid`);
  }

  const orderBy = buildOrderBy(COLUMN_MAP, query.sort, query.order, 'o.id', 'id');
  const whereSql = where.join('\n        AND ');
  const selectSql = `SELECT ${HEADER_COLUMNS}
       FROM ${HEADER_FROM}
      WHERE ${whereSql}`;

  if (paging.mode === 'offset') {
    params.push(paging.limit, paging.offset);
    const result = await ctx.tx.query<HeaderRow>(
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
      `SELECT COUNT(*) AS n FROM ${HEADER_FROM} WHERE ${whereSql}`,
      params.slice(0, -2),
    );
    const items = await assemblePurchaseOrders(ctx, result.rows);
    return {
      items,
      total: Number(countResult.rows[0]!.n),
      page: paging.page,
      pageSize: paging.limit,
      nextCursor: null,
    };
  }

  params.push(paging.limit + 1);
  const result = await ctx.tx.query<HeaderRow>(
    `${selectSql}
      ORDER BY ${orderBy}
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > paging.limit;
  const pageRows = hasMore ? result.rows.slice(0, paging.limit) : result.rows;
  const items = await assemblePurchaseOrders(ctx, pageRows);
  const last = items[items.length - 1];
  return {
    items,
    total: null,
    page: null,
    pageSize: null,
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/** 排序白名单：键 → 真实列。`id` 只为保住改动前的默认序（原 ORDER BY o.id DESC）。 */
const COLUMN_MAP = {
  id: 'o.id',
  orderNo: 'o.order_no',
  totalAmount: 'o.total_amount',
  createdAt: 'o.created_at',
} as const satisfies Record<string, string>;

/** 把单头行补齐商品行与费用行（两种分页模式共用）。 */
async function assemblePurchaseOrders(
  ctx: PurchaseOrderRepoContext,
  rows: HeaderRow[],
): Promise<PurchaseOrder[]> {
  const ids = rows.map((row) => row.id);
  const [linesByOrder, feesByOrder] = await Promise.all([
    queryLines(ctx, ids),
    queryFees(ctx, ids),
  ]);
  return rows.map((row) => ({
    ...mapHeader(row),
    lines: linesByOrder.get(row.id) ?? [],
    fees: feesByOrder.get(row.id) ?? [],
  }));
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
    `SELECT id, company_id, supplier_id, status, version
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
    supplierId: row.supplier_id,
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
 * 下单对接人校验（#306）：必须**同供应商 + 同公司 + 启用**，否则 422。
 * 三条一起查（任一条不满足都是同一个用户错误），`details.field` 指回入参名。
 */
async function assertSupplierContactUsable(
  ctx: PurchaseOrderRepoContext,
  contactId: string,
  supplierId: string,
  companyId: string,
): Promise<void> {
  const result = await ctx.tx.query(
    `SELECT 1
       FROM supplier_contact
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid
        AND supplier_id = $4::uuid
        AND status = '启用'`,
    [contactId, ctx.tenantId, companyId, supplierId],
  );
  if (result.rows.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      '对接人不存在、不属于该供应商、跨公司或已停用',
      { field: 'supplierContactId', supplierContactId: contactId },
    );
  }
}

/**
 * 商品明细必须属于采购单所在公司（D15）：跨公司引用等同不存在，直接拒绝。
 * 去重后一次查询，避免逐行往返；开单与改单共用同一条校验，两条写入路径不得只补一条。
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

export async function assertProcessorsInCompany(
  ctx: PurchaseOrderRepoContext,
  processorIds: readonly string[],
  companyId: string,
): Promise<void> {
  const unique = [...new Set(processorIds)];
  if (unique.length === 0) return;
  const result = await ctx.tx.query<{ id: string }>(
    `SELECT id FROM processor
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [ctx.tenantId, companyId, unique],
  );
  const found = new Set(result.rows.map((row) => row.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError('VALIDATION_FAILED', '加工厂不存在或不属于该采购单的公司', {
      processorIds: missing,
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
         (id, tenant_id, company_id, order_id, line_no, product_id, qty, unit_price, amount,
          transit_to, processor_id)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::uuid,
               $7::amount, $8::amount, ($7::amount * $8::amount), $9, $10::uuid)`,
      [
        uuidv7(),
        ctx.tenantId,
        companyId,
        orderId,
        index + 1,
        line.productId,
        line.qty,
        line.unitPrice,
        line.transitTo ?? null,
        line.processorId ?? null,
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
 * 货款 = 商品明细合计；费用合计不得为负（D83）；总金额 = 货款 + 费用合计。
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
  if (input.supplierContactId !== undefined) {
    await assertSupplierContactUsable(
      ctx,
      input.supplierContactId,
      input.supplierId,
      input.companyId,
    );
  }
  await assertProductsInCompany(
    ctx,
    input.lines.map((line) => line.productId),
    input.companyId,
  );
  await assertProcessorsInCompany(
    ctx,
    input.lines.flatMap((line) => (line.processorId ? [line.processorId] : [])),
    input.companyId,
  );

  await ctx.tx.query(
    `INSERT INTO purchase_order
       (id, tenant_id, company_id, order_no, supplier_id, supplier_contact_id,
        handler_id, status)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, $7::uuid, '进行中')`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.orderNo,
      input.supplierId,
      input.supplierContactId ?? null,
      input.handlerId,
    ],
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
  /**
   * 对接人三态（#306）：传值=换人、传 null=清空、未传=不动；换供应商未指定对接人时清空。
   */
  const nextContactId =
    input.supplierContactId !== undefined
      ? input.supplierContactId
      : input.supplierId !== undefined && input.supplierId !== current.supplierId
        ? null
        : undefined;
  if (typeof nextContactId === 'string') {
    await assertSupplierContactUsable(
      ctx,
      nextContactId,
      input.supplierId ?? current.supplierId,
      current.companyId,
    );
  }
  if (input.lines !== undefined) {
    // D15：改单换明细同样不得引用他公司商品；校验放在任何写入之前，失败不留半张单。
    await assertProductsInCompany(
      ctx,
      input.lines.map((line) => line.productId),
      current.companyId,
    );
    await assertProcessorsInCompany(
      ctx,
      input.lines.flatMap((line) => (line.processorId ? [line.processorId] : [])),
      current.companyId,
    );
  }

  const updated = await ctx.tx.query<{ id: string }>(
    `UPDATE purchase_order
        SET supplier_id = COALESCE($4::uuid, supplier_id),
            handler_id = COALESCE($5::uuid, handler_id),
            supplier_contact_id = CASE WHEN $7::boolean THEN $8::uuid ELSE supplier_contact_id END,
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
      nextContactId !== undefined,
      nextContactId ?? null,
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

export async function completePurchaseOrder(
  ctx: PurchaseOrderRepoContext, id: string, expectedVersion: number,
): Promise<PurchaseOrder | null> {
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE purchase_order SET status = '已完成', version = version + 1
      WHERE id = $1::uuid AND tenant_id = $2 AND company_id = ANY($3::uuid[])
        AND version = $4 AND status = '进行中' RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (result.rows.length === 0) throw new AppError('VERSION_CONFLICT', '采购单已被并发修改或不是进行中状态');
  return getPurchaseOrder(ctx, id);
}

/** 发采购单：写入每行去向并把状态从「进行中」推进到「在途」。 */
export async function shipPurchaseOrder(
  ctx: PurchaseOrderRepoContext,
  id: string,
  expectedVersion: number,
  lines: readonly PurchaseOrderShipLine[],
): Promise<PurchaseOrder | null> {
  for (const line of lines) {
    const updated = await ctx.tx.query<{ id: string }>(
      `UPDATE purchase_order_line
          SET transit_to = $1,
              processor_id = $2::uuid
        WHERE order_id = $3::uuid
          AND tenant_id = $4
          AND company_id = ANY($5::uuid[])
          AND line_no = $6
        RETURNING id`,
      [
        line.transitTo,
        line.processorId ?? null,
        id,
        ctx.tenantId,
        [...ctx.companyIds],
        line.lineNo,
      ],
    );
    if (updated.rows.length === 0) {
      throw new AppError('VALIDATION_FAILED', '发货明细行不存在', {
        lineNo: line.lineNo,
      });
    }
  }

  const changed = await ctx.tx.query<{ id: string }>(
    `UPDATE purchase_order
        SET status = '在途',
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '进行中'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (changed.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '采购单已被并发修改或不是进行中状态');
  }
  return getPurchaseOrder(ctx, id);
}

/** 撤销采购发货：在途 → 进行中，并清空行级去向。 */
export async function revokePurchaseOrderShip(
  ctx: PurchaseOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<PurchaseOrder | null> {
  await ctx.tx.query(
    `UPDATE purchase_order_line
        SET transit_to = NULL,
            processor_id = NULL
      WHERE order_id = $1::uuid
        AND tenant_id = $2`,
    [id, ctx.tenantId],
  );
  const changed = await ctx.tx.query<{ id: string }>(
    `UPDATE purchase_order
        SET status = '进行中',
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '在途'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (changed.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '采购单已被并发修改或不是在途状态');
  }
  return getPurchaseOrder(ctx, id);
}

/** 采购到货确认：在途 → 已完成；批次状态由 inventory 端口在同事务处理。 */
export async function receivePurchaseOrder(
  ctx: PurchaseOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<PurchaseOrder | null> {
  const changed = await ctx.tx.query<{ id: string }>(
    `UPDATE purchase_order
        SET status = '已完成',
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '在途'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (changed.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '采购单已被并发修改或不是在途状态');
  }
  return getPurchaseOrder(ctx, id);
}

interface SupplierReturnHeaderRow {
  id: string;
  tenant_id: string;
  company_id: string;
  return_no: string;
  original_purchase_order_id: string;
  status: string;
  refund_amount: string | number;
  remark: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SupplierReturnLineRow {
  id: string;
  product_id: string;
  qty: string | number;
  unit_price: string | number;
  amount: string | number;
}

interface SupplierReturnBatchRow {
  return_line_id: string;
  batch_id: string;
}

const SUPPLIER_RETURN_HEADER_COLUMNS = `r.id,
  r.tenant_id,
  r.company_id,
  r.return_no,
  r.original_purchase_order_id,
  r.status,
  trim_scale(r.refund_amount) AS refund_amount,
  r.remark,
  r.version,
  r.created_at,
  r.updated_at`;

const SUPPLIER_RETURN_LINE_COLUMNS = `l.id,
  l.product_id,
  trim_scale(l.qty) AS qty,
  trim_scale(l.unit_price) AS unit_price,
  trim_scale(l.amount) AS amount`;

function mapSupplierReturnHeader(
  row: SupplierReturnHeaderRow,
): Omit<SupplierReturn, 'lines'> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    returnNo: row.return_no,
    originalPurchaseOrderId: row.original_purchase_order_id,
    status: row.status as SupplierReturnStatus,
    refundAmount: decimal(row.refund_amount),
    remark: row.remark,
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

function mapSupplierReturnLine(
  row: SupplierReturnLineRow,
  batchIds: readonly string[],
): SupplierReturnLine {
  return {
    productId: row.product_id,
    batchIds: [...batchIds],
    qty: decimal(row.qty),
    unitPrice: decimal(row.unit_price),
    amount: decimal(row.amount),
  };
}

async function querySupplierReturnHeader(
  ctx: PurchaseOrderRepoContext,
  id: string,
): Promise<SupplierReturnHeaderRow | null> {
  const result = await ctx.tx.query<SupplierReturnHeaderRow>(
    `SELECT ${SUPPLIER_RETURN_HEADER_COLUMNS}
       FROM supplier_return r
      WHERE r.id = $1::uuid
        AND r.tenant_id = $2
        AND r.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  return result.rows[0] ?? null;
}

async function querySupplierReturnLines(
  ctx: PurchaseOrderRepoContext,
  returnIds: readonly string[],
): Promise<Map<string, SupplierReturnLine[]>> {
  const grouped = new Map<string, SupplierReturnLine[]>();
  if (returnIds.length === 0) return grouped;

  const [lineResult, batchResult] = await Promise.all([
    ctx.tx.query<SupplierReturnLineRow & { return_id: string }>(
      `SELECT l.return_id,
              ${SUPPLIER_RETURN_LINE_COLUMNS}
         FROM supplier_return_line l
        WHERE l.tenant_id = $1
          AND l.return_id = ANY($2::uuid[])
        ORDER BY l.return_id, l.line_no`,
      [ctx.tenantId, [...returnIds]],
    ),
    ctx.tx.query<SupplierReturnBatchRow>(
      `SELECT b.return_line_id, b.batch_id
         FROM supplier_return_line_batch b
         JOIN supplier_return_line l
           ON l.id = b.return_line_id
          AND l.tenant_id = b.tenant_id
         JOIN supplier_return r
           ON r.id = l.return_id
          AND r.tenant_id = l.tenant_id
        WHERE b.tenant_id = $1
          AND r.id = ANY($2::uuid[])
        ORDER BY b.return_line_id, b.batch_id`,
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
    list.push(mapSupplierReturnLine(row, batchesByLine.get(row.id) ?? []));
    grouped.set(row.return_id, list);
  }
  return grouped;
}

/** 供应商退货列表：租户 + 可见公司内过滤，按 UUIDv7 id 倒序分页。 */
export async function listSupplierReturns(
  ctx: PurchaseOrderRepoContext,
  query: SupplierReturnListQuery,
): Promise<SupplierReturnPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['r.tenant_id = $1', 'r.company_id = ANY($2::uuid[])'];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`r.company_id = $${params.length}::uuid`);
  }
  if (query.originalPurchaseOrderId !== undefined) {
    params.push(query.originalPurchaseOrderId);
    where.push(`r.original_purchase_order_id = $${params.length}::uuid`);
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
  const result = await ctx.tx.query<SupplierReturnHeaderRow>(
    `SELECT ${SUPPLIER_RETURN_HEADER_COLUMNS}
       FROM supplier_return r
      WHERE ${where.join('\n        AND ')}
      ORDER BY r.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const linesByReturn = await querySupplierReturnLines(
    ctx,
    pageRows.map((row) => row.id),
  );
  const items = pageRows.map((row) => ({
    ...mapSupplierReturnHeader(row),
    lines: linesByReturn.get(row.id) ?? [],
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/** 供应商退货详情：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getSupplierReturn(
  ctx: PurchaseOrderRepoContext,
  id: string,
): Promise<SupplierReturn | null> {
  const row = await querySupplierReturnHeader(ctx, id);
  if (!row) return null;
  const linesByReturn = await querySupplierReturnLines(ctx, [id]);
  return {
    ...mapSupplierReturnHeader(row),
    lines: linesByReturn.get(id) ?? [],
  };
}

export async function completeSupplierReturn(ctx: PurchaseOrderRepoContext, id: string, expectedVersion: number): Promise<SupplierReturn | null> {
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE supplier_return SET status = '已完成', version = version + 1
      WHERE id = $1::uuid AND tenant_id = $2 AND company_id = ANY($3::uuid[])
        AND version = $4 AND status = '进行中' RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (result.rows.length === 0) throw new AppError('VERSION_CONFLICT', '供应商退货单已被并发修改或不是进行中状态');
  return getSupplierReturn(ctx, id);
}

export async function cancelSupplierReturn(
  ctx: PurchaseOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<SupplierReturn | null> {
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE supplier_return
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
    throw new AppError('VERSION_CONFLICT', '供应商退货单已被并发修改或不是进行中状态');
  }
  return getSupplierReturn(ctx, id);
}

async function assertOriginalPurchaseOrder(
  ctx: PurchaseOrderRepoContext,
  originalPurchaseOrderId: string,
  companyId: string,
): Promise<void> {
  const result = await ctx.tx.query<{ id: string }>(
    `SELECT id
       FROM purchase_order
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid`,
    [originalPurchaseOrderId, ctx.tenantId, companyId],
  );
  if (result.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', '原采购单不存在或不属于本公司', {
      originalPurchaseOrderId,
      companyId,
    });
  }
}

async function assertSupplierReturnProducts(
  ctx: PurchaseOrderRepoContext,
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
    throw new AppError('VALIDATION_FAILED', '商品不存在或不属于供应商退货公司', {
      productIds: missing,
      companyId,
    });
  }
}

async function assertSupplierReturnBatches(
  ctx: PurchaseOrderRepoContext,
  input: SupplierReturnCreateInput,
): Promise<void> {
  const batchIds = [...new Set(input.lines.flatMap((line) => line.batchIds))];
  const result = await ctx.tx.query<{ id: string; product_id: string }>(
    `SELECT id, product_id
       FROM inventory_batch
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [ctx.tenantId, input.companyId, batchIds],
  );
  const productByBatch = new Map(result.rows.map((row) => [row.id, row.product_id]));
  const missing = batchIds.filter((id) => !productByBatch.has(id));
  if (missing.length > 0) {
    // 指到行：调用方要能直接告诉用户是哪一行明细要改（D105 的 422 定位口径）。
    const lineIndex = input.lines.findIndex((line) =>
      line.batchIds.some((id) => missing.includes(id)),
    );
    throw new AppError('VALIDATION_FAILED', '批次不存在或不属于供应商退货公司', {
      batchIds: missing,
      companyId: input.companyId,
      field: `lines.${lineIndex}.batchIds`,
    });
  }

  for (const line of input.lines) {
    for (const batchId of line.batchIds) {
      if (productByBatch.get(batchId) !== line.productId) {
        throw new AppError('VALIDATION_FAILED', '退货明细商品与所引批次商品不一致', {
          productId: line.productId,
          batchId,
        });
      }
    }
  }
}

interface SupplierReturnLineAmount {
  /** 该行服务端算出的金额（Σ 各批份额 × 该批锁价）。 */
  readonly amount: string;
  /** 该行的回显单价 = 金额 ÷ 数量；单批次时即该批锁价，跨批次时是加权后的展示值。 */
  readonly unitPrice: string;
}

/**
 * 退款单价一律由服务端从批次锁价得出（D105）：客户端传的 `unitPrice` 只给前端做预估，
 * 不参与金额计算——否则前端传 1 元就能把退款改成 1 元。
 *
 * 一行跨多个批次时，按「行数量均分到所引批次、余量末批承接」（与 D92 待执行占用同一口径）
 * 逐批 `份额 × 锁价` 再求和；**不取平均价**——余量落在末批、各批锁价不同时，平均价会算出
 * 另一个数。
 *
 * 锁价拿不到（批次不存在 / 不属于该公司 / `locked_unit_cost` 为 NULL）直接 422 并指到行：
 * 退款金额此时没有可信来源，兜底成 0 或客户端价等于把错账悄悄写进财务账。
 */
async function computeSupplierReturnAmounts(
  ctx: PurchaseOrderRepoContext,
  companyId: string,
  lines: readonly SupplierReturnLine[],
): Promise<{ refundAmount: string; lineAmounts: SupplierReturnLineAmount[] }> {
  // 同一行里重复引用同一批次时按一次算：金额与 qty 总量都只跟「实际涉及哪几批」有关。
  const payload = JSON.stringify(
    lines.map((line) => ({ qty: line.qty, batchIds: [...new Set(line.batchIds)] })),
  );
  const result = await ctx.tx.query<{
    line_no: number;
    amount: string | number;
    unit_price: string | number;
    refund_amount: string | number;
    positive: boolean;
    missing_cost: boolean;
  }>(
    `WITH input AS (
       SELECT ord::int AS line_no,
              (item ->> 'qty')::amount AS qty,
              item -> 'batchIds' AS batch_ids
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS t(item, ord)
     ), expanded AS (
       SELECT line_no, qty, bid, idx,
              count(*) OVER (PARTITION BY line_no) AS batch_count
         FROM input,
              LATERAL jsonb_array_elements_text(batch_ids) WITH ORDINALITY AS b(bid, idx)
     ), weighted AS (
       SELECT line_no, qty,
              CASE WHEN idx < batch_count THEN trunc(qty / batch_count, 6)
                   ELSE qty - trunc(qty / batch_count, 6) * (batch_count - 1) END AS share_qty,
              cost.locked_unit_cost
         FROM expanded
         LEFT JOIN inventory_batch cost
           ON cost.id = expanded.bid::uuid
          AND cost.tenant_id = $1
          AND cost.company_id = $2::uuid
     ), totals AS (
       SELECT line_no, qty,
              trim_scale(COALESCE(SUM(share_qty * locked_unit_cost), 0)) AS amount,
              COALESCE(bool_or(locked_unit_cost IS NULL), true) AS missing_cost
         FROM weighted
        GROUP BY line_no, qty
     )
     SELECT line_no,
            amount,
            trim_scale(CASE WHEN qty > 0 THEN round(amount / qty, 6) ELSE 0 END) AS unit_price,
            trim_scale(SUM(amount) OVER ()) AS refund_amount,
            SUM(amount) OVER () > 0 AS positive,
            missing_cost
       FROM totals
      ORDER BY line_no`,
    [ctx.tenantId, companyId, payload],
  );

  const rows = result.rows;
  const lineAmounts = lines.map((_, index) => {
    const row = rows.find((candidate) => candidate.line_no === index + 1);
    if (!row || row.missing_cost) {
      throw new AppError(
        'VALIDATION_FAILED',
        `第 ${index + 1} 行退货明细引用的批次缺少锁价，无法确定退款金额`,
        { field: `lines.${index}.batchIds`, lineNo: index + 1 },
      );
    }
    return { amount: decimal(row.amount), unitPrice: decimal(row.unit_price) };
  });
  if (!rows[0]?.positive) {
    throw new AppError('VALIDATION_FAILED', '应退金额必须大于 0（F4c）');
  }
  return { refundAmount: decimal(rows[0].refund_amount), lineAmounts };
}

/**
 * 新增供应商退货：客户端 `amount` / `refundAmount` 不落库，统一由服务端重算；
 * 单价同样以批次锁价为准，客户端 `unitPrice` 只用于前端预估（D105）。
 * 调用方必须在同一事务内先取 S 单号，并在事务成功后写审计（D16 / D51）。
 */
export async function insertSupplierReturn(
  ctx: PurchaseOrderRepoContext,
  input: SupplierReturnInsertInput,
): Promise<SupplierReturn> {
  await assertOriginalPurchaseOrder(
    ctx,
    input.originalPurchaseOrderId,
    input.companyId,
  );
  await assertSupplierReturnProducts(
    ctx,
    input.lines.map((line) => line.productId),
    input.companyId,
  );
  await assertSupplierReturnBatches(ctx, input);
  const { refundAmount, lineAmounts } = await computeSupplierReturnAmounts(
    ctx,
    input.companyId,
    input.lines,
  );

  await ctx.tx.query(
    `INSERT INTO supplier_return
       (id, tenant_id, company_id, return_no, original_purchase_order_id,
        status, refund_amount, remark, version)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, '进行中', $6::amount, NULL, 1)`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.returnNo,
      input.originalPurchaseOrderId,
      refundAmount,
    ],
  );

  for (const [index, line] of input.lines.entries()) {
    const lineId = uuidv7();
    const amount = lineAmounts[index]!;
    await ctx.tx.query(
      `INSERT INTO supplier_return_line
         (id, tenant_id, company_id, return_id, line_no, product_id, qty, unit_price, amount)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::uuid,
               $7::amount, $8::amount, $9::amount)`,
      [
        lineId,
        ctx.tenantId,
        input.companyId,
        input.id,
        index + 1,
        line.productId,
        line.qty,
        amount.unitPrice,
        amount.amount,
      ],
    );
    for (const batchId of [...new Set(line.batchIds)]) {
      await ctx.tx.query(
        `INSERT INTO supplier_return_line_batch
           (tenant_id, company_id, return_line_id, batch_id)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid)`,
        [ctx.tenantId, input.companyId, lineId, batchId],
      );
    }
  }

  const created = await getSupplierReturn(ctx, input.id);
  if (!created) {
    throw new AppError('INTERNAL_ERROR', '供应商退货创建后读取失败', { id: input.id });
  }
  return created;
}

/**
 * 导出用查询（#342）：采购单列表 CSV 的数据源。
 *
 * **与 `listPurchaseOrders` 的过滤条件必须保持一致，改一处要改两处。**
 * 这是刻意的重复：并行任务 #341 正在改 `listPurchaseOrders`，共享 where 拼装会让两个
 * 改动互相阻塞；另外导出不需要明细与费用，复用列表函数会把它们一起加载进内存。
 */
export interface PurchaseOrderExportQuery {
  readonly companyId?: string;
  readonly supplierId?: string;
  /** 按对接人筛（#368）：与列表同口径。 */
  readonly supplierContactId?: string;
  readonly status?: PurchaseOrderStatus;
  readonly keyword?: string;
  /** 行数上限：内部统一按 `maxRows + 1` 取，多出一行即判定超限（不静默截断）。 */
  readonly maxRows: number;
}

export interface PurchaseOrderExportRow {
  readonly orderNo: string;
  readonly createdAt: string;
  readonly supplierName: string;
  readonly status: PurchaseOrderStatus;
  readonly handlerId: string | null;
  readonly qtySum: string;
  readonly totalAmount: string;
}

export interface PurchaseOrderExportResult {
  readonly rows: readonly PurchaseOrderExportRow[];
  readonly exceedsMaxRows: boolean;
}

interface PurchaseExportRow {
  order_no: string;
  created_at: Date | string;
  supplier_name: string;
  status: string;
  handler_id: string | null;
  qty_sum: string;
  total_amount: string | number;
}

export async function exportPurchaseOrders(
  ctx: PurchaseOrderRepoContext,
  query: PurchaseOrderExportQuery,
): Promise<PurchaseOrderExportResult> {
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
  // 按对接人筛（#368）：老单据的 supplier_contact_id 是 NULL，等值比较不命中。
  if (query.supplierContactId !== undefined) {
    params.push(query.supplierContactId);
    where.push(`o.supplier_contact_id = $${params.length}::uuid`);
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

  params.push(query.maxRows + 1);
  const result = await ctx.tx.query<PurchaseExportRow>(
    `SELECT o.order_no,
            o.created_at,
            s.name AS supplier_name,
            o.status,
            o.handler_id,
            trim_scale(o.total_amount) AS total_amount,
            COALESCE(
              (
                SELECT trim_scale(SUM(l.qty))
                  FROM purchase_order_line l
                 WHERE l.tenant_id = o.tenant_id
                   AND l.order_id = o.id
              ),
              0
            )::text AS qty_sum
       FROM ${HEADER_FROM}
      WHERE ${where.join('\n        AND ')}
      ORDER BY o.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const exceedsMaxRows = result.rows.length > query.maxRows;
  const kept = exceedsMaxRows ? result.rows.slice(0, query.maxRows) : result.rows;
  return {
    rows: kept.map((row) => ({
      orderNo: row.order_no,
      createdAt: toDate(row.created_at).toISOString(),
      supplierName: row.supplier_name,
      status: row.status as PurchaseOrderStatus,
      handlerId: row.handler_id,
      qtySum: String(row.qty_sum),
      totalAmount: decimal(row.total_amount),
    })),
    exceedsMaxRows,
  };
}
