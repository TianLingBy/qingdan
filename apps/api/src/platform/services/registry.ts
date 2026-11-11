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

/** 新建库存批次命令（D5 锁价 / D16 取号 / D70 端口；由 A 单入库、B 单产出方发起，#136/#162）。 */
export interface CreateBatchCommand {
  readonly tenantId: string;
  readonly companyId: string;
  readonly productId: string;
  /** 入库数量（A 单按行数量 / B 单产出可售量），decimal 字符串（D54）。 */
  readonly qty: string;
  /** 锁定单价：入库即锁，不随采购价变动（D5）。 */
  readonly lockedUnitCost: string;
  /** 保管人（库存批次责任人，F5）；B 单完成时不传则继承 handler_id，由调用方决定后传入。 */
  readonly custodianId: string;
  /** 来源单据类型：A 采购入库 / B 加工产出。 */
  readonly sourceDocType: 'A' | 'B';
  readonly sourceDocId: string;
  /** 经手人（人类发起人；AI 发起时是委托人，D52）——inventory_flow.handled_by NOT NULL。 */
  readonly handledBy: string;
}

export interface CreateBatchReceipt {
  readonly batchId: string;
  /** 系统取号结果，形如 PB-0001-20261110-0001（D16 变体，platform/numbering 的 takeBatchNo）。 */
  readonly batchNo: string;
  readonly availableQty: string;
  readonly custodianId: string;
}

