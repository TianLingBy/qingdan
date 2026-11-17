import { AppError } from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../../platform/db/client.js';
import { takeBatchNo } from '../../../platform/numbering/service.js';
import type {
  CreateBatchCommand,
  CreateBatchReceipt,
  CreateTransitBatchCommand,
  StockBatchConsumptionSnapshot,
  StockReservationCommand,
  StockReservationReceipt,
  StockTransitLineCommand,
  StockTransitSourceCommand,
} from '../../../platform/services/registry.js';

export type { CreateBatchCommand, CreateBatchReceipt, CreateTransitBatchCommand };
export type { StockBatchConsumptionSnapshot };

export interface StockBatchTransfer {
  readonly batchId: string;
  readonly qty?: string;
}

export interface StockBatchTransferInput {
  readonly tenantId: string;
  readonly fromCompanyId: string;
  readonly toCompanyId: string;
  readonly transfers: readonly StockBatchTransfer[];
}

const NON_NEGATIVE_TRANSFER_QTY_RE = /^\d{1,12}(\.\d{1,6})?$/;

export async function transferBatches(
  tx: SqlClient,
  input: StockBatchTransferInput,
): Promise<void> {
  if (input.fromCompanyId === input.toCompanyId) {
    throw new AppError('VALIDATION_FAILED', '转司的发出公司与接收公司不能相同');
  }
  if (input.transfers.length === 0) {
    throw new AppError('VALIDATION_FAILED', '至少需要一条批次转司明细');
  }
  for (const transfer of input.transfers) {
    if (transfer.qty !== undefined && (!NON_NEGATIVE_TRANSFER_QTY_RE.test(transfer.qty) || transfer.qty === '0')) {
      throw new AppError('VALIDATION_FAILED', '转司数量必须是正 decimal 字符串', {
        batchId: transfer.batchId,
        qty: transfer.qty,
      });
    }
  }

  const company = await tx.query(
    `SELECT 1
       FROM company
      WHERE tenant_id = $1
        AND id = $2::uuid`,
    [input.tenantId, input.toCompanyId],
  );
  if (company.rows.length === 0) {
    throw new AppError('NOT_FOUND', '接收公司不存在', { companyId: input.toCompanyId });
  }

  const locked = await tx.query<{
    id: string;
    in_transit_qty: string | number;
  }>(
    `SELECT id::text AS id, trim_scale(in_transit_qty) AS in_transit_qty
       FROM inventory_batch
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])
      FOR UPDATE`,
    [input.tenantId, input.fromCompanyId, input.transfers.map((transfer) => transfer.batchId)],
  );
  if (locked.rows.length !== input.transfers.length) {
    throw new AppError('NOT_FOUND', '存在不存在或不属于发出公司的库存批次', {
      companyId: input.fromCompanyId,
    });
  }

  const availableById = new Map(locked.rows.map((row) => [row.id, row.in_transit_qty]));
  const resolvedTransfers = input.transfers.map((transfer) => ({
    batchId: transfer.batchId,
    qty: transfer.qty ?? String(availableById.get(transfer.batchId)),
  }));
  for (const transfer of resolvedTransfers) {
    const available = availableById.get(transfer.batchId);
    const guard = await tx.query<{ enough: boolean; transit_enough: boolean }>(
      `SELECT $1::amount <= $2::amount AS enough`,
      [transfer.qty, available],
    );
    if (!guard.rows[0]?.enough) {
      throw new AppError('VERSION_CONFLICT', '库存批次在途量不足，拒绝转司', {
        batchId: transfer.batchId,
        requestedQty: transfer.qty,
        inTransitQty: String(available),
      });
    }
  }

  for (const transfer of resolvedTransfers) {
    await tx.query(
      `UPDATE inventory_batch
          SET in_transit_qty = in_transit_qty - $1::amount,
              company_id = $2::uuid
        WHERE id = $3::uuid
          AND tenant_id = $4
          AND company_id = $5::uuid`,
      [
        transfer.qty,
        input.toCompanyId,
        transfer.batchId,
        input.tenantId,
        input.fromCompanyId,
      ],
    );
  }
}

export interface StockBatchInspectionQuery {
  readonly tenantId: string;
  readonly companyId: string;
  readonly batchIds: readonly string[];
}

