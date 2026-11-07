import { AppError } from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../../platform/db/client.js';

/**
 * 库存写入服务（D38 / D41 / D47 / D67）。
 *
 * 本文件是**全仓唯一允许直接 `UPDATE inventory_batch` 的地方**（Issue #48 §2 / D67），
 * 导出两个入口，别在模块 repo / 路由里自己写 SQL：
 *   - `applyStockAdjustment`：改批次「数量」（入库量）并追加库存流水，盘点与出入库单据走它；
 *   - `applyStockReservation`：**只改在途占用列**（D31 / D68③），不改入库量、不写流水。
 *
 * 任何单据都必须在自己业务事务内调用这里，把当前 tx 传进来（D70 同事务同回滚）。
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
  /** 来源单据类型：盘点固定 `stocktake`。 */
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

/**
 * 调整批次数量并追加一条库存流水（同事务）。
 *
 * 先 `FOR UPDATE` 锁定批次，再按「入库量 / 可用量调整后均非负」校验；
 * 任何一条不满足都抛 409（VERSION_CONFLICT）并在 details 说明原因，事务整体回滚。
 */
export async function applyStockAdjustment(
  tx: SqlClient,
  input: StockAdjustmentInput,
): Promise<StockAdjustmentResult> {
  const locked = await tx.query<BatchRow>(
    `SELECT trim_scale(inbound_qty) AS inbound_qty,
            trim_scale(available_qty) AS available_qty,
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
    throw new AppError('VERSION_CONFLICT', '盘亏调整后可用量将为负，拒绝审批', {
      reason: 'insufficient_available_qty',
      batchId: input.batchId,
      availableQty: String(current.available_qty),
      delta: input.delta,
    });
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

export interface StockReservationInput {
  readonly tenantId: string;
  readonly companyId: string;
  readonly batchId: string;
  /** 有符号在途量变化：锁定为正、释放为负（decimal 字符串，D54）。 */
  readonly delta: string;
  /** 来源单据类型：内部交易发货固定 `internal_trade_order`。 */
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  /** 经手人（发货人 employee id）。 */
  readonly handledBy: string;
}

export interface StockReservationResult {
  readonly inTransitQty: string;
  readonly availableQty: string;
  /** 批次实物责任人快照，供调用方写审计留痕（F5）。 */
  readonly custodianId: string;
}

interface ReservationRow {
  in_transit_qty: string | number;
  available_qty: string | number;
  custodian_id: string | null;
}

interface ReservationGuardRow {
  nonzero: boolean;
  in_transit_ok: boolean;
  available_ok: boolean;
}

/**
 * 在途占用 / 释放（D31 / D68③）。
 *
 * 与 `applyStockAdjustment` 的分工（重要）：
 *   - 本函数**只改 `in_transit_qty`**（锁定可用量），**不改入库量、不写 `inventory_flow`**；
 *     在途占用不是库存变动，批次实物仍归发出公司，改 `company_id` 要到接收方确认到货（D68③）；
 *   - 可用量是 PG STORED 生成列（D67：`inbound - referenced - in_transit - pending`），
 *     应用层不写它，锁定后自动减少；
 *   - 释放（delta < 0）时只要求「在途量不减成负数」，可用量必然变大，无需额外校验。
 *
 * 先 `FOR UPDATE` 锁批次再校验，事务由调用方持有，失败整体回滚。
 */
export async function applyStockReservation(
  tx: SqlClient,
  input: StockReservationInput,
): Promise<StockReservationResult> {
  const locked = await tx.query<ReservationRow>(
    `SELECT trim_scale(in_transit_qty) AS in_transit_qty,
            trim_scale(available_qty) AS available_qty,
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
    throw new AppError('NOT_FOUND', '库存批次不存在或不属于发出公司（D22）', {
      batchId: input.batchId,
    });
  }
  if (current.custodian_id === null) {
    throw new AppError('INTERNAL_ERROR', '库存批次缺少保管人', {
      batchId: input.batchId,
      field: 'custodianId',
    });
  }

  const guard = await tx.query<ReservationGuardRow>(
    `SELECT ($3::amount <> 0) AS nonzero,
            (($1::amount + $3::amount) >= 0) AS in_transit_ok,
            (($2::amount - $3::amount) >= 0) AS available_ok`,
    [current.in_transit_qty, current.available_qty, input.delta],
  );
  const checks = guard.rows[0];
  if (!checks || !checks.nonzero) {
    throw new AppError('VALIDATION_FAILED', '在途占用变化量不能为 0', {
      batchId: input.batchId,
      delta: input.delta,
    });
  }
  if (!checks.in_transit_ok) {
    throw new AppError('VALIDATION_FAILED', '释放的在途量超过该批次已锁定在途量', {
      reason: 'in_transit_qty_underflow',
      batchId: input.batchId,
      inTransitQty: String(current.in_transit_qty),
      delta: input.delta,
    });
  }
  if (!checks.available_ok) {
    throw new AppError('VERSION_CONFLICT', '批次可用量不足，无法锁定在途占用', {
      reason: 'insufficient_available_qty',
      batchId: input.batchId,
      availableQty: String(current.available_qty),
      delta: input.delta,
    });
  }

  const updated = await tx.query<ReservationRow>(
    `UPDATE inventory_batch
        SET in_transit_qty = in_transit_qty + $4::amount,
            version = version + 1
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND company_id = $3::uuid
      RETURNING trim_scale(in_transit_qty) AS in_transit_qty,
                trim_scale(available_qty) AS available_qty,
                custodian_id`,
    [input.batchId, input.tenantId, input.companyId, input.delta],
  );
  const next = updated.rows[0];
  if (!next) {
    throw new AppError('INTERNAL_ERROR', '库存批次在途占用后读取失败', {
      batchId: input.batchId,
    });
  }
  if (next.custodian_id === null) {
    throw new AppError('INTERNAL_ERROR', '库存批次在途占用后缺少保管人', {
      batchId: input.batchId,
      field: 'custodianId',
    });
  }

  return {
    inTransitQty: String(next.in_transit_qty),
    availableQty: String(next.available_qty),
    custodianId: next.custodian_id,
  };
}
