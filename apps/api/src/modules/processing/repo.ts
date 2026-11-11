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
  readonly companyId?: string;
  readonly processorId?: string;
  readonly status?: ProcessingOrderStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 创建输入 = 契约创建体 + 用例生成的 uuid / 单号。 */
export type ProcessingOrderInsertInput = ProcessingOrderCreateInput & {
  readonly id: string;
  readonly orderNo: string;
};

export interface ProcessingOrderPage {
  readonly items: ProcessingOrder[];
  readonly nextCursor: string | null;
}

/** 修改 / 取消前读取的最小状态（含可售量重算所需的投入量与损耗量）。 */
export interface ProcessingOrderState {
  readonly id: string;
  readonly companyId: string;
  readonly status: ProcessingOrderStatus;
  readonly inputQty: string;
  readonly lossQty: string | null;
  readonly version: number;
}

interface HeaderRow {
  id: string;
  tenant_id: string;
  company_id: string;
  order_no: string;
  processor_id: string;
  processor_name: string;
  status: string;
  handler_id: string;
  output_product_id: string | null;
  aux_materials: string | null;
  input_qty: string | number;
  loss_qty: string | number | null;
  sellable_qty: string | number | null;
  attribution_doc: string | null;
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
  status: string;
  input_qty: string | number;
  loss_qty: string | number | null;
  version: number;
}

const HEADER_COLUMNS = `o.id,
  o.tenant_id,
  o.company_id,
  o.order_no,
  o.processor_id,
  p.name AS processor_name,
  o.status,
  o.handler_id,
  o.output_product_id,
  o.aux_materials,
  trim_scale(o.input_qty) AS input_qty,
  trim_scale(o.loss_qty) AS loss_qty,
  trim_scale(o.sellable_qty) AS sellable_qty,
  o.attribution_doc,
  o.version,
  o.created_at,
  o.updated_at`;

const HEADER_FROM = `processing_order o
  JOIN processor p
    ON p.id = o.processor_id
   AND p.tenant_id = o.tenant_id
   AND p.company_id = o.company_id`;

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
    status: row.status as ProcessingOrderStatus,
    handlerId: row.handler_id,
    outputProductId: row.output_product_id,
    auxMaterials: row.aux_materials,
    inputQty: decimal(row.input_qty),
    lossQty: nullableDecimal(row.loss_qty),
    sellableQty: nullableDecimal(row.sellable_qty),
    attributionDoc: row.attribution_doc,
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

/** 修改 / 取消前读取状态；跨公司等同不存在。 */
export async function loadProcessingOrderState(
  ctx: ProcessingOrderRepoContext,
  id: string,
): Promise<ProcessingOrderState | null> {
  const result = await ctx.tx.query<StateRow>(
    `SELECT id,
            company_id,
            status,
            trim_scale(input_qty) AS input_qty,
            trim_scale(loss_qty) AS loss_qty,
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
    status: row.status as ProcessingOrderStatus,
    inputQty: decimal(row.input_qty),
    lossQty: nullableDecimal(row.loss_qty),
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
            version = version + 1
      WHERE id = $6::uuid
        AND tenant_id = $7
        AND company_id = ANY($8::uuid[])
        AND version = $9
        AND status = '进行中'
      RETURNING id`,
    [
      input.lossQty,
      input.sellableQty,
      input.outputBatchId,
      input.materialCostAmount,
      input.lossAmount,
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
  await assertMaterialBatchesInCompany(ctx, input.materialBatchIds, input.companyId);

  const lossQty = input.lossQty ?? null;
  const sellableQty = await calculateSellableQty(ctx, input.inputQty, lossQty);

  await ctx.tx.query(
    `INSERT INTO processing_order
       (id, tenant_id, company_id, order_no, processor_id, handler_id, output_product_id,
        status, aux_materials, input_qty, loss_qty, sellable_qty, attribution_doc)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, $7::uuid,
             '进行中', $8, $9::amount, $10::amount, $11::amount, $12)`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.orderNo,
      input.processorId,
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

  const params: unknown[] = [id, ctx.tenantId, [...ctx.companyIds], expectedVersion];
  const sets: string[] = ['version = version + 1'];

  if (input.processorId !== undefined) {
    params.push(input.processorId);
    sets.push(`processor_id = $${params.length}::uuid`);
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