export async function inspectBatches(
  tx: SqlClient,
  query: StockBatchInspectionQuery,
): Promise<readonly StockBatchConsumptionSnapshot[]> {
  if (query.batchIds.length === 0) return [];

  const result = await tx.query<{
    id: string;
    batch_no: string;
    available_qty: string | number;
    locked_unit_cost: string | number;
  }>(
    `SELECT id::text AS id,
            batch_no,
            trim_scale(available_qty) AS available_qty,
            trim_scale(locked_unit_cost) AS locked_unit_cost
       FROM inventory_batch
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [query.tenantId, query.companyId, query.batchIds],
  );

  if (result.rows.length !== query.batchIds.length) {
    throw new AppError('NOT_FOUND', '存在不存在或不属于该公司的库存批次', {
      batchIds: query.batchIds,
      companyId: query.companyId,
    });
  }

  const rowsById = new Map(result.rows.map((row) => [row.id, row]));
  return query.batchIds.map((batchId) => {
    const row = rowsById.get(batchId);
    if (!row) {
      throw new AppError('NOT_FOUND', '库存批次不存在或不属于该公司', { batchId });
    }
    return {
      batchId: row.id,
      batchNo: row.batch_no,
      availableQty: String(row.available_qty),
      lockedUnitCost: String(row.locked_unit_cost),
    };
  });
}

/**
 * 库存写入服务（D38 / D41 / D47 / D67）。
 *
 * **全仓唯一允许修改批次数量的库存服务函数**：任何单据（本期为盘点 I）都必须在
 * 自己业务事务内调用本函数调整批次，并同时追加库存流水；不得在模块 repo / 路由
 * 里直接 `UPDATE inventory_batch`（Issue #48 §2 / D67）。
 *
 * 盘盈 / 盘亏一律走「调整 inbound_qty + 追加冲正流水」：
 *   - 盘盈 delta > 0：inbound_qty += delta，available_qty 同步增加；
 *   - 盘亏 delta < 0：inbound_qty += delta（即减去 |delta|），若调整后
 *     available_qty 会变负，则拒绝审批并说明（D38 可用量不得为负）；
 *   - 批次与历史流水一行都不删、不改（D47）。
 *
 * 事务前提：调用方已设置 `app.tenant_id`；本函数全程使用调用方传入的 tx。
 */

export interface StockAdjustmentInput {
  readonly tenantId: string;
  readonly companyId: string;
  readonly batchId: string;
  /** 有符号数量变化：盘盈为正、盘亏为负（decimal 字符串，D54）。 */
  readonly delta: string;
  /** 来源单据类型：盘点固定 `stocktake`；也用于把校验失败文案说成对应业务动作（#269）。 */
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  /** 经手人（盘点为审批人 employee id）。 */
  readonly handledBy: string;
}

export interface StockAdjustmentResult {
  readonly inboundQty: string;
  readonly availableQty: string;
  /** 批次实物责任人快照，供调用方写审计留痕（F5 / #84）。 */
  readonly custodianId: string;
}

interface GuardRow {
  nonzero: boolean;
  inbound_ok: boolean;
  available_ok: boolean;
}

interface BatchRow {
  inbound_qty: string | number;
  available_qty: string | number;
  custodian_id: string | null;
}

interface LockedBatchRow extends BatchRow {
  batch_no: string;
}

interface NewBatchRow {
  available_qty: string | number;
  custodian_id: string;
}

interface ReservationBatchRow {
  id: string;
  batch_no: string;
  pending_execution_qty: string | number;
  available_qty: string | number;
  in_transit_qty: string | number;
}

interface TransitBatchRow {
  id: string;
  batch_no: string;
  inbound_qty: string | number;
  in_transit_qty: string | number;
  pending_execution_qty: string | number;
  held_by_processor_id: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_NEGATIVE_DECIMAL_RE = /^\d{1,12}(\.\d{1,6})?$/;

/**
 * 可用量不足时的业务动作文案（#269）。
 *
 * 同一条库存守卫被销售完成（E）、加工领料（B）、盘点审批（stocktake）共用；
 * 调用方本来就把来源单据类型传进来了，这里只按它选动作措辞，不改校验逻辑、
 * 错误码（VERSION_CONFLICT）或 HTTP 状态码。无法识别来源时用中性文案。
 * 盘点保留原句尾的「拒绝审批」；其余动作没有审批环节，只说动作与批次。
 */
function insufficientAvailableMessage(
  sourceDocType: string,
  batchNo: string,
): string {
  const batch = `（批次 ${batchNo}）`;
  switch (sourceDocType) {
    case 'E':
      return `销售出库后批次可用量将为负${batch}`;
    case 'B':
      return `加工领料后批次可用量将为负${batch}`;
    case 'stocktake':
      return `盘亏调整后可用量将为负${batch}，拒绝审批`;
    default:
      return `该操作会使批次可用量变为负数${batch}`;
  }
}

/** 完成前释放建单占用失败时，同样按来源单据给员工可执行的动作文案（#269 / #286）。 */
function insufficientPendingMessage(
  sourceDocType: string,
  batchNo: string,
): string {
  const batch = `（批次 ${batchNo}）`;
  switch (sourceDocType) {
    case 'E':
      return `销售出库前待执行占用不足${batch}`;
    case 'B':
      return `加工领料前待执行占用不足${batch}`;
    case 'S':
      return `供应商退货出库前待执行占用不足${batch}`;
    default:
      return `待执行占用不足，无法执行该操作${batch}`;
  }
}

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是合法 uuid`, {
      field,
    });
  }
}

