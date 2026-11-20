import {
  AppError,
  encodeCursor,
  type CursorPayload,
  type ProcessingMaterialInput,
  type ProcessingOrder,
  type ProcessingOrderCreateInput,
  type ProcessingOrderFee,
  type ProcessingOrderStatus,
  type ProcessingOrderUpdateInput,
} from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 加工单 B 数据访问层（D15 / D16 / D21 / D39 / D51 / D54）。
 *
 * - 隔离：所有查询都带 `tenant_id` + `company_id = ANY(可见公司集合)`；
 * - 数量 / 金额：全部保持 decimal 字符串，可售量由 SQL 计算，应用层不做浮点运算；
 * - 写：版本不匹配抛 `VERSION_CONFLICT`，查不到返回 `null`（由用例映射 404）；
 * - 取消：不物理删除（D21 / D47），只改状态；下游按库存流水来源单据反查；
 * - repo 只接收调用方已开好的事务，create / update / cancel 与审计同事务（D51）。
 */

export interface ProcessingOrderRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface ProcessingOrderListQuery {
  /** 只看这个人经手的单（D106）。由 usecase 按 scope 与 read_all 权限解析后传入；repo 不认识权限模型。 */
  readonly handlerId?: string;
  readonly companyId?: string;
  readonly processorId?: string;
  /** 按对接人筛（#368）。 */
  readonly processorContactId?: string;
  readonly status?: ProcessingOrderStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 创建输入 = 契约创建体 + 用例生成的 uuid / 单号。 */
/** `processorId` 由用例解析后必填（D100，同 E 单的 `customerId`）。 */
export type ProcessingOrderInsertInput = Omit<
  ProcessingOrderCreateInput,
  'processorId' | 'processorDraft'
> & {
  readonly processorId: string;
  readonly id: string;
  readonly orderNo: string;
};

export interface ProcessingOrderPage {
  readonly items: ProcessingOrder[];
  readonly nextCursor: string | null;
}

/** 修改 / 取消 / 详情读取的状态（含完成后的产出批次与损失快照）。 */
export interface ProcessingOrderState {
  readonly id: string;
  readonly companyId: string;
  /** 单头加工厂：改单换对接人时要拿它校验「同加工厂」（#306）。 */
  readonly processorId: string;
  /** 经手人（D106）：自己开的单自己就能改、能发、能确认到货，不需要额外权限点。 */
  readonly handlerId: string;
  readonly status: ProcessingOrderStatus;
  readonly inputQty: string;
  readonly lossQty: string | null;
  readonly sellableQty: string | null;
  readonly outputBatchId: string | null;
  readonly lossAmount: string | null;
  readonly transitStage: 'materials' | 'finished' | null;
  readonly transitTo: 'warehouse' | 'customer' | null;
  readonly updatedAt: string;
  readonly version: number;
}

interface HeaderRow {
  id: string;
  tenant_id: string;
  company_id: string;
  order_no: string;
  processor_id: string;
  processor_name: string;
  /** 下单对接人（#306）：可空；停用后名字仍回（LEFT JOIN 保留历史可读）。 */
  processor_contact_id: string | null;
  processor_contact_name: string | null;
  status: string;
  handler_id: string;
  output_product_id: string | null;
  aux_materials: string | null;
  input_qty: string | number;
  loss_qty: string | number | null;
  sellable_qty: string | number | null;
  attribution_doc: string | null;
  transit_stage: 'materials' | 'finished' | null;
  transit_to: 'warehouse' | 'customer' | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FeeRow {
  order_id: string;
  fee_name: string;
  qty: string | number;
  unit_price: string | number;
  amount: string | number;
  remark: string | null;
}

interface StateRow {
  id: string;
  company_id: string;
  processor_id: string;
  handler_id: string;
  status: string;
  input_qty: string | number;
  loss_qty: string | number | null;
  sellable_qty: string | number | null;
  output_batch_id: string | null;
  loss_amount: string | number | null;
  transit_stage: 'materials' | 'finished' | null;
  transit_to: 'warehouse' | 'customer' | null;
  updated_at: Date | string;
  version: number;
}

const HEADER_COLUMNS = `o.id,
  o.tenant_id,
  o.company_id,
  o.order_no,
  o.processor_id,
  p.name AS processor_name,
  o.processor_contact_id,
  k.name AS processor_contact_name,
  o.status,
  o.handler_id,
  o.output_product_id,
  o.aux_materials,
  trim_scale(o.input_qty) AS input_qty,
  trim_scale(o.loss_qty) AS loss_qty,
  trim_scale(o.sellable_qty) AS sellable_qty,
  o.attribution_doc,
  o.transit_stage,
  o.transit_to,
  o.version,
  o.created_at,
  o.updated_at`;

const HEADER_FROM = `processing_order o
  JOIN processor p
    ON p.id = o.processor_id
   AND p.tenant_id = o.tenant_id
   AND p.company_id = o.company_id
  LEFT JOIN processor_contact k
    ON k.id = o.processor_contact_id
   AND k.tenant_id = o.tenant_id
   AND k.company_id = o.company_id`;

const FEE_COLUMNS = `f.order_id,
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

function nullableDecimal(value: string | number | null): string | null {
  return value === null ? null : decimal(value);
}

function mapHeader(row: HeaderRow): Omit<ProcessingOrder, 'materialBatchIds' | 'fees'> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    orderNo: row.order_no,
    processorId: row.processor_id,
    processorName: row.processor_name,
    processorContactId: row.processor_contact_id,
    processorContactName: row.processor_contact_name,
    status: row.status as ProcessingOrderStatus,
    handlerId: row.handler_id,
    outputProductId: row.output_product_id,
    auxMaterials: row.aux_materials,
    inputQty: decimal(row.input_qty),
    lossQty: nullableDecimal(row.loss_qty),
    sellableQty: nullableDecimal(row.sellable_qty),
    attributionDoc: row.attribution_doc,
    ...(row.transit_stage === null ? {} : { transitStage: row.transit_stage }),
    ...(row.transit_to === null ? {} : { transitTo: row.transit_to }),
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

function mapFee(row: FeeRow): ProcessingOrderFee {
  return {
    feeName: row.fee_name,
    qty: decimal(row.qty),
    unitPrice: decimal(row.unit_price),
    amount: decimal(row.amount),
    remark: row.remark,
  };
}

/** LIKE / ILIKE 模式串：转义用户输入里的 `\`、`%`、`_`。 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

async function queryHeader(
  ctx: ProcessingOrderRepoContext,
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

async function queryMaterialBatchIds(
  ctx: ProcessingOrderRepoContext,
  orderIds: readonly string[],
): Promise<Map<string, ProcessingMaterialInput[]>> {
  const grouped = new Map<string, ProcessingMaterialInput[]>();
  if (orderIds.length === 0) return grouped;

  const result = await ctx.tx.query<{
    order_id: string;
    batch_id: string;
    qty: string | number;
  }>(
    `SELECT order_id, batch_id, qty
       FROM processing_order_material_batch
      WHERE tenant_id = $1
        AND order_id = ANY($2::uuid[])
      ORDER BY order_id, line_no`,
    [ctx.tenantId, [...orderIds]],
  );
  for (const row of result.rows) {
    const rows = grouped.get(row.order_id) ?? [];
    rows.push({ batchId: row.batch_id, qty: decimal(row.qty) });
    grouped.set(row.order_id, rows);
  }
  return grouped;
}

async function queryFees(
  ctx: ProcessingOrderRepoContext,
  orderIds: readonly string[],
): Promise<Map<string, ProcessingOrderFee[]>> {
  const grouped = new Map<string, ProcessingOrderFee[]>();
  if (orderIds.length === 0) return grouped;

  const result = await ctx.tx.query<FeeRow>(
    `SELECT ${FEE_COLUMNS}
       FROM processing_order_fee f
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
 * 加工单列表：租户 + 可见公司内，按公司 / 加工厂 / 状态 / 关键字
 * （单号或加工厂名）过滤，按 uuidv7 `id DESC` 做 keyset 分页。
 */
export async function listProcessingOrders(
  ctx: ProcessingOrderRepoContext,
  query: ProcessingOrderListQuery,
): Promise<ProcessingOrderPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['o.tenant_id = $1', 'o.company_id = ANY($2::uuid[])'];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`o.company_id = $${params.length}::uuid`);
  }
  if (query.processorId !== undefined) {
    params.push(query.processorId);
    where.push(`o.processor_id = $${params.length}::uuid`);
  }
  // 按对接人筛（#368）：老单据的 processor_contact_id 是 NULL，等值比较不命中。
  if (query.processorContactId !== undefined) {
    params.push(query.processorContactId);
    where.push(`o.processor_contact_id = $${params.length}::uuid`);
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
      OR p.name ILIKE ${keywordParam} ESCAPE '\\'
    )`);
  }
  // D106：`scope=mine` 由用例层折算成 handlerId 传下来，undefined 表示不筛。
  if (query.handlerId !== undefined) {
    params.push(query.handlerId);
    where.push(`o.handler_id = $${params.length}::uuid`);
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
  const [batchesByOrder, feesByOrder] = await Promise.all([
    queryMaterialBatchIds(ctx, ids),
    queryFees(ctx, ids),
  ]);
  const items = pageRows.map((row) => ({
    ...mapHeader(row),
    materialBatchIds: batchesByOrder.get(row.id) ?? [],
    fees: feesByOrder.get(row.id) ?? [],
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/** 加工单详情基础实体：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getProcessingOrder(
  ctx: ProcessingOrderRepoContext,
  id: string,
): Promise<ProcessingOrder | null> {
  const row = await queryHeader(ctx, id);
  if (!row) return null;
  const [batchesByOrder, feesByOrder] = await Promise.all([
    queryMaterialBatchIds(ctx, [id]),
    queryFees(ctx, [id]),
  ]);
  return {
    ...mapHeader(row),
    materialBatchIds: batchesByOrder.get(id) ?? [],
    fees: feesByOrder.get(id) ?? [],
  };
}

/** 修改 / 取消 / 详情读取状态；跨公司等同不存在。 */
export async function loadProcessingOrderState(
  ctx: ProcessingOrderRepoContext,
  id: string,
): Promise<ProcessingOrderState | null> {
  const result = await ctx.tx.query<StateRow>(
    `SELECT id,
            company_id,
            processor_id,
            handler_id,
            status,
            trim_scale(input_qty) AS input_qty,
            trim_scale(loss_qty) AS loss_qty,
            trim_scale(sellable_qty) AS sellable_qty,
            output_batch_id,
            trim_scale(loss_amount) AS loss_amount,
            transit_stage,
            transit_to,
            updated_at,
            version
       FROM processing_order
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
    processorId: row.processor_id,
    handlerId: row.handler_id,
    status: row.status as ProcessingOrderStatus,
    inputQty: decimal(row.input_qty),
    lossQty: nullableDecimal(row.loss_qty),
    sellableQty: nullableDecimal(row.sellable_qty),
    outputBatchId: row.output_batch_id,
    lossAmount: nullableDecimal(row.loss_amount),
    transitStage: row.transit_stage,
    transitTo: row.transit_to,
    updatedAt: toDate(row.updated_at).toISOString(),
    version: row.version,
  };
}

