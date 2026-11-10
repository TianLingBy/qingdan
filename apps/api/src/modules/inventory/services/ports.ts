import type { ServiceRegistry } from '../../../platform/services/registry.js';
import {
  applyStockAdjustment,
  createBatch as createStockBatch,
} from './stock-flow.js';

/**
 * inventory 对外端口实现（D70）。
 *
 * 批次创建与数量调整都收口在本模块服务函数；端口只做稳定 interface 映射，
 * **不新增第二条库存写入路径**。
 */
export const inventoryServices: Pick<ServiceRegistry, 'stockFlow' | 'batchDirectory'> = {
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
  },
};