async function applyPendingReservationChange(
  tx: SqlClient,
  input: StockReservationCommand,
  direction: 'reserve' | 'release',
): Promise<StockReservationReceipt> {
  assertUuid(input.tenantId, 'tenantId');
  assertUuid(input.companyId, 'companyId');
  assertUuid(input.sourceDocId, 'sourceDocId');
  assertUuid(input.handledBy, 'handledBy');
  if (input.lines.length === 0) {
    throw new AppError('VALIDATION_FAILED', '库存占用至少需要一条批次明细', {
      sourceDocType: input.sourceDocType,
      sourceDocId: input.sourceDocId,
    });
  }

  const totals = new Map<string, string>();
  for (const line of input.lines) {
    assertUuid(line.batchId, 'batchId');
    if (!NON_NEGATIVE_DECIMAL_RE.test(line.qty)) {
      throw new AppError('VALIDATION_FAILED', '占用数量必须是非负 decimal 字符串', {
        batchId: line.batchId,
        qty: line.qty,
      });
    }
    const added = await tx.query<{ qty: string | number; positive: boolean }>(
      `SELECT trim_scale($1::amount + $2::amount) AS qty,
              ($1::amount + $2::amount > 0) AS positive`,
      [totals.get(line.batchId) ?? '0', line.qty],
    );
    const row = added.rows[0];
    if (!row?.positive) {
      throw new AppError('VALIDATION_FAILED', '占用数量必须大于 0', {
        batchId: line.batchId,
        qty: line.qty,
      });
    }
    totals.set(line.batchId, String(row.qty));
  }

  const entries = [...totals.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const locked = await tx.query<ReservationBatchRow>(
    `SELECT id::text AS id,
            batch_no,
            trim_scale(pending_execution_qty) AS pending_execution_qty,
            trim_scale(available_qty) AS available_qty,
            trim_scale(in_transit_qty) AS in_transit_qty
       FROM inventory_batch
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [input.tenantId, input.companyId, entries.map(([batchId]) => batchId)],
  );
  if (locked.rows.length !== entries.length) {
    const found = new Set(locked.rows.map((row) => row.id));
    throw new AppError('NOT_FOUND', '存在不存在或不属于该公司的库存批次', {
      batchIds: entries.map(([batchId]) => batchId).filter((id) => !found.has(id)),
      companyId: input.companyId,
    });
  }

  const rowsById = new Map(locked.rows.map((row) => [row.id, row]));
  const receipt: StockReservationReceipt['lines'][number][] = [];
  for (const [batchId, qty] of entries) {
    const current = rowsById.get(batchId);
    if (!current) {
      throw new AppError('NOT_FOUND', '库存批次不存在', { batchId });
    }
    const guard = await tx.query<{
      qty_positive: boolean;
      available_enough: boolean;
      pending_enough: boolean;
    }>(
      `SELECT ($1::amount > 0) AS qty_positive,
              ($1::amount <= (
                $2::amount + GREATEST($3::amount - $4::amount, 0::amount)
              )) AS available_enough,
              ($1::amount <= $4::amount) AS pending_enough`,
      [qty, current.available_qty, current.in_transit_qty, current.pending_execution_qty],
    );
    const checks = guard.rows[0];
    if (!checks?.qty_positive) {
      throw new AppError('VALIDATION_FAILED', '占用数量必须大于 0', {
        batchId,
        qty,
      });
    }
    if (direction === 'reserve' && !checks.available_enough) {
      throw new AppError('VERSION_CONFLICT', '库存批次可用量不足（含在途），无法建单占用', {
        reason: 'insufficient_available_qty',
        sourceDocType: input.sourceDocType,
        sourceDocId: input.sourceDocId,
        batchId,
        batchNo: current.batch_no,
        requestedQty: qty,
        availableQty: String(current.available_qty),
        inTransitQty: String(current.in_transit_qty),
      });
    }
    if (direction === 'release' && !checks.pending_enough) {
      throw new AppError(
        'VERSION_CONFLICT',
        insufficientPendingMessage(input.sourceDocType, current.batch_no),
        {
        reason: 'insufficient_pending_reservation',
        sourceDocType: input.sourceDocType,
        sourceDocId: input.sourceDocId,
        batchId,
        batchNo: current.batch_no,
        requestedQty: qty,
        pendingExecutionQty: String(current.pending_execution_qty),
        },
      );
    }

    const updated = await tx.query<{
      pending_execution_qty: string | number;
      available_qty: string | number;
    }>(
      direction === 'reserve'
        ? `UPDATE inventory_batch
              SET pending_execution_qty = pending_execution_qty + $1::amount,
                  version = version + 1
            WHERE id = $2::uuid
              AND tenant_id = $3
              AND company_id = $4::uuid
            RETURNING trim_scale(pending_execution_qty) AS pending_execution_qty,
                      trim_scale(available_qty) AS available_qty`
        : `UPDATE inventory_batch
              SET pending_execution_qty = pending_execution_qty - $1::amount,
                  version = version + 1
            WHERE id = $2::uuid
              AND tenant_id = $3
              AND company_id = $4::uuid
              AND pending_execution_qty >= $1::amount
            RETURNING trim_scale(pending_execution_qty) AS pending_execution_qty,
                      trim_scale(available_qty) AS available_qty`,
      [qty, batchId, input.tenantId, input.companyId],
    );
    const next = updated.rows[0];
    if (!next) {
      throw new AppError('VERSION_CONFLICT', '库存待执行占用并发更新失败', {
        reason: 'concurrent_pending_change',
        sourceDocType: input.sourceDocType,
        sourceDocId: input.sourceDocId,
        batchId,
        requestedQty: qty,
      });
    }
    receipt.push({
      batchId,
      qty,
      pendingAfter: String(next.pending_execution_qty),
      availableAfter: String(next.available_qty),
    });
  }

  return { lines: receipt };
}

export function reservePendingReservations(
  tx: SqlClient,
  input: StockReservationCommand,
): Promise<StockReservationReceipt> {
  return applyPendingReservationChange(tx, input, 'reserve');
}

export function releasePendingReservations(
  tx: SqlClient,
  input: StockReservationCommand,
): Promise<StockReservationReceipt> {
  return applyPendingReservationChange(tx, input, 'release');
}

/**
 * 新建一个入库批次，并在同一事务追加一条正数库存流水（#136 / #137）。
 *
 * - 商品必须属于命令指定的租户与公司；
 * - 保管人必须属于同一租户；
 * - 数量必须大于 0，锁定单价允许为 0；
 * - 批次与流水任一写入失败时，由调用方事务整体回滚。
 */
export async function createBatch(
  tx: SqlClient,
  command: CreateBatchCommand,
): Promise<CreateBatchReceipt> {
  assertUuid(command.tenantId, 'tenantId');
  assertUuid(command.companyId, 'companyId');
  assertUuid(command.productId, 'productId');
  assertUuid(command.custodianId, 'custodianId');
  assertUuid(command.handledBy, 'handledBy');
  assertUuid(command.sourceDocId, 'sourceDocId');
  if (!NON_NEGATIVE_DECIMAL_RE.test(command.qty)) {
    throw new AppError('VALIDATION_FAILED', 'qty 必须是非负 decimal 字符串', {
      field: 'qty',
    });
  }
  if (!NON_NEGATIVE_DECIMAL_RE.test(command.lockedUnitCost)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'lockedUnitCost 必须是非负 decimal 字符串',
      {
        field: 'lockedUnitCost',
      },
    );
  }

  const numericGuard = await tx.query<{
    qty_positive: boolean;
    cost_nonnegative: boolean;
  }>(
    `SELECT ($1::amount > 0) AS qty_positive,
            ($2::amount >= 0) AS cost_nonnegative`,
    [command.qty, command.lockedUnitCost],
  );
  const guard = numericGuard.rows[0];
  if (!guard?.qty_positive) {
    throw new AppError('VALIDATION_FAILED', '入库数量必须大于 0', {
      field: 'qty',
      qty: command.qty,
    });
  }
  if (!guard.cost_nonnegative) {
    throw new AppError('VALIDATION_FAILED', '锁定单价不能为负数', {
      field: 'lockedUnitCost',
      lockedUnitCost: command.lockedUnitCost,
    });
  }

  const product = await tx.query(
    `SELECT 1
       FROM product
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid`,
    [command.productId, command.tenantId, command.companyId],
  );
  if (product.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', '商品不存在或不属于该批次公司', {
      productId: command.productId,
      companyId: command.companyId,
    });
  }

  const custodian = await tx.query(
    `SELECT 1 FROM employee WHERE id = $1::uuid AND tenant_id = $2`,
    [command.custodianId, command.tenantId],
  );
  if (custodian.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', '保管人不存在', {
      custodianId: command.custodianId,
    });
  }

  const batchId = uuidv7();
  const batchNo = await takeBatchNo(tx, command.companyId, new Date());
  const inserted = await tx.query<NewBatchRow>(
    `INSERT INTO inventory_batch
       (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
        inbound_qty, custodian_id)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::amount, $7::amount, $8::uuid)
     RETURNING trim_scale(available_qty) AS available_qty, custodian_id`,
    [
      batchId,
      command.tenantId,
      command.companyId,
      command.productId,
      batchNo,
      command.lockedUnitCost,
      command.qty,
      command.custodianId,
    ],
  );
  const batch = inserted.rows[0];
  if (!batch) {
    throw new AppError('INTERNAL_ERROR', '入库批次创建后读取失败', { batchId });
  }

  await tx.query(
    `INSERT INTO inventory_flow
       (id, tenant_id, company_id, batch_id, delta,
        source_doc_type, source_doc_id, handled_by)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::amount, $6, $7::uuid, $8::uuid)`,
    [
      uuidv7(),
      command.tenantId,
      command.companyId,
      batchId,
      command.qty,
      command.sourceDocType,
      command.sourceDocId,
      command.handledBy,
    ],
  );

  return {
    batchId,
    batchNo,
    availableQty: String(batch.available_qty),
    custodianId: batch.custodian_id,
  };
}

async function assertHeldProcessor(
  tx: SqlClient,
  tenantId: string,
  companyId: string,
  processorId: string | null | undefined,
): Promise<void> {
  if (processorId === null || processorId === undefined) return;
  assertUuid(processorId, 'heldByProcessorId');
  const result = await tx.query(
    `SELECT 1
       FROM processor
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid`,
    [processorId, tenantId, companyId],
  );
  if (result.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', '加工厂不存在或不属于该批次公司', {
      processorId,
      companyId,
    });
  }
}

/**
 * 新建在途批次：先按普通入库批次落 inbound_qty + 正流水，再把同一批货
 * 全量计入 in_transit_qty。两步在同一事务，失败整体回滚。
 */
export async function createTransitBatch(
  tx: SqlClient,
  command: CreateTransitBatchCommand,
): Promise<CreateBatchReceipt> {
  await assertHeldProcessor(tx, command.tenantId, command.companyId, command.heldByProcessorId);
  const created = await createBatch(tx, command);
  const updated = await tx.query<{ available_qty: string | number }>(
    `UPDATE inventory_batch
        SET in_transit_qty = $1::amount,
            held_by_processor_id = $2::uuid,
            version = version + 1
      WHERE id = $3::uuid
        AND tenant_id = $4
        AND company_id = $5::uuid
        AND in_transit_qty = 0
        AND pending_execution_qty = 0
      RETURNING trim_scale(available_qty) AS available_qty`,
    [
      command.qty,
      command.heldByProcessorId ?? null,
      created.batchId,
      command.tenantId,
      command.companyId,
    ],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new AppError('VERSION_CONFLICT', '在途批次并发更新失败', {
      batchId: created.batchId,
    });
  }
  return { ...created, availableQty: String(row.available_qty) };
}

async function lockTransitBatches(
  tx: SqlClient,
  command: StockTransitLineCommand,
  quantities: ReadonlyMap<string, string>,
): Promise<Map<string, TransitBatchRow>> {
  const entries = [...quantities.keys()].sort((left, right) => left.localeCompare(right));
  const locked = await tx.query<TransitBatchRow>(
    `SELECT id::text AS id,
            batch_no,
            trim_scale(inbound_qty) AS inbound_qty,
            trim_scale(in_transit_qty) AS in_transit_qty,
            trim_scale(pending_execution_qty) AS pending_execution_qty,
            held_by_processor_id::text AS held_by_processor_id
       FROM inventory_batch
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [command.tenantId, command.companyId, entries],
  );
  if (locked.rows.length !== entries.length) {
    throw new AppError('NOT_FOUND', '存在不存在或不属于该公司的库存批次', {
      batchIds: entries,
      companyId: command.companyId,
    });
  }
  return new Map(locked.rows.map((row) => [row.id, row]));
}