/**
 * 直接下游判定（D21）：库存流水以 B 单为来源即视为下游已发生。
 * 本批尚无完成端点，正常情况下恒为 false，保留该查询供产出批次落地后直接复用。
 */
export async function hasDirectDownstream(
  ctx: ProcessingOrderRepoContext,
  state: ProcessingOrderState,
): Promise<boolean> {
  const result = await ctx.tx.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM inventory_flow f
        WHERE f.tenant_id = $1
          AND f.company_id = $2::uuid
          AND f.source_doc_id = $3::uuid
          AND f.source_doc_type IN ('B', 'processing_order')
     ) AS exists`,
    [ctx.tenantId, state.companyId, state.id],
  );
  return result.rows[0]?.exists === true;
}

export async function completeProcessingOrder(
  ctx: ProcessingOrderRepoContext,
  id: string,
  expectedVersion: number,
  input: {
    readonly lossQty: string;
    readonly sellableQty: string;
    readonly outputBatchId: string | null;
    readonly materialCostAmount: string;
    readonly lossAmount: string;
    readonly partialLossAmount: string;
  },
): Promise<ProcessingOrder | null> {
  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE processing_order
        SET status = '已完成',
            loss_qty = $1::amount,
            sellable_qty = $2::amount,
            output_batch_id = $3::uuid,
            material_cost_amount = $4::amount,
            loss_amount = $5::amount,
            partial_loss_amount = $6::amount,
            version = version + 1
      WHERE id = $7::uuid
        AND tenant_id = $8
        AND company_id = ANY($9::uuid[])
        AND version = $10
        AND status = '进行中'
      RETURNING id`,
    [
      input.lossQty,
      input.sellableQty,
      input.outputBatchId,
      input.materialCostAmount,
      input.lossAmount,
      input.partialLossAmount,
      id,
      ctx.tenantId,
      [...ctx.companyIds],
      expectedVersion,
    ],
  );
  if (result.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '加工单已被并发修改或不是进行中状态');
  }
  return getProcessingOrder(ctx, id);
}