/** 库存写入端口：由 inventory 实现，内部就是 `inventory/services/stock-flow.ts`。 */
export interface StockFlowPort {
  applyAdjustment(tx: SqlClient, command: StockAdjustmentCommand): Promise<StockAdjustmentReceipt>;
  /** 新建入库批次（只签名；接线归 #137，A 单入库 / B 单产出调用）。 */
  createBatch(tx: SqlClient, command: CreateBatchCommand): Promise<CreateBatchReceipt>;
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

/** 公司订阅查询（一期只读，不拦请求；D1/D12：到期只提示续费）。 */
export interface BillingEntitlementQuery {
  readonly companyId: string;
}

/** 订阅快照：`expiresAt = null` 表示永久。 */
export interface BillingEntitlement {
  readonly plan: string;
  readonly expiresAt: string | null;
  readonly expired: boolean;
  readonly dueSoon: boolean;
}

/** 订阅端口：由 platform 实现（company 表的 plan / expires_at / status）。 */
export interface BillingEntitlementPort {
  getEntitlement(tx: SqlClient, query: BillingEntitlementQuery): Promise<BillingEntitlement>;
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

/**
 * 成本更正的下游引用聚合端口（Issue #163 / D70）。
 *
 * inventory 不得直读 processing / sales / settlement 的表：各模块只注册**只读**来源，
 * 由 platform 的 `downstreamReferencePort()` 聚合，inventory 只调端口。
 */
export interface DownstreamReferenceQuery {
  readonly tenantId: string;
  readonly companyId: string;
  readonly batchId: string;
}

/** 一条下游引用事实：哪个模块、哪种单据、哪个 id、判定时状态。 */
export interface DownstreamReferenceFact {
  readonly module: string;
  readonly docType: string;
  readonly docId: string;
  readonly status: string;
}

/** 各模块自建的单据引用来源（processing / sales 各实现一份，只读 SELECT）。 */
export interface DownstreamReferenceSource {
  readonly module: string;
  findBatchReferences(
    tx: SqlClient,
    query: DownstreamReferenceQuery,
  ): Promise<ReadonlyArray<Omit<DownstreamReferenceFact, 'module'>>>;
}

/** 结算状态查询：按来源单（E / N）判断是否已进入结算。 */
export interface SettlementStatusQuery {
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceDocs: ReadonlyArray<{ readonly docType: string; readonly docId: string }>;
}

export interface SettlementStatusFact {
  readonly docType: string;
  readonly docId: string;
  /** `settlement_order.status`：待确认 / 已结算。 */
  readonly status: string;
}

/** settlement 自建的结算状态来源（只读 SELECT）。 */
export interface SettlementStatusSource {
  findSettlements(
    tx: SqlClient,
    query: SettlementStatusQuery,
  ): Promise<ReadonlyArray<SettlementStatusFact>>;
}

/**
 * 判定结果：
 * - `referenced` = 是否存在下游引用（任一条单据，未取消）；
 * - `settled` = 是否存在对应的结算单（进入结算即锁定成本）。
 */
export interface DownstreamReferenceResult {
  readonly referenced: boolean;
  readonly settled: boolean;
  readonly references: ReadonlyArray<DownstreamReferenceFact>;
}

export interface DownstreamReferencePort {
  inspectBatch(tx: SqlClient, query: DownstreamReferenceQuery): Promise<DownstreamReferenceResult>;
}

/**
 * 期间聚合查询（D70 / D43）：利润报表不直读 settlement / processing 的表，
 * 只按「租户 + 公司集合 + 期间」向两个只读来源取聚合结果。
 */
export interface ProfitAggregateQuery {
  readonly tenantId: string;
  readonly companyIds: readonly string[];
  /** `YYYY-MM-DD`，含当日。 */
  readonly periodStart: string;
  readonly periodEnd: string;
}

/** 已结算 C 单的期间毛利聚合（金额为 decimal 字符串，D54）。 */
export interface SettlementProfitAggregate {
  readonly grossProfit: string;
  readonly netProfit: string;
  /** 参与汇总的已结算 C 单数。 */
  readonly settledOrderCount: number;
}

/** settlement 自建的只读聚合来源（只读 SELECT，不重复做 scope 判定）。 */
export interface SettlementProfitAggregateSource {
  aggregateSettledProfit(
    tx: SqlClient,
    query: ProfitAggregateQuery,
  ): Promise<SettlementProfitAggregate>;
}

/** B 单全损耗期间聚合（金额为 decimal 字符串，D54）。 */
export interface ProcessingLossAggregate {
  readonly lossAmount: string;
  readonly orders: ReadonlyArray<{
    readonly processingOrderId: string;
    readonly processingOrderNo: string;
    readonly lossAmount: string;
    readonly attributed: boolean;
  }>;
}

/** processing 自建的只读聚合来源（只读 SELECT，不重复做 scope 判定）。 */
export interface ProcessingLossAggregateSource {
  aggregateFullLoss(tx: SqlClient, query: ProfitAggregateQuery): Promise<ProcessingLossAggregate>;
}

/** 产物目录（masterdata 实现）：打印取商品名用，禁止 sales 直读 product 表（D70）。 */
export interface ProductDirectoryPort {
  lookupProducts(
    tx: SqlClient,
    query: { tenantId: string; productIds: readonly string[] },
  ): Promise<readonly ProductSummary[]>;
}

export interface ProductSummary {
  readonly id: string;
  readonly productNo: string | null;
  readonly name: string;
  readonly unit: string;
}

/** 批次目录（inventory 实现）：打印取批次号用（sales 不得直读 inventory_batch）。 */
export interface BatchDirectoryPort {
  lookupBatchNos(
    tx: SqlClient,
    query: { tenantId: string; batchIds: readonly string[] },
  ): Promise<readonly BatchSummary[]>;
}

export interface BatchSummary {
  readonly id: string;
  readonly batchNo: string;
}

/** B 单完成使用的库存批次成本/可用量只读端口（D70 / #194）。 */
export interface StockBatchInspectionPort {
  inspectBatches(
    tx: SqlClient,
    query: {
      readonly tenantId: string;
      readonly companyId: string;
      readonly batchIds: readonly string[];
    },
  ): Promise<readonly StockBatchConsumptionSnapshot[]>;
}

export interface StockBatchConsumptionSnapshot {
  readonly batchId: string;
  readonly batchNo: string;
  readonly availableQty: string;
  readonly lockedUnitCost: string;
}

export interface StockBatchTransfer {
  readonly batchId: string;
  /** Omit to transfer the batch's full current in-transit quantity. */
  readonly qty?: string;
}

/** N 单到货确认使用的库存批次转司端口（D22 / D31 / #196）。 */
export interface StockBatchTransferPort {
  transferBatches(
    tx: SqlClient,
    command: {
      readonly tenantId: string;
      readonly fromCompanyId: string;
      readonly toCompanyId: string;
      readonly transfers: readonly StockBatchTransfer[];
    },
  ): Promise<void>;
}

export interface ServiceRegistry {
  readonly stockFlow?: StockFlowPort;
  readonly settlementDraft?: SettlementDraftPort;
  readonly employeeDirectory?: EmployeeDirectoryPort;
  readonly salesReceipt?: SalesReceiptPort;
  readonly billingEntitlement?: BillingEntitlementPort;
  readonly processingReferences?: DownstreamReferenceSource;
  readonly salesReferences?: DownstreamReferenceSource;
  readonly settlementStatus?: SettlementStatusSource;
  readonly settlementProfitAggregate?: SettlementProfitAggregateSource;
  readonly processingLossAggregate?: ProcessingLossAggregateSource;
  readonly productDirectory?: ProductDirectoryPort;
  readonly batchDirectory?: BatchDirectoryPort;
  readonly stockBatchInspection?: StockBatchInspectionPort;
  readonly stockBatchTransfer?: StockBatchTransferPort;
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

export function stockBatchInspectionPort(): StockBatchInspectionPort {
  if (!registry.stockBatchInspection) {
    throw new AppError('NOT_IMPLEMENTED', 'inventory 未注册 StockBatchInspectionPort（D70 / #194）', {
      port: 'StockBatchInspectionPort',
    });
  }
  return registry.stockBatchInspection;
}

export function stockBatchTransferPort(): StockBatchTransferPort {
  if (!registry.stockBatchTransfer) {
    throw new AppError('NOT_IMPLEMENTED', 'inventory 未注册 StockBatchTransferPort（D70 / #196）', {
      port: 'StockBatchTransferPort',
    });
  }
  return registry.stockBatchTransfer;
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

export function productDirectoryPort(): ProductDirectoryPort {
  if (!registry.productDirectory) {
    throw new AppError('NOT_IMPLEMENTED', 'masterdata 未注册 ProductDirectoryPort（D70）', {
      port: 'ProductDirectoryPort',
    });
  }
  return registry.productDirectory;
}

export function batchDirectoryPort(): BatchDirectoryPort {
  if (!registry.batchDirectory) {
    throw new AppError('NOT_IMPLEMENTED', 'inventory 未注册 BatchDirectoryPort（D70）', {
      port: 'BatchDirectoryPort',
    });
  }
  return registry.batchDirectory;
}

export function salesReceiptPort(): SalesReceiptPort {
  if (!registry.salesReceipt) {
    throw new AppError('NOT_IMPLEMENTED', 'sales 未注册 SalesReceiptPort（D70 / #101）', {
      port: 'SalesReceiptPort',
    });
  }
  return registry.salesReceipt;
}

export function billingEntitlementPort(): BillingEntitlementPort {
  if (!registry.billingEntitlement) {
    throw new AppError('NOT_IMPLEMENTED', 'platform 未注册 BillingEntitlementPort（D70）', {
      port: 'BillingEntitlementPort',
    });
  }
  return registry.billingEntitlement;
}

/**
 * 下游引用聚合端口（Issue #163 / D70）。
 *
 * 各来源实现只读 SELECT，不接受 scope 判定；调用方保证已 `withTenant`。
 * 缺少任一必要来源时抛 NOT_IMPLEMENTED，**绝不**把「查不到」降级成「无引用」——
 * 那会让已结算批次被误判成 T1 直接改成本。
 */
export function downstreamReferencePort(): DownstreamReferencePort {
  const sources = [registry.processingReferences, registry.salesReferences].filter(
    (source): source is DownstreamReferenceSource => source !== undefined,
  );
  if (sources.length === 0) {
    throw new AppError('NOT_IMPLEMENTED', '下游模块未注册 DownstreamReferenceSource（D70）', {
      port: 'DownstreamReferencePort',
    });
  }
  return {
    async inspectBatch(tx, query) {
      const collected = await Promise.all(
        sources.map(async (source) => {
          const facts = await source.findBatchReferences(tx, query);
          return facts.map((fact) => ({ ...fact, module: source.module }));
        }),
      );
      const references = collected.flat();
      const sourceDocs = references
        .filter((fact) => fact.docType === 'E' || fact.docType === 'N')
        .map((fact) => ({ docType: fact.docType, docId: fact.docId }));
      let settled = false;
      if (sourceDocs.length > 0) {
        if (!registry.settlementStatus) {
          throw new AppError(
            'NOT_IMPLEMENTED',
            'settlement 未注册 SettlementStatusSource（D70）',
            { port: 'SettlementStatusSource' },
          );
        }
        const settlements = await registry.settlementStatus.findSettlements(tx, {
          tenantId: query.tenantId,
          companyId: query.companyId,
          sourceDocs,
        });
        // 只有「已结算」才锁成本；「待确认」仍算未结算（T2 走审批），
        // 否则刚生成的结算草稿会把人挡在 T3 外面，连审批的机会都没有。
        settled = settlements.some((fact) => fact.status === '已结算');
      }
      return { referenced: references.length > 0, settled, references };
    },
  };
}

/**
 * 期间毛利聚合端口（D43 / D70 / Issue #164）。
 *
 * 缺来源时抛 NOT_IMPLEMENTED，**绝不**把「查不到」降级成 0——那会把「未接线」
 * 显示成「当期毛利为 0」。调用方保证已 `withTenant`。
 */
export function settlementProfitAggregatePort(): SettlementProfitAggregateSource {
  if (!registry.settlementProfitAggregate) {
    throw new AppError(
      'NOT_IMPLEMENTED',
      'settlement 未注册 SettlementProfitAggregateSource（D70 / D43）',
      { port: 'SettlementProfitAggregateSource' },
    );
  }
  return registry.settlementProfitAggregate;
}

/** 期间全损耗聚合端口（D43 / D70 / Issue #164）；同样不以 0 兜底。 */
export function processingLossAggregatePort(): ProcessingLossAggregateSource {
  if (!registry.processingLossAggregate) {
    throw new AppError(
      'NOT_IMPLEMENTED',
      'processing 未注册 ProcessingLossAggregateSource（D70 / D43）',
      { port: 'ProcessingLossAggregateSource' },
    );
  }
  return registry.processingLossAggregate;
}