function aggregateTransitLines(
  command: StockTransitLineCommand,
): Map<string, string> {
  if (command.lines.length === 0) {
    throw new AppError('VALIDATION_FAILED', '在途操作至少需要一条批次明细', {
      sourceDocType: command.sourceDocType,
      sourceDocId: command.sourceDocId,
    });
  }
  const totals = new Map<string, string>();
  for (const line of command.lines) {
    assertUuid(line.batchId, 'batchId');
    if (!NON_NEGATIVE_DECIMAL_RE.test(line.qty) || /^0(?:\.0+)?$/.test(line.qty)) {
      throw new AppError('VALIDATION_FAILED', '在途数量必须是正 decimal 字符串', {
        batchId: line.batchId,
        qty: line.qty,
      });
    }
    const current = totals.get(line.batchId);
    totals.set(line.batchId, current === undefined ? line.qty : addDecimalText(current, line.qty));
  }
  return totals;
}

function addDecimalText(left: string, right: string): string {
  const scale = 1_000_000n;
  const toMicro = (value: string): bigint => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole ?? '0') * scale + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  };
  const total = toMicro(left) + toMicro(right);
  const whole = total / scale;
  const fraction = (total % scale).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction.length === 0 ? String(whole) : `${whole}.${fraction}`;
}

