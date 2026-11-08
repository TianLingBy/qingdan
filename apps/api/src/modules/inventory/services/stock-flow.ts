import { AppError } from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../../platform/db/client.js';
import { DOCUMENT_SEQUENCE_MAX } from '../../../platform/numbering/service.js';

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

/**
 * 新建入库批次命令（#136 / #137）。
 *
 * 形状与负责人批准的 `StockFlowPort.createBatch` 一致。端口接口由主线登记；
 * inventory 先在服务层落实现，待 platform 端口补齐后由 `services/ports.ts` 接线。
 */
export interface CreateBatchCommand {
  readonly tenantId: string;
  readonly companyId: string;
  readonly productId: string;
  /** 入库数量（A 单按行数量 / B 单产出可售量）。 */
  readonly qty: string;
  /** 锁定单价：入库即锁，不随采购价变动（D5）。 */
  readonly lockedUnitCost: string;
  /** 保管人；B 单调用方按 handler_id 解析后传入。 */
  readonly custodianId: string;
  /** 来源单据类型与 ID，写流水溯源用。 */
  readonly sourceDocType: 'A' | 'B';
  readonly sourceDocId: string;
}

export interface CreateBatchReceipt {
  readonly batchId: string;
  readonly batchNo: string;
  readonly availableQty: string;
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

interface NewBatchRow {
  available_qty: string | number;
  custodian_id: string;
}

interface BatchSequenceRow {
  last_value: number;
  company_code: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_NEGATIVE_DECIMAL_RE = /^\d{1,12}(\.\d{1,6})?$/;

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是合法 uuid`, {
      field,
    });
  }
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 产出批次号：`PB-<公司码4>-<日期8>-<流水4>`（#136 / D16）。
 *
 * 与单据取号一样按「公司 + 年月」原子递增；前缀 `PB` 不在 `DocumentType`
 * 单字母集合内，因此这里复用同一 `number_sequence` 机制，而不改 platform 取号器。
 */
async function takeBatchNo(
  tx: SqlClient,
  tenantId: string,
  companyId: string,
  date: Date,
): Promise<string> {
  const scopeKey = `inventory_batch:${companyId}:${monthKey(date)}`;
  const result = await tx.query<BatchSequenceRow>(
    `WITH company_row AS (
       SELECT code AS company_code
         FROM company
        WHERE id = $1::uuid
          AND tenant_id = $2
     ), upserted AS (
       INSERT INTO number_sequence (tenant_id, scope_key, last_value)
       SELECT $2, $3, 1 FROM company_row
       ON CONFLICT (tenant_id, scope_key) DO UPDATE
         SET last_value = number_sequence.last_value + 1,
             updated_at = now()
         WHERE number_sequence.last_value < $4
       RETURNING last_value
     )
     SELECT u.last_value, c.company_code
       FROM upserted u
       CROSS JOIN company_row c`,
    [companyId, tenantId, scopeKey, DOCUMENT_SEQUENCE_MAX],
  );
  const row = result.rows[0];
  if (!row) {
    const company = await tx.query(
      `SELECT 1 FROM company WHERE id = $1::uuid AND tenant_id = $2`,
      [companyId, tenantId],
    );
    if (company.rows.length === 0) {
      throw new AppError('NOT_FOUND', '公司不存在', { companyId });
    }
    throw new AppError(
      'VALIDATION_FAILED',
      `产出入库批次在 ${monthKey(date)} 的月流水已用满 ${DOCUMENT_SEQUENCE_MAX}，需扩容后再建批次`,
      { scopeKey },
    );
  }

  const ymd = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
  return `PB-${row.company_code}-${ymd}-${String(row.last_value).padStart(4, '0')}`;
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
  const batchNo = await takeBatchNo(
    tx,
    command.tenantId,
    command.companyId,
    new Date(),
  );
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
      command.custodianId,
    ],
  );

  return {
    batchId,
    batchNo,
    availableQty: String(batch.available_qty),
    custodianId: batch.custodian_id,
  };
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