/**
 * 进行中 → 在途的「料段」（`materials`）。
 *
 * 只写 `transit_stage`：料往加工厂去，方向由单据头的 `processor_id` 唯一决定，
 * 没有第二个真源。`transit_to` 留 NULL（列本来可空，CHECK 也只允许 warehouse/customer），
 * 硬填一个 `warehouse` 会造出「材料在路上、去向却是回仓」这种自相矛盾的记录（#333 复核）。
 */
export async function startProcessingTransit(
  ctx: ProcessingOrderRepoContext,
  id: string,
  expectedVersion: number,
  input: {
    readonly transitStage: 'materials';
  },
): Promise<ProcessingOrder | null> {
  const changed = await ctx.tx.query<{ id: string }>(
    `UPDATE processing_order
        SET status = '在途',
            transit_stage = $1,
            transit_to = NULL,
            version = version + 1
      WHERE id = $2::uuid
        AND tenant_id = $3
        AND company_id = ANY($4::uuid[])
        AND version = $5
        AND status = '进行中'
      RETURNING id`,
    [input.transitStage, id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (changed.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '加工单已被并发修改或不是进行中状态');
  }
  return getProcessingOrder(ctx, id);
}

/** finished 段发货时一次性锁定损耗、成本与产出批次，但状态仍是「在途」。 */
export async function startProcessingFinishedTransit(
  ctx: ProcessingOrderRepoContext,
  id: string,
  expectedVersion: number,
  input: {
    readonly transitTo: 'warehouse' | 'customer';
    readonly lossQty: string;
    readonly sellableQty: string;
    readonly outputBatchId: string | null;
    readonly materialCostAmount: string;
    readonly lossAmount: string;
    readonly partialLossAmount: string;
  },
): Promise<ProcessingOrder | null> {
  const changed = await ctx.tx.query<{ id: string }>(
    `UPDATE processing_order
        SET status = '在途',
            transit_stage = 'finished',
            transit_to = $1,
            loss_qty = $2::amount,
            sellable_qty = $3::amount,
            output_batch_id = $4::uuid,
            material_cost_amount = $5::amount,
            loss_amount = $6::amount,
            partial_loss_amount = $7::amount,
            version = version + 1
      WHERE id = $8::uuid
        AND tenant_id = $9
        AND company_id = ANY($10::uuid[])
        AND version = $11
        AND status = '进行中'
      RETURNING id`,
    [
      input.transitTo,
      input.lossQty,
      input.sellableQty,
      input.outputBatchId,
      input.materialCostAmount,
      input.lossAmount,
      input.partialLossAmount,
      id,
      ctx.tenantId,
      [...ctx.companyIds],
      expectedVersion,
    ],
  );
  if (changed.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '加工单已被并发修改或不是进行中状态');
  }
  return getProcessingOrder(ctx, id);
}