/** 到货确认：在途量清零，可用量按生成列自然上升；占用关系保留。 */
export async function receiveTransit(
  tx: SqlClient,
  command: StockTransitLineCommand,
): Promise<void> {
  const quantities = aggregateTransitLines(command);
  const rows = await lockTransitBatches(tx, command, quantities);
  for (const [batchId, qty] of quantities) {
    const current = rows.get(batchId)!;
    const enough = await tx.query<{ enough: boolean }>(
      `SELECT $1::amount <= $2::amount AS enough`,
      [qty, current.in_transit_qty],
    );
    if (!enough.rows[0]?.enough) {
      throw new AppError('VERSION_CONFLICT', '库存批次在途量不足，无法确认到货', {
        reason: 'insufficient_in_transit_qty',
        batchId,
        batchNo: current.batch_no,
        requestedQty: qty,
        inTransitQty: String(current.in_transit_qty),
      });
    }
    await tx.query(
      `UPDATE inventory_batch
          SET in_transit_qty = in_transit_qty - $1::amount,
              version = version + 1
        WHERE id = $2::uuid
          AND tenant_id = $3
          AND company_id = $4::uuid
          AND in_transit_qty >= $1::amount`,
      [qty, batchId, command.tenantId, command.companyId],
    );
  }
}

