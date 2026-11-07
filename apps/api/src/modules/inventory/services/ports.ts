import type { ServiceRegistry } from '../../../platform/services/registry.js';
import { applyStockAdjustment } from './stock-flow.js';

/**
 * inventory 对外端口实现（D70）。
 *
 * `applyStockAdjustment` 是全仓唯一允许改批次数量的函数；端口只是把它以稳定的
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
  },
};