/** materials 到货：回到进行中，后续 complete 继续走 D92 的释放与产出逻辑。 */
export async function receiveProcessingMaterials(
  ctx: ProcessingOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<ProcessingOrder | null> {
  const changed = await ctx.tx.query<{ id: string }>(
    `UPDATE processing_order
        SET status = '进行中',
            transit_stage = NULL,
            transit_to = NULL,
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '在途'
        AND transit_stage = 'materials'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (changed.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '加工单不是在途材料段或已被并发修改');
  }
  return getProcessingOrder(ctx, id);
}

/** finished 到货：产出批次已在发货时锁定，这里只完成状态机。 */
export async function receiveProcessingFinished(
  ctx: ProcessingOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<ProcessingOrder | null> {
  const changed = await ctx.tx.query<{ id: string }>(
    `UPDATE processing_order
        SET status = '已完成',
            transit_stage = NULL,
            transit_to = NULL,
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '在途'
        AND transit_stage = 'finished'
      RETURNING id`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  if (changed.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '加工单不是在途成品段或已被并发修改');
  }
  return getProcessingOrder(ctx, id);
}

/** 撤销任意在途段：回到进行中，并清掉 finished 阶段已锁定的快照。 */
export async function revokeProcessingTransit(
  ctx: ProcessingOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<ProcessingOrder | null> {
  const changed = await ctx.tx.query<{ id: string }>(
    `UPDATE processing_order
        SET status = '进行中',
            transit_stage = NULL,
            transit_to = NULL,
            loss_qty = NULL,
            sellable_qty = NULL,
            output_batch_id = NULL,
            material_cost_amount = NULL,
            loss_amount = NULL,
            partial_loss_amount = NULL,
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
    throw new AppError('VERSION_CONFLICT', '加工单不是在途状态或已被并发修改');
  }
  return getProcessingOrder(ctx, id);
}

/** 加工厂必须存在，但必须与单头同公司（D15）。 */
async function assertProcessorInCompany(
  ctx: ProcessingOrderRepoContext,
  processorId: string,
  companyId: string,
): Promise<void> {
  const result = await ctx.tx.query(
    `SELECT 1
       FROM processor
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid`,
    [processorId, ctx.tenantId, companyId],
  );
  if (result.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', '加工厂不存在或不属于该加工单的公司', {
      processorId,
      companyId,
    });
  }
}