/** B 材料发货：待执行占用原地转成在途，不改变总可占范围。 */
export async function movePendingToTransit(
  tx: SqlClient,
  command: StockTransitLineCommand,
): Promise<void> {
  await assertHeldProcessor(
    tx,
    command.tenantId,
    command.companyId,
    command.heldByProcessorId,
  );
  const quantities = aggregateTransitLines(command);
  const rows = await lockTransitBatches(tx, command, quantities);
  for (const [batchId, qty] of quantities) {
    const current = rows.get(batchId)!;
    const enough = await tx.query<{ enough: boolean }>(
      `SELECT $1::amount <= $2::amount AS enough`,
      [qty, current.pending_execution_qty],
    );
    if (!enough.rows[0]?.enough) {
      throw new AppError('VERSION_CONFLICT', '库存批次待执行占用不足，无法转为在途', {
        reason: 'insufficient_pending_reservation',
        batchId,
        batchNo: current.batch_no,
        requestedQty: qty,
        pendingExecutionQty: String(current.pending_execution_qty),
      });
    }
    await tx.query(
      `UPDATE inventory_batch
          SET pending_execution_qty = pending_execution_qty - $1::amount,
              in_transit_qty = in_transit_qty + $1::amount,
              held_by_processor_id = $2::uuid,
              version = version + 1
        WHERE id = $3::uuid
          AND tenant_id = $4
          AND company_id = $5::uuid
          AND pending_execution_qty >= $1::amount`,
      [
        qty,
        command.heldByProcessorId ?? null,
        batchId,
        command.tenantId,
        command.companyId,
      ],
    );
  }
}

/** B 材料到货 / 撤销：在途转回待执行占用，后续 complete 仍沿用 D92 口径。 */
export async function moveTransitToPending(
  tx: SqlClient,
  command: StockTransitLineCommand,
): Promise<void> {
  await assertHeldProcessor(
    tx,
    command.tenantId,
    command.companyId,
    command.heldByProcessorId,
  );
  const quantities = aggregateTransitLines(command);
  const rows = await lockTransitBatches(tx, command, quantities);
  for (const [batchId, qty] of quantities) {
    const current = rows.get(batchId)!;
    const enough = await tx.query<{ enough: boolean }>(
      `SELECT $1::amount <= $2::amount AS enough`,
      [qty, current.in_transit_qty],
    );
    if (!enough.rows[0]?.enough) {
      throw new AppError('VERSION_CONFLICT', '库存批次在途量不足，无法转回待执行占用', {
        reason: 'insufficient_in_transit_qty',
        batchId,
        batchNo: current.batch_no,
        requestedQty: qty,
        inTransitQty: String(current.in_transit_qty),
      });
    }
    await tx.query(
      `UPDATE inventory_batch
          SET in_transit_qty = in_transit_qty - $1::amount,
              pending_execution_qty = pending_execution_qty + $1::amount,
              held_by_processor_id = $2::uuid,
              version = version + 1
        WHERE id = $3::uuid
          AND tenant_id = $4
          AND company_id = $5::uuid
          AND in_transit_qty >= $1::amount`,
      [
        qty,
        command.heldByProcessorId ?? null,
        batchId,
        command.tenantId,
        command.companyId,
      ],
    );
  }
}

