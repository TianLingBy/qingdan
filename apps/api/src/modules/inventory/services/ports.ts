import type { ServiceRegistry } from '../../../platform/services/registry.js';
import {
  applyStockAdjustment,
  createBatch as createStockBatch,
  createTransitBatch as createStockTransitBatch,
  inspectBatches,
  movePendingToTransit as movePendingBatchesToTransit,
  moveTransitToPending as moveTransitBatchesToPending,
  receiveTransit,
  receiveTransitBySource,
  releasePendingReservations,
  reservePendingReservations,
  revokeTransitBatch,
  revokeTransitBySource,
  transferBatches,
} from './stock-flow.js';

/**
 * inventory 对外端口实现（D70）。
 *
 * 批次创建与数量调整都收口在本模块服务函数；端口只做稳定 interface 映射，
 * **不新增第二条库存写入路径**。
 */
export const inventoryServices: Pick<
  ServiceRegistry,
  'stockFlow' | 'batchDirectory' | 'stockBatchInspection' | 'stockBatchTransfer'
> = {
  stockFlow: {
    applyAdjustment: async (tx, command) =>
      applyStockAdjustment(tx, {
        tenantId: command.tenantId,
        companyId: command.companyId,
        batchId: command.batchId,
        delta: command.delta,
        sourceDocType: command.sourceDocType,
        sourceDocId: command.sourceDocId,
        handledBy: command.handledBy,
      }),
    createBatch: async (tx, command) =>
      createStockBatch(tx, {
        tenantId: command.tenantId,
        companyId: command.companyId,
        productId: command.productId,
        qty: command.qty,
        lockedUnitCost: command.lockedUnitCost,
        custodianId: command.custodianId,
        sourceDocType: command.sourceDocType,
        sourceDocId: command.sourceDocId,
        handledBy: command.handledBy,
      }),
    createTransitBatch: async (tx, command) =>
      createStockTransitBatch(tx, {
        ...command,
        heldByProcessorId: command.heldByProcessorId ?? null,
      }),
    receiveTransit,
    movePendingToTransit: movePendingBatchesToTransit,
    moveTransitToPending: moveTransitBatchesToPending,
    revokeTransitBatch,
    revokeTransitBySource,
    receiveTransitBySource,
    reservePending: async (tx, command) =>
      reservePendingReservations(tx, {
        tenantId: command.tenantId,
        companyId: command.companyId,
        sourceDocType: command.sourceDocType,
        sourceDocId: command.sourceDocId,
        handledBy: command.handledBy,
        lines: command.lines,
      }),
    releasePending: async (tx, command) =>
      releasePendingReservations(tx, {
        tenantId: command.tenantId,
        companyId: command.companyId,
        sourceDocType: command.sourceDocType,
        sourceDocId: command.sourceDocId,
        handledBy: command.handledBy,
        lines: command.lines,
      }),
  },
  // 打印用只读查询：sales 客户联要显示批次号，但不得直读 inventory_batch。
  batchDirectory: {
    lookupBatchNos: async (tx, query) => {
      if (query.batchIds.length === 0) return [];
      const result = await tx.query<{ id: string; batch_no: string }>(
        `SELECT id::text AS id, batch_no
           FROM inventory_batch
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])`,
        [query.tenantId, query.batchIds],
      );
      return result.rows.map((row) => ({ id: row.id, batchNo: row.batch_no }));
    },
    /**
     * D94 ③：E 单签收按批次反查来源单。
     *
     * `inventory_batch` 本身没有来源单列（来源只记在库存流水上），因此取该批次
     * **首条正数流水**（建批流水）的 `source_doc_type` / `source_doc_id`；
     * 同一事务内建批流水先于后续任何调整，`created_at` 相同则按 uuidv7 顺序。
     * 查不到来源的批次不出现在结果里，由调用方按「非 A/B 来源」处理。
     */
    lookupBatchSources: async (tx, query) => {
      if (query.batchIds.length === 0) return [];
      const result = await tx.query<{
        batch_id: string;
        source_doc_type: string;
        source_doc_id: string;
      }>(
        `SELECT DISTINCT ON (batch_id)
                batch_id::text AS batch_id,
                source_doc_type,
                source_doc_id::text AS source_doc_id
           FROM inventory_flow
          WHERE tenant_id = $1
            AND company_id = $2::uuid
            AND batch_id = ANY($3::uuid[])
            AND delta > 0
          ORDER BY batch_id, created_at, id`,
        [query.tenantId, query.companyId, query.batchIds],
      );
      return result.rows.map((row) => ({
        batchId: row.batch_id,
        sourceDocType: row.source_doc_type,
        sourceDocId: row.source_doc_id,
      }));
    },
  },
  stockBatchInspection: {
    inspectBatches,
  },
  stockBatchTransfer: {
    transferBatches,
  },
};
