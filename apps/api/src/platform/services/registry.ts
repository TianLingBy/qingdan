import { AppError } from '@qingdan/contracts';
import type { SqlClient } from '../db/client.js';

/**
 * 模块间调用通道（D70 / Issue #79）。
 *
 * 业务模块之间**只允许**经由这里的端口互相调用：
 *   - 端口是纯 TypeScript interface，调用方只 import 类型，不 import 对方 `repo*.ts` / `schema.ts`；
 *   - 调用方把**当前业务事务的 tx** 传进来 → 同事务、同回滚；
 *   - 端口实现**不得**自己开事务、不得 `withTenant`（租户上下文由调用方保证已 `set app.tenant_id`）；
 *   - 端口实现只做业务前置校验（批次存在、数量非负、来源单未结算过等），
 *     **不重复做 scope 判定**——权限仍由人类发起人的 scope 决定（D52）。
 *
 * 每个端口由实现方在 `register<Module>Services()` 里注册，`registerModules()` 统一调用。
 */

/** 库存调整命令（D70；由盘点/后续出入库单据发起）。 */
export interface StockAdjustmentCommand {
  readonly tenantId: string;
  readonly companyId: string;
  readonly batchId: string;
  /** 有符号数量变化：增加为正、减少为负（decimal 字符串，D54）。 */
  readonly delta: string;
  /** 来源单据类型，如 `stocktake` / `sales_order`。 */
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  /** 经手人（人类发起人；AI 发起时是委托人，D52）。 */
  readonly handledBy: string;
}

export interface StockAdjustmentReceipt {
  readonly inboundQty: string;
  readonly availableQty: string;
  /** 批次实物责任人快照，供调用方写审计留痕（F5 / #84）。 */
  readonly custodianId: string;
}

/**
 * 在途占用命令（D68③ / D73；由 N 单发货发起）。
 *
 * 与 `StockAdjustmentCommand` 的区别：**在途占用不改入库量、不写库存流水**——
 * 它只是「锁定可用量」（D31），批次实物仍在发出公司；真正的库存减少要到到货确认 / 出库。
 * `delta > 0` 锁定、`delta < 0` 释放。
 */
export interface StockReservationCommand {
  readonly tenantId: string;
  readonly companyId: string;
  readonly batchId: string;
  /** 有符号在途量变化：锁定为正、释放为负（decimal 字符串，D54）。 */
  readonly delta: string;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  readonly handledBy: string;
}

export interface StockReservationReceipt {
  readonly inTransitQty: string;
  readonly availableQty: string;
  readonly custodianId: string;
}

/**
 * 内部交易「到货确认 / 转司」命令（D31 / D74 / D75；由 N 单到货确认发起）。
 *
 * 同一行上做两件事：释放本次在途占用 + 把批次 `company_id` 改成接收公司。
 * **不改入库量、不写库存流水**（转司不改变数量，D47）。
 */
export interface OwnershipTransferCommand {
  readonly tenantId: string;
  /** 原归属公司（发出公司）。 */
  readonly companyId: string;
  /** 转入公司（接收公司）。 */
  readonly toCompanyId: string;
  readonly batchId: string;
  /** 本次释放的在途占用量。 */
  readonly delta: string;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  readonly handledBy: string;
}

export interface OwnershipTransferReceipt {
  readonly inTransitQty: string;
  readonly availableQty: string;
  /** 批次锁价成本（D5），供调用方算 C 草稿总成本（D75：N 单行没有 cost_floor）。 */
  readonly lockedUnitCost: string;
  readonly custodianId: string;
}

/** 库存写入端口：由 inventory 实现，内部就是 `inventory/services/stock-flow.ts`。 */
export interface StockFlowPort {
  applyAdjustment(tx: SqlClient, command: StockAdjustmentCommand): Promise<StockAdjustmentReceipt>;
  /** 在途占用 / 释放（D68③）：只动 `in_transit_qty`，可用量由生成列自动跟随。 */
  reserveInTransit(
    tx: SqlClient,
    command: StockReservationCommand,
  ): Promise<StockReservationReceipt>;
  /** 到货确认转司（D31 / D74）：释放在途占用 + 批次归属公司变更，同事务。 */
  transferOwnership(
    tx: SqlClient,
    command: OwnershipTransferCommand,
  ): Promise<OwnershipTransferReceipt>;
}

/** C 结算单草稿命令（D19 / D70；由 E / N 单完成方发起）。 */
export interface SettlementDraftCommand {
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceDocType: 'E' | 'N';
  readonly sourceDocId: string;
  /** 金额由来源模块自己算好传入——settlement 不读来源表（D70 / D19）。 */
  readonly totalSaleAmount: string;
  readonly totalCostAmount: string;
  readonly relatedLossAmount?: string;
  readonly commissionRateSnapshot: string;
  readonly commissionAmount: string;
  /** 人类发起人（AI 发起时是委托人）。 */
  readonly createdBy: string;
  readonly requestId?: string | null;
}

export interface SettlementDraftReceipt {
  readonly id: string;
  readonly orderNo: string;
  readonly version: number;
  /** 实现方写入的审计 outbox id；调用方提交后自行 `flushAuditOutbox`（D70 ④）。 */
  readonly auditId: string;
}

/** 结算草稿端口：由 settlement 实现。 */
export interface SettlementDraftPort {
  createDraft(tx: SqlClient, command: SettlementDraftCommand): Promise<SettlementDraftReceipt>;
}

export interface ServiceRegistry {
  readonly stockFlow?: StockFlowPort;
  readonly settlementDraft?: SettlementDraftPort;
}

let registry: ServiceRegistry = {};

/** 注册（可多次调用、按端口合并）；同一端口重复注册以后者为准。 */
export function registerServices(services: ServiceRegistry): void {
  registry = { ...registry, ...services };
}

/** 测试用：清空注册表。 */
export function resetServices(): void {
  registry = {};
}

export function stockFlowPort(): StockFlowPort {
  if (!registry.stockFlow) {
    throw new AppError('NOT_IMPLEMENTED', 'inventory 未注册 StockFlowPort（D70）', {
      port: 'StockFlowPort',
    });
  }
  return registry.stockFlow;
}

export function settlementDraftPort(): SettlementDraftPort {
  if (!registry.settlementDraft) {
    throw new AppError('NOT_IMPLEMENTED', 'settlement 未注册 SettlementDraftPort（D70）', {
      port: 'SettlementDraftPort',
    });
  }
  return registry.settlementDraft;
}