/** 撤销指定在途批次（B finished 发货撤销使用）。 */
export async function revokeTransitBatch(
  tx: SqlClient,
  command: StockTransitLineCommand,
): Promise<void> {
  const quantities = aggregateTransitLines(command);
  const rows = await lockTransitBatches(tx, command, quantities);
  for (const [batchId, qty] of quantities) {
    const current = rows.get(batchId)!;
    if (
      current.pending_execution_qty !== 0 &&
      current.pending_execution_qty !== '0'
    ) {
      throw new AppError('STATE_CONFLICT', '在途货已有下游占用，不能撤销发货', {
        reason: 'HAS_PENDING_OCCUPANCY',
        batchId,
        batchNo: current.batch_no,
        pendingExecutionQty: String(current.pending_execution_qty),
      });
    }
    const guard = await tx.query<{ enough: boolean; transit_enough: boolean }>(
      `SELECT $1::amount <= $2::amount AS enough,
              $1::amount <= $3::amount AS transit_enough`,
      [qty, current.inbound_qty, current.in_transit_qty],
    );
    if (!guard.rows[0]?.enough || !guard.rows[0]?.transit_enough) {
      throw new AppError('VERSION_CONFLICT', '撤销发货时批次数量不足', {
        batchId,
        requestedQty: qty,
        inboundQty: String(current.inbound_qty),
        inTransitQty: String(current.in_transit_qty),
      });
    }
    await tx.query(
      `UPDATE inventory_batch
          SET inbound_qty = inbound_qty - $1::amount,
              in_transit_qty = in_transit_qty - $1::amount,
              held_by_processor_id = NULL,
              version = version + 1
        WHERE id = $2::uuid
          AND tenant_id = $3
          AND company_id = $4::uuid
          AND in_transit_qty >= $1::amount`,
      [qty, batchId, command.tenantId, command.companyId],
    );
    await tx.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta,
          source_doc_type, source_doc_id, handled_by)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::amount, $6, $7::uuid, $8::uuid)`,
      [
        uuidv7(),
        command.tenantId,
        command.companyId,
        batchId,
        `-${qty}`,
        command.sourceDocType,
        command.sourceDocId,
        command.handledBy,
      ],
    );
  }
}

async function transitBatchesBySource(
  tx: SqlClient,
  command: StockTransitSourceCommand,
): Promise<TransitBatchRow[]> {
  if (command.sourceDocType !== 'A') {
    throw new AppError('VALIDATION_FAILED', '仅采购单支持按来源整批处理在途批次');
  }
  const result = await tx.query<TransitBatchRow>(
    `SELECT b.id::text AS id,
            b.batch_no,
            trim_scale(b.inbound_qty) AS inbound_qty,
            trim_scale(b.in_transit_qty) AS in_transit_qty,
            trim_scale(b.pending_execution_qty) AS pending_execution_qty,
            b.held_by_processor_id::text AS held_by_processor_id
       FROM inventory_batch b
      WHERE b.tenant_id = $1
        AND b.company_id = $2::uuid
        AND EXISTS (
          SELECT 1
            FROM inventory_flow f
           WHERE f.tenant_id = b.tenant_id
             AND f.company_id = b.company_id
             AND f.batch_id = b.id
             AND f.source_doc_type = $3
             AND f.source_doc_id = $4::uuid
        )
      ORDER BY b.id
      FOR UPDATE`,
    [command.tenantId, command.companyId, command.sourceDocType, command.sourceDocId],
  );
  if (result.rows.length === 0) {
    throw new AppError('STATE_CONFLICT', '采购单没有可处理的在途批次', {
      reason: 'NO_TRANSIT_BATCHES',
      sourceDocId: command.sourceDocId,
    });
  }
  return result.rows;
}

/** A 单到货：来源单据创建的全部批次从在途转可用。 */
export async function receiveTransitBySource(
  tx: SqlClient,
  command: StockTransitSourceCommand,
): Promise<void> {
  const batches = await transitBatchesBySource(tx, command);
  await receiveTransit(tx, {
    ...command,
    lines: batches
      .filter((batch) => batch.in_transit_qty !== 0 && batch.in_transit_qty !== '0')
      .map((batch) => ({ batchId: batch.id, qty: String(batch.in_transit_qty) })),
  });
}

/** A 单撤销发货：尚有占用时拒绝；否则冲回 inbound/in_transit 并追加负数流水。 */
export async function revokeTransitBySource(
  tx: SqlClient,
  command: StockTransitSourceCommand,
): Promise<void> {
  const batches = await transitBatchesBySource(tx, command);
  for (const batch of batches) {
    if (batch.pending_execution_qty !== 0 && batch.pending_execution_qty !== '0') {
      throw new AppError('STATE_CONFLICT', '在途货已有下游占用，不能撤销发货', {
        reason: 'HAS_PENDING_OCCUPANCY',
        batchId: batch.id,
        batchNo: batch.batch_no,
        pendingExecutionQty: String(batch.pending_execution_qty),
      });
    }
    const qty = String(batch.in_transit_qty);
    if (qty === '0') continue;
    const guard = await tx.query<{ enough: boolean }>(
      `SELECT $1::amount <= $2::amount AS enough`,
      [qty, batch.inbound_qty],
    );
    if (!guard.rows[0]?.enough) {
      throw new AppError('VERSION_CONFLICT', '撤销发货时批次入库量不足', {
        batchId: batch.id,
        requestedQty: qty,
        inboundQty: String(batch.inbound_qty),
      });
    }
    await tx.query(
      `UPDATE inventory_batch
          SET inbound_qty = inbound_qty - $1::amount,
              in_transit_qty = in_transit_qty - $1::amount,
              held_by_processor_id = NULL,
              version = version + 1
        WHERE id = $2::uuid
          AND tenant_id = $3
          AND company_id = $4::uuid
          AND in_transit_qty >= $1::amount`,
      [qty, batch.id, command.tenantId, command.companyId],
    );
    await tx.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta,
          source_doc_type, source_doc_id, handled_by)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::amount, $6, $7::uuid, $8::uuid)`,
      [
        uuidv7(),
        command.tenantId,
        command.companyId,
        batch.id,
        `-${qty}`,
        command.sourceDocType,
        command.sourceDocId,
        command.handledBy,
      ],
    );
  }
}

