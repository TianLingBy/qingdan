import type { ServiceRegistry } from '../../../platform/services/registry.js';
import { applyStockAdjustment, applyStockReservation } from './stock-flow.js';

/**
 * inventory 对外端口实现（D70）。
 *
 * `stock-flow.ts` 是唯一改 `inventory_batch` 的地方；端口只是把它以稳定的
 * interface 暴露给其它模块，**不新增第二条库存写入路径**。
 */
export const inventoryServices: Pick<ServiceRegistry, 'stockFlow'> = {
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
    reserveInTransit: async (tx, command) =>
      applyStockReservation(tx, {
        tenantId: command.tenantId,
        companyId: command.companyId,
        batchId: command.batchId,
        delta: command.delta,
        sourceDocType: command.sourceDocType,
        sourceDocId: command.sourceDocId,
        handledBy: command.handledBy,
      }),
  },
};
