import { AppError } from '@qingdan/contracts';
import type { ServiceRegistry } from '../../../platform/services/registry.js';
import { applyStockAdjustment } from './stock-flow.js';

/**
 * inventory 对外端口实现（D70）。
 *
 * `applyStockAdjustment` 是全仓唯一允许改批次数量的函数；端口只是把它以稳定的
 * interface 暴露给其它模块，**不新增第二条库存写入路径**。
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
    // #162 只上端口签名、不写实现（规格红线）；#137 接线时把本占位替换为
    // 对 createBatch 真实现（stock-flow.ts 的新函数）的调用。届时删除此占位。
    createBatch: async () => {
      throw new AppError('NOT_IMPLEMENTED', '批次入库端口接线归 #137（#162 仅上签名）', {
        port: 'StockFlowPort.createBatch',
      });
    },
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