/**
 * 下单对接人校验（#306）：必须**同加工厂 + 同公司 + 启用**，否则 422。
 * 三条一起查（任一条不满足都是同一个用户错误），`details.field` 指回入参名。
 */
async function assertProcessorContactUsable(
  ctx: ProcessingOrderRepoContext,
  contactId: string,
  processorId: string,
  companyId: string,
): Promise<void> {
  const result = await ctx.tx.query(
    `SELECT 1
       FROM processor_contact
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid
        AND processor_id = $4::uuid
        AND status = '启用'`,
    [contactId, ctx.tenantId, companyId, processorId],
  );
  if (result.rows.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      '对接人不存在、不属于该加工厂、跨公司或已停用',
      { field: 'processorContactId', processorContactId: contactId },
    );
  }
}

/** 经手人必须存在且属于同一租户。 */
async function assertHandlerInTenant(
  ctx: ProcessingOrderRepoContext,
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

/** 材料投入批次必须属于加工单公司（D22）；去重后一次查询。 */
async function assertMaterialBatchesInCompany(
  ctx: ProcessingOrderRepoContext,
  materialBatchIds: readonly ProcessingMaterialInput[],
  companyId: string,
): Promise<void> {
  const unique = [...new Set(materialBatchIds.map((row) => row.batchId))];
  const result = await ctx.tx.query<{ id: string }>(
    `SELECT id
       FROM inventory_batch
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [ctx.tenantId, companyId, unique],
  );
  const found = new Set(result.rows.map((row) => row.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError('VALIDATION_FAILED', '材料批次不存在或不属于该加工单的公司', {
      batchIds: missing,
      companyId,
    });
  }
}

/** 可售量由 SQL 一次性计算并校验损耗量不超过投入量，应用层不转浮点。 */
async function calculateSellableQty(
  ctx: ProcessingOrderRepoContext,
  inputQty: string,
  lossQty: string | null,
): Promise<string | null> {
  if (lossQty === null) return null;
  const result = await ctx.tx.query<{
    sellable_qty: string | number;
    loss_exceeds_input: boolean;
  }>(
    `SELECT trim_scale($1::amount - $2::amount) AS sellable_qty,
            $2::amount > $1::amount AS loss_exceeds_input`,
    [inputQty, lossQty],
  );
  const row = result.rows[0];
  if (!row || row.loss_exceeds_input) {
    throw new AppError('VALIDATION_FAILED', '损耗量不能大于投入量', {
      inputQty,
      lossQty,
    });
  }
  return decimal(row.sellable_qty);
}

async function insertMaterialBatches(
  ctx: ProcessingOrderRepoContext,
  orderId: string,
  companyId: string,
  materialBatchIds: readonly ProcessingMaterialInput[],
): Promise<void> {
  for (const [index, material] of materialBatchIds.entries()) {
    await ctx.tx.query(
      `INSERT INTO processing_order_material_batch
         (id, tenant_id, company_id, order_id, line_no, batch_id, qty)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::uuid, $7::amount)`,
      [
        uuidv7(),
        ctx.tenantId,
        companyId,
        orderId,
        index + 1,
        material.batchId,
        material.qty,
      ],
    );
  }
}

async function insertFees(
  ctx: ProcessingOrderRepoContext,
  orderId: string,
  companyId: string,
  fees: ProcessingOrderCreateInput['fees'],
): Promise<void> {
  for (const [index, fee] of fees.entries()) {
    await ctx.tx.query(
      `INSERT INTO processing_order_fee
         (id, tenant_id, company_id, order_id, line_no, fee_name,
          qty, unit_price, amount, remark)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6,
               $7::amount, $8::amount, $9::amount, $10)`,
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

/** 汇总单头费用合计，全部交给 SQL，应用侧不做浮点聚合。 */
async function recalcFeeAmount(
  ctx: ProcessingOrderRepoContext,
  orderId: string,
): Promise<void> {
  await ctx.tx.query(
    `UPDATE processing_order o
        SET fee_amount = COALESCE(
              (SELECT SUM(f.amount)
                 FROM processing_order_fee f
                WHERE f.order_id = o.id
                  AND f.tenant_id = o.tenant_id),
              0
            )
      WHERE o.id = $1::uuid
        AND o.tenant_id = $2`,
    [orderId, ctx.tenantId],
  );
}

/** 新增加工单：`id` / `orderNo` 由用例生成。 */
export async function insertProcessingOrder(
  ctx: ProcessingOrderRepoContext,
  input: ProcessingOrderInsertInput,
): Promise<ProcessingOrder> {
  await assertProcessorInCompany(ctx, input.processorId, input.companyId);
  await assertHandlerInTenant(ctx, input.handlerId);
  if (input.processorContactId !== undefined) {
    await assertProcessorContactUsable(
      ctx,
      input.processorContactId,
      input.processorId,
      input.companyId,
    );
  }
  await assertMaterialBatchesInCompany(ctx, input.materialBatchIds, input.companyId);

  const lossQty = input.lossQty ?? null;
  const sellableQty = await calculateSellableQty(ctx, input.inputQty, lossQty);

  await ctx.tx.query(
    `INSERT INTO processing_order
       (id, tenant_id, company_id, order_no, processor_id, processor_contact_id,
        handler_id, output_product_id,
        status, aux_materials, input_qty, loss_qty, sellable_qty, attribution_doc)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid,
             '进行中', $9, $10::amount, $11::amount, $12::amount, $13)`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.orderNo,
      input.processorId,
      input.processorContactId ?? null,
      input.handlerId,
      input.outputProductId,
      input.auxMaterials ?? null,
      input.inputQty,
      lossQty,
      sellableQty,
      input.attributionDoc ?? null,
    ],
  );
  await insertMaterialBatches(ctx, input.id, input.companyId, input.materialBatchIds);
  await insertFees(ctx, input.id, input.companyId, input.fees);
  await recalcFeeAmount(ctx, input.id);

  const created = await getProcessingOrder(ctx, input.id);
  if (!created) {
    throw new AppError('INTERNAL_ERROR', '加工单创建后读取失败', { id: input.id });
  }
  return created;
}

/**
 * 修改加工单：只有「进行中」可改（D4），并校验强 ETag 版本。
 * 材料批次 / 费用明细传入即整体替换；未传字段保持原值。
 */
export async function updateProcessingOrder(
  ctx: ProcessingOrderRepoContext,
  id: string,
  input: ProcessingOrderUpdateInput,
  expectedVersion: number,
): Promise<ProcessingOrder | null> {
  const current = await loadProcessingOrderState(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '加工单版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }
  if (current.status !== '进行中') {
    throw new AppError('VALIDATION_FAILED', '只有「进行中」的加工单可修改，错账请走冲正单据', {
      status: current.status,
    });
  }

  if (input.processorId !== undefined) {
    await assertProcessorInCompany(ctx, input.processorId, current.companyId);
  }
  if (input.handlerId !== undefined) {
    await assertHandlerInTenant(ctx, input.handlerId);
  }
  if (input.materialBatchIds !== undefined) {
    await assertMaterialBatchesInCompany(ctx, input.materialBatchIds, current.companyId);
  }
  if (input.inputQty !== undefined) {
    await calculateSellableQty(ctx, input.inputQty, current.lossQty);
  }

  /**
   * 对接人三态（#306）：传值=换人、传 null=清空、未传=不动；换加工厂未指定对接人时清空。
   */
  const nextContactId =
    input.processorContactId !== undefined
      ? input.processorContactId
      : input.processorId !== undefined && input.processorId !== current.processorId
        ? null
        : undefined;
  if (typeof nextContactId === 'string') {
    await assertProcessorContactUsable(
      ctx,
      nextContactId,
      input.processorId ?? current.processorId,
      current.companyId,
    );
  }

  const params: unknown[] = [id, ctx.tenantId, [...ctx.companyIds], expectedVersion];
  const sets: string[] = ['version = version + 1'];

  if (input.processorId !== undefined) {
    params.push(input.processorId);
    sets.push(`processor_id = $${params.length}::uuid`);
  }
  if (nextContactId !== undefined) {
    params.push(nextContactId);
    sets.push(`processor_contact_id = $${params.length}::uuid`);
  }
  if (input.handlerId !== undefined) {
    params.push(input.handlerId);
    sets.push(`handler_id = $${params.length}::uuid`);
  }
  if (input.outputProductId !== undefined) {
    params.push(input.outputProductId);
    sets.push(`output_product_id = $${params.length}::uuid`);
  }
  if (input.inputQty !== undefined) {
    params.push(input.inputQty);
    sets.push(`input_qty = $${params.length}::amount`);
    if (current.lossQty !== null) {
      sets.push(`sellable_qty = $${params.length}::amount - loss_qty`);
    }
  }
  if (input.auxMaterials !== undefined) {
    params.push(input.auxMaterials);
    sets.push(`aux_materials = $${params.length}`);
  }
  if (input.attributionDoc !== undefined) {
    params.push(input.attributionDoc);
    sets.push(`attribution_doc = $${params.length}`);
  }

  const updated = await ctx.tx.query<{ id: string }>(
    `UPDATE processing_order
        SET ${sets.join(',\n            ')}
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = ANY($3::uuid[])
        AND version = $4
        AND status = '进行中'
      RETURNING id`,
    params,
  );
  if (updated.rows.length === 0) {
    throw new AppError('VERSION_CONFLICT', '加工单已被并发修改，请重新读取后重试');
  }

  if (input.materialBatchIds !== undefined) {
    await ctx.tx.query(
      `DELETE FROM processing_order_material_batch
        WHERE order_id = $1::uuid AND tenant_id = $2`,
      [id, ctx.tenantId],
    );
    await insertMaterialBatches(ctx, id, current.companyId, input.materialBatchIds);
  }
  if (input.fees !== undefined) {
    await ctx.tx.query(
      `DELETE FROM processing_order_fee
        WHERE order_id = $1::uuid AND tenant_id = $2`,
      [id, ctx.tenantId],
    );
    await insertFees(ctx, id, current.companyId, input.fees);
  }

  await recalcFeeAmount(ctx, id);
  return getProcessingOrder(ctx, id);
}

/** 取消加工单：只改状态、不物理删除（D21 / D47）。 */
export async function cancelProcessingOrder(
  ctx: ProcessingOrderRepoContext,
  id: string,
  expectedVersion: number,
): Promise<ProcessingOrder | null> {
  const current = await loadProcessingOrderState(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '加工单版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }

  const result = await ctx.tx.query<{ id: string }>(
    `UPDATE processing_order
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
    throw new AppError('VERSION_CONFLICT', '加工单已被并发修改，请重新读取后重试');
  }

  return getProcessingOrder(ctx, id);
}
