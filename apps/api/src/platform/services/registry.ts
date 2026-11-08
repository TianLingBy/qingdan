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

/** 库存写入端口：由 inventory 实现，内部就是 `inventory/services/stock-flow.ts`。 */
export interface StockFlowPort {
  applyAdjustment(tx: SqlClient, command: StockAdjustmentCommand): Promise<StockAdjustmentReceipt>;
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
  /**
   * 提成归属人（来源单负责人，D77 ②）。草稿期只记「是谁」，比例在确认结算时按
   * `commission_rate` 配置解析并快照——来源模块不读提成配置，settlement 不读来源表。
   */
  readonly commissionOwnerId?: string | null;
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

/** 员工归属查询（D70 / D80）：调用方不直读 platform 的 `employee_company_position`。 */
export interface EmployeeMembershipQuery {
  readonly tenantId: string;
  readonly companyId: string;
  readonly employeeId: string;
}

/** 员工目录端口：由 platform 实现（员工表归 platform）。 */
export interface EmployeeDirectoryPort {
  /** 该员工在指定公司是否有岗位记录（`employee_company_position` 存在即算，D65）。 */
  belongsToCompany(tx: SqlClient, query: EmployeeMembershipQuery): Promise<boolean>;
}

/** 支付回调查单入参：只按公司 + E 单单号定位，不解析单号前缀。 */
export interface FindSalesOrderByNoInput {
  readonly companyId: string;
  readonly orderNo: string;
}

/** 支付回调可用的销售单快照：金额均为 decimal 字符串（D54）。 */
export interface SalesOrderForPayment {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly totalAmount: string;
  /** 已收款合计（含退款负数行），由 sales 侧 SQL 聚合。 */
  readonly receivedAmount: string;
}

/** 由支付回调生成一笔收款记录的命令。 */
export interface SalesReceiptFromPaymentCommand {
  readonly tenantId: string;
  readonly companyId: string;
  readonly orderId: string;
  readonly amount: string;
  readonly channel: 'wechat' | 'alipay';
  readonly transactionId: string;
  /** 来源渠道 / 第三方交易号等留痕信息。 */
  readonly remark: string;
}

export interface SalesReceiptFromPaymentResult {
  readonly receiptId: string;
}

/**
 * 收款写入端口：由 sales 实现（D70 / #101）。
 *
 * 支付模块不直读 `sales_order` / `sales_receipt`；金额校验所需的余额也由本端口聚合。
 */
export interface SalesReceiptPort {
  findOrderByNo(
    tx: SqlClient,
    input: FindSalesOrderByNoInput,
  ): Promise<SalesOrderForPayment | null>;
  /** 写收款行 + 审计（同事务）；收款写入复用 sales 既有 path。 */
  createReceiptFromPayment(
    tx: SqlClient,
    command: SalesReceiptFromPaymentCommand,
  ): Promise<SalesReceiptFromPaymentResult>;
}

export interface ServiceRegistry {
  readonly stockFlow?: StockFlowPort;
  readonly settlementDraft?: SettlementDraftPort;
  readonly employeeDirectory?: EmployeeDirectoryPort;
  readonly salesReceipt?: SalesReceiptPort;
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

export function employeeDirectoryPort(): EmployeeDirectoryPort {
  if (!registry.employeeDirectory) {
    throw new AppError('NOT_IMPLEMENTED', 'platform 未注册 EmployeeDirectoryPort（D70 / D80）', {
      port: 'EmployeeDirectoryPort',
    });
  }
  return registry.employeeDirectory;
}

export function salesReceiptPort(): SalesReceiptPort {
  if (!registry.salesReceipt) {
    throw new AppError('NOT_IMPLEMENTED', 'sales 未注册 SalesReceiptPort（D70 / #101）', {
      port: 'SalesReceiptPort',
    });
  }
  return registry.salesReceipt;
}
