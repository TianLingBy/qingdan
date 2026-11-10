import { z } from 'zod';
import { AuditLogSchema } from './audit.js';
import { ScopeMatrixSchema } from './authz.js';
import { ApiErrorBodySchema } from './errors.js';
import { ProductSchema } from './products.js';
import { CustomerSchema } from './customers.js';
import { SupplierSchema } from './suppliers.js';
import { ProcessorQuoteSchema, ProcessorSchema } from './processors.js';
import { PositionSchema } from './positions.js';
import { CompanySchema } from './companies.js';
import { InventoryBatchDetailSchema, InventoryBatchSchema, InventoryFlowSchema } from './inventory.js';
import { InventoryCostAdjustmentSchema } from './cost-adjustments.js';
import { StocktakeDetailSchema, StocktakeSchema } from './stocktakes.js';
import {
  SalesOrderDetailSchema,
  SalesOrderFeeViewSchema,
  SalesOrderLineViewSchema,
  SalesOrderSchema,
} from './sales-orders.js';
import { SalesReceiptSchema } from './sales-receipts.js';
import { CustomerReturnSchema } from './customer-returns.js';
import {
  PurchaseOrderDetailSchema,
  PurchaseOrderFeeViewSchema,
  PurchaseOrderLineViewSchema,
  PurchaseOrderSchema,
} from './purchase-orders.js';
import { SupplierReturnSchema } from './supplier-returns.js';
import {
  ProcessingOrderDetailSchema,
  ProcessingOrderFeeSchema,
  ProcessingOrderSchema,
} from './processing-orders.js';
import {
  InternalTradeOrderDetailSchema,
  InternalTradeOrderLineSchema,
  InternalTradeOrderSchema,
} from './internal-trade-orders.js';
import { SettlementOrderDetailSchema, SettlementOrderSchema } from './settlement-orders.js';
import { CommissionRateSchema } from './commission-rates.js';

/**
 * 契约实体登记表（D57 ①）：每个实体必须在此登记并带 globalRegistry id，
 * OpenAPI 的 components.schemas 必须与这里一一对应（CI 断言数量一致）。
 */