/**
 * 调整批次数量并追加一条库存流水（同事务）。
 *
 * 先 `FOR UPDATE` 锁定批次，再按「入库量 / 可用量调整后均非负」校验；
 * 任何一条不满足都抛 409（VERSION_CONFLICT）并在 details 说明原因，事务整体回滚。
 * 可用量不足的文案按调用方传入的 sourceDocType 区分销售 / 加工 / 盘点（#269）。
 */
export async function applyStockAdjustment(
  tx: SqlClient,
  input: StockAdjustmentInput,
): Promise<StockAdjustmentResult> {
  const locked = await tx.query<LockedBatchRow>(
    `SELECT trim_scale(inbound_qty) AS inbound_qty,
            trim_scale(available_qty) AS available_qty,
            batch_no,
            custodian_id
       FROM inventory_batch
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid
      FOR UPDATE`,
    [input.batchId, input.tenantId, input.companyId],
  );
  const current = locked.rows[0];
  if (!current) {
    throw new AppError('NOT_FOUND', '库存批次不存在', {
      batchId: input.batchId,
    });
  }
  if (current.custodian_id === null) {
    throw new AppError('INTERNAL_ERROR', '库存批次缺少保管人', {
      batchId: input.batchId,
      field: 'custodianId',
    });
  }

  const guard = await tx.query<GuardRow>(
    `SELECT ($3::amount <> 0) AS nonzero,
            (($1::amount + $3::amount) >= 0) AS inbound_ok,
            (($2::amount + $3::amount) >= 0) AS available_ok`,
    [current.inbound_qty, current.available_qty, input.delta],
  );
  const checks = guard.rows[0];
  if (!checks || !checks.nonzero) {
    throw new AppError('VALIDATION_FAILED', '库存调整量不能为 0', {
      batchId: input.batchId,
      delta: input.delta,
    });
  }
  if (!checks.inbound_ok) {
    throw new AppError('VERSION_CONFLICT', '库存调整后入库量将为负，拒绝审批', {
      reason: 'negative_inbound_qty',
      batchId: input.batchId,
      inboundQty: String(current.inbound_qty),
      delta: input.delta,
    });
  }
  if (!checks.available_ok) {
    throw new AppError(
      'VERSION_CONFLICT',
      insufficientAvailableMessage(input.sourceDocType, current.batch_no),
      {
        reason: 'insufficient_available_qty',
        batchId: input.batchId,
        batchNo: current.batch_no,
        availableQty: String(current.available_qty),
        delta: input.delta,
      },
    );
  }

  const updated = await tx.query<BatchRow>(
    `UPDATE inventory_batch
        SET inbound_qty = inbound_qty + $4::amount,
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid
      RETURNING trim_scale(inbound_qty) AS inbound_qty,
                trim_scale(available_qty) AS available_qty,
                custodian_id`,
    [input.batchId, input.tenantId, input.companyId, input.delta],
  );
  const next = updated.rows[0];
  if (!next) {
    throw new AppError('INTERNAL_ERROR', '库存批次调整后读取失败', {
      batchId: input.batchId,
    });
  }
  if (next.custodian_id === null) {
    throw new AppError('INTERNAL_ERROR', '库存批次调整后缺少保管人', {
      batchId: input.batchId,
      field: 'custodianId',
    });
  }

  // 流水只追加（D47）；delta 与盘点单 diffQty 一致，来源指向盘点单。
  await tx.query(
    `INSERT INTO inventory_flow
       (id, tenant_id, company_id, batch_id, delta,
        source_doc_type, source_doc_id, handled_by)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::amount, $6, $7::uuid, $8::uuid)`,
    [
      uuidv7(),
      input.tenantId,
      input.companyId,
      input.batchId,
      input.delta,
      input.sourceDocType,
      input.sourceDocId,
      input.handledBy,
    ],
  );

  return {
    inboundQty: String(next.inbound_qty),
    availableQty: String(next.available_qty),
    custodianId: next.custodian_id,
  };
}