export const ApiTokenSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  employeeId: z.string(),
  name: z.string(),
  scope: ScopeMatrixSchema,
  expiresAt: z.string().datetime().nullable(),
  ipAllowlist: z.array(z.string()),
  lastUsedAt: z.string().datetime().nullable(),
  status: z.enum(['active', 'revoked', 'expired']),
  /** 乐观锁版本（撤销时放进 If-Match；列表接口必须回读，否则第二次写只能猜）。 */
  version: z.number().int(),
  createdBy: z.string(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;
z.globalRegistry.add(ApiTokenSchema, { id: 'ApiToken' });

/** 创建响应：明文 secret 只在创建时返回一次，服务端只存 SHA-256（契约第三批 §2）。 */
export const ApiTokenCreatedSchema = ApiTokenSchema.extend({ secret: z.string() });
export type ApiTokenCreated = z.infer<typeof ApiTokenCreatedSchema>;
z.globalRegistry.add(ApiTokenCreatedSchema, { id: 'ApiTokenCreated' });

z.globalRegistry.add(ApiErrorBodySchema, { id: 'ApiErrorBody' });

/** 商品（契约第一批 §2 / Issue #15）：实体定义在 `products.ts`，这里只做登记。 */
z.globalRegistry.add(ProductSchema, { id: 'Product' });

/** 客户（契约第一批 §2 / masterdata 第二切）：实体定义在 `customers.ts`，这里只做登记。 */
z.globalRegistry.add(CustomerSchema, { id: 'Customer' });

/** 供应商（契约第一批 §2 / masterdata 第三切）：实体定义在 `suppliers.ts`，这里只做登记。 */
z.globalRegistry.add(SupplierSchema, { id: 'Supplier' });

/** 加工厂（契约第一批 §2 / masterdata 第四切）：实体定义在 `processors.ts`，这里只做登记。 */
z.globalRegistry.add(ProcessorSchema, { id: 'Processor' });

/** 加工厂报价记录（D64 / 独立子表 processor_quote）：实体定义在 `processors.ts`。 */
z.globalRegistry.add(ProcessorQuoteSchema, { id: 'ProcessorQuote' });

/** 岗位（权限模板，D4/D60②）：实体定义在 `positions.ts`。 */
z.globalRegistry.add(PositionSchema, { id: 'Position' });

/** 公司（D16 公司码）：实体定义在 `companies.ts`。 */
z.globalRegistry.add(CompanySchema, { id: 'Company' });

/** 库存批次（Issue #48 / D67）：实体定义在 `inventory.ts`。 */
z.globalRegistry.add(InventoryBatchSchema, { id: 'InventoryBatch' });

/** 库存批次详情（含待执行占用来源，D38 / D67⑤）：实体定义在 `inventory.ts`。 */
z.globalRegistry.add(InventoryBatchDetailSchema, { id: 'InventoryBatchDetail' });

/** 库存流水（只追加，D2① / D67④）：实体定义在 `inventory.ts`。 */
z.globalRegistry.add(InventoryFlowSchema, { id: 'InventoryFlow' });

/** 库存成本更正（只改成本不改数量，Issue #163 / D70）：实体定义在 `cost-adjustments.ts`。 */
z.globalRegistry.add(InventoryCostAdjustmentSchema, { id: 'InventoryCostAdjustment' });

/** 盘点调整单 I（契约第一批 §4；D16 / D47 / D54）：实体定义在 `stocktakes.ts`。 */
z.globalRegistry.add(StocktakeSchema, { id: 'Stocktake' });

/** 盘点调整单详情（含审批判定，§4 / D47）：实体定义在 `stocktakes.ts`。 */
z.globalRegistry.add(StocktakeDetailSchema, { id: 'StocktakeDetail' });

/** 销售单 E（契约第一批 §3.3 / D16 / D39）：实体定义在 `sales-orders.ts`。 */
z.globalRegistry.add(SalesOrderSchema, { id: 'SalesOrder' });

/** 销售单商品明细（§5.1 / D22）：实体定义在 `sales-orders.ts`。 */
z.globalRegistry.add(SalesOrderLineViewSchema, { id: 'SalesOrderLine' });

/** 销售单费用明细（§5.2 / D39）：实体定义在 `sales-orders.ts`。 */
z.globalRegistry.add(SalesOrderFeeViewSchema, { id: 'SalesOrderFee' });

/** 销售单详情（含收款记录与取消判定，§3.3 / D21 / D24）：实体定义在 `sales-orders.ts`。 */
z.globalRegistry.add(SalesOrderDetailSchema, { id: 'SalesOrderDetail' });

/** 收款记录（§6 / D24 / D34）：内嵌 E 单详情页，退款为负数行；实体定义在 `sales-receipts.ts`。 */
z.globalRegistry.add(SalesReceiptSchema, { id: 'SalesReceipt' });

/** R 客户退货单（契约第一批 §4；D36 / D40 / D47）：实体定义在 `customer-returns.ts`。 */
z.globalRegistry.add(CustomerReturnSchema, { id: 'CustomerReturn' });

/** 采购单 A（契约第一批 §3.1 / D16 / D39）：实体定义在 `purchase-orders.ts`。 */
z.globalRegistry.add(PurchaseOrderSchema, { id: 'PurchaseOrder' });

/** 采购单商品明细（§5.1；A 单不引用批次，入库时生成批次）：实体定义在 `purchase-orders.ts`。 */
z.globalRegistry.add(PurchaseOrderLineViewSchema, { id: 'PurchaseOrderLine' });

/** 采购单费用明细（§5.2 / D39；A 单可负、负数必填备注）：实体定义在 `purchase-orders.ts`。 */
z.globalRegistry.add(PurchaseOrderFeeViewSchema, { id: 'PurchaseOrderFee' });

/** 采购单详情（含取消判定，§3.1 / D21）：实体定义在 `purchase-orders.ts`。 */
z.globalRegistry.add(PurchaseOrderDetailSchema, { id: 'PurchaseOrderDetail' });

/** S 供应商退货单（契约第一批 §4；F4c 只做退钱）：实体定义在 `supplier-returns.ts`。 */
z.globalRegistry.add(SupplierReturnSchema, { id: 'SupplierReturn' });

/** 加工单 B（契约第一批 §3.2 / D5 / D16 / D39 / F2b）：实体定义在 `processing-orders.ts`。 */
z.globalRegistry.add(ProcessingOrderSchema, { id: 'ProcessingOrder' });

/** 加工单费用明细（§5.2 / D39；B 单费用行一律 ≥ 0）：实体定义在 `processing-orders.ts`。 */
z.globalRegistry.add(ProcessingOrderFeeSchema, { id: 'ProcessingOrderFee' });

/** 加工单详情（含产出批次占位、损失记录与取消判定，§3.2 / §9 / D21）：实体定义在 `processing-orders.ts`。 */
z.globalRegistry.add(ProcessingOrderDetailSchema, { id: 'ProcessingOrderDetail' });

/** 内部交易单 N（契约第二批 §1 / D22 / D68）：实体定义在 `internal-trade-orders.ts`。 */
z.globalRegistry.add(InternalTradeOrderSchema, { id: 'InternalTradeOrder' });

/** 内部交易单商品明细（引用发出公司批次，至少 1 条；§1 / D22）：实体定义在 `internal-trade-orders.ts`。 */
z.globalRegistry.add(InternalTradeOrderLineSchema, { id: 'InternalTradeOrderLine' });

/** 内部交易单详情（含四态取消判定，§1 / D21 / D68②）：实体定义在 `internal-trade-orders.ts`。 */
z.globalRegistry.add(InternalTradeOrderDetailSchema, { id: 'InternalTradeOrderDetail' });

/** C 结算单（契约第一批 §3.4 / D5 / D19 / D33 / D36）：实体定义在 `settlement-orders.ts`。 */
z.globalRegistry.add(SettlementOrderSchema, { id: 'SettlementOrder' });

/** C 结算单详情（含确认判定，§3.4 / D19）：实体定义在 `settlement-orders.ts`。 */
z.globalRegistry.add(SettlementOrderDetailSchema, { id: 'SettlementOrderDetail' });

/** 员工列表里的公司-岗位对（D15：一人多岗 + 公司隔离）。 */
const EmployeeCompanySchema = z.object({
  companyId: z.string(),
  companyName: z.string(),
  positionId: z.string(),
  positionName: z.string(),
});

/**
 * 员工列表摘要（D15 / D50）：列表只回脱敏手机号，完整手机号不出服务端。
 * `phoneMasked` 形如 `100****0001`（前 3 位 + `****` + 后 4 位）。
 */
export const EmployeeSummarySchema = z.object({
  id: z.string(),
  employeeNo: z.string(),
  name: z.string(),
  status: z.enum(['在职', '停用']),
  isOwner: z.boolean(),
  phoneMasked: z.string(),
  companies: z.array(EmployeeCompanySchema),
});
export type EmployeeSummary = z.infer<typeof EmployeeSummarySchema>;
z.globalRegistry.add(EmployeeSummarySchema, { id: 'EmployeeSummary' });

/**
 * 员工写端点返回实体：在列表摘要口径上补 `version`（修改/停用后客户端要拿新版本继续并发写）。
 * 手机号仍只回 `phoneMasked`，完整手机号不出服务端。
 */
export const EmployeeSchema = z.object({
  ...EmployeeSummarySchema.shape,
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
});
export type Employee = z.infer<typeof EmployeeSchema>;
z.globalRegistry.add(EmployeeSchema, { id: 'Employee' });

export const ENTITIES = [
  { name: 'AuditLog', schema: AuditLogSchema },
  { name: 'ApiToken', schema: ApiTokenSchema },
  { name: 'ApiTokenCreated', schema: ApiTokenCreatedSchema },
  { name: 'ApiErrorBody', schema: ApiErrorBodySchema },
  { name: 'EmployeeSummary', schema: EmployeeSummarySchema },
  { name: 'Employee', schema: EmployeeSchema },
  { name: 'Product', schema: ProductSchema },
  { name: 'Customer', schema: CustomerSchema },
  { name: 'Supplier', schema: SupplierSchema },
  { name: 'Processor', schema: ProcessorSchema },
  { name: 'ProcessorQuote', schema: ProcessorQuoteSchema },
  { name: 'Position', schema: PositionSchema },
  { name: 'Company', schema: CompanySchema },
  { name: 'InventoryBatch', schema: InventoryBatchSchema },
  { name: 'InventoryBatchDetail', schema: InventoryBatchDetailSchema },
  { name: 'InventoryFlow', schema: InventoryFlowSchema },
  { name: 'InventoryCostAdjustment', schema: InventoryCostAdjustmentSchema },
  { name: 'Stocktake', schema: StocktakeSchema },
  { name: 'StocktakeDetail', schema: StocktakeDetailSchema },
  { name: 'SalesOrder', schema: SalesOrderSchema },
  { name: 'SalesOrderLine', schema: SalesOrderLineViewSchema },
  { name: 'SalesOrderFee', schema: SalesOrderFeeViewSchema },
  { name: 'SalesOrderDetail', schema: SalesOrderDetailSchema },
  { name: 'SalesReceipt', schema: SalesReceiptSchema },
  { name: 'CustomerReturn', schema: CustomerReturnSchema },
  { name: 'PurchaseOrder', schema: PurchaseOrderSchema },
  { name: 'PurchaseOrderLine', schema: PurchaseOrderLineViewSchema },
  { name: 'PurchaseOrderFee', schema: PurchaseOrderFeeViewSchema },
  { name: 'PurchaseOrderDetail', schema: PurchaseOrderDetailSchema },
  { name: 'SupplierReturn', schema: SupplierReturnSchema },
  { name: 'ProcessingOrder', schema: ProcessingOrderSchema },
  { name: 'ProcessingOrderFee', schema: ProcessingOrderFeeSchema },
  { name: 'ProcessingOrderDetail', schema: ProcessingOrderDetailSchema },
  { name: 'InternalTradeOrder', schema: InternalTradeOrderSchema },
  { name: 'InternalTradeOrderLine', schema: InternalTradeOrderLineSchema },
  { name: 'InternalTradeOrderDetail', schema: InternalTradeOrderDetailSchema },
  { name: 'SettlementOrder', schema: SettlementOrderSchema },
  { name: 'SettlementOrderDetail', schema: SettlementOrderDetailSchema },
  { name: 'CommissionRate', schema: CommissionRateSchema },
] as const;
