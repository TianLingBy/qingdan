import { z } from 'zod';
import { HEADER_STATES } from './documents.js';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * S 供应商退货契约（契约第一批 §4 / §5.1；F4c / D47 / D51 / D54）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **F4c 只做「退钱」一种**：S 单金额 = 冲减应付 / 收退款记录；
 *   **明确不做「抵下次货款」、不做「换货补发」**——这两型现实不发生，
 *   故本文件**不设 `returnType` / `refundMode` / `onlyRefundKind` 等退货类型字段**；
 * - **金额与数量一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`；
 * - **`refundAmount` 是应退金额，必须为正数**；S 单归属 purchase 模块、
 *   功能域 `supplier_return`（D44 / D62）；
 * - **冲正不物理删除**（D47）：本文件不登记 delete 端点，错账靠追加冲正单据；
 * - 写操作必记审计（D51）；普通读不记（D54 ②）；**登记冲正单据属危险动作，
 *   AI 默认禁止且必须给原因**（D52① / D54 ⑥）。
 *
 * 本批明确不做（等后续批次）：
 * - **不做状态流转 / 完成 / 取消端点**：无关税 / 付款冲减的实现由后续批次落地；
 * - **不做 update / delete**：冲正单据只追加（D47）。
 */

/** 非负 decimal 字符串：数量 / 单价 / 金额（D54 `numeric(18,6)`）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/** 正整数金额：应退金额必须 > 0（F4c）。 */
const PositiveDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（正数、最多 6 位小数）')
  .refine((value) => Number(value) > 0, { message: '退款金额必须 > 0（F4c）' });

/** S 单三态（§10）：直接复用单据框架的 `HEADER_STATES`，不另造枚举。 */
export const SupplierReturnStatusSchema = z.enum(HEADER_STATES);
export type SupplierReturnStatus = z.infer<typeof SupplierReturnStatusSchema>;

/**
 * 商品明细（§5.1）：S 单退货明细，一行可引多个批次（本公司批次，D22）。
 * `amount = qty × unitPrice` 由实现侧计算并落库，契约层只校验类型。
 */
export const SupplierReturnLineSchema = z.object({
  productId: z.string().uuid(),
  /** 一行可引多批次，但至少 1 个（§5.1 / D22）。 */
  batchIds: z.array(z.string().uuid()).min(1, '商品明细至少引用 1 个批次（D22）'),
  qty: NonNegativeDecimal,
  unitPrice: NonNegativeDecimal,
  amount: NonNegativeDecimal,
});
export type SupplierReturnLine = z.infer<typeof SupplierReturnLineSchema>;

/**
 * 供应商退货单实体（§4 / F4c）：
 * - `returnNo` 由服务端按 D16 生成（`S-<公司码4>-<日期8>-<流水4>`）；
 * - **只有「退钱」一种**（F4c）：不设抵下次货款 / 换货补发类型字段；
 * - `refundAmount` 是应退金额（正数），冲减应付 / 收退款记录；
 * - `status` 复用三态（§10），冲正单据不物理删除（D47）。
 */
export const SupplierReturnSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：S 单随原 A 单归属公司，跨公司不可见。 */
  companyId: z.string(),
  /** 单号（服务端按 D16 生成，格式 `S-<公司码4>-<日期8>-<流水4>`）。 */
  returnNo: z.string(),
  /** 关联原 A 单（§4）。 */
  originalPurchaseOrderId: z.string(),
  status: SupplierReturnStatusSchema,
  /** 应退金额，正数（F4c：只做退钱）。 */
  refundAmount: PositiveDecimal,
  /** 商品明细（§5.1）。 */
  lines: z.array(SupplierReturnLineSchema),
  /** 备注可空，≤200。 */
  remark: z.string().max(200).nullable(),
  /** 乐观锁版本。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SupplierReturn = z.infer<typeof SupplierReturnSchema>;

/**
 * 登记供应商退货入参（§4 / F4c）：
 * - 服务端生成 `id` / `tenantId` / `returnNo` / `status` / `version` / 时间戳，客户端**不传**；
 * - **没有退货类型字段**：F4c 只做「退钱」，不抵下次货款、不换货补发；
 * - `lines` 至少 1 行（§5.1）；`refundAmount` 必须为正数。
 */
export const SupplierReturnCreateInputSchema = z.object({
  companyId: z.string().uuid(),
  originalPurchaseOrderId: z.string().uuid(),
  lines: z.array(SupplierReturnLineSchema).min(1, '供应商退货至少 1 行商品明细'),
  refundAmount: PositiveDecimal,
});
export type SupplierReturnCreateInput = z.infer<typeof SupplierReturnCreateInputSchema>;

/**
 * 供应商退货单列表查询：公司 / 原 A 单 / 状态 / 关键字（单号），游标分页。
 * 公司隔离（D15）由服务端按调用者可见公司集合再收口。
 */
export const SupplierReturnListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  originalPurchaseOrderId: z.string().uuid().optional(),
  status: SupplierReturnStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * purchase 模块 S 供应商退货端点（3 条，契约第一批 §4）。
 *
 * 权限：查询 `supplier_return.read`；登记 `supplier_return.create`（scope = domain.action，D44）。
 * 审计：普通读不记（D54 ②）；登记退货记 write（D51）。
 * AI：**登记冲正单据属危险动作，默认禁止且必须给原因**（D52① / D54 ⑥）。
 * 冲正不物理删除（D47）；F4c 只做退钱，不抵下次货款 / 不换货补发。
 */
export const SUPPLIER_RETURN_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'purchase', operationId: 'supplier_return.complete', method: 'POST',
    path: '/api/v1/supplier-returns/{id}/complete', domain: 'supplier_return', action: 'create',
    summary: '确认供应商退货并出库', audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true }, requiresIfMatch: true,
    request: {}, response: { status: 200, schema: SupplierReturnSchema },
  }),
  defineRoute({
    module: 'purchase',
    operationId: 'supplier_return.list.read',
    method: 'GET',
    path: '/api/v1/supplier-returns',
    domain: 'supplier_return',
    action: 'read',
    summary: '供应商退货单列表（按公司/原 A 单/状态/单号检索；普通读不记审计，D15）',
    audit: { kind: 'none' },
    request: { query: SupplierReturnListQuerySchema },
    response: { status: 200, schema: pageSchema(SupplierReturnSchema) },
  }),
  defineRoute({
    module: 'purchase',
    operationId: 'supplier_return.create',
    method: 'POST',
    path: '/api/v1/supplier-returns',
    domain: 'supplier_return',
    action: 'create',
    summary: '登记供应商退货（只做退钱、冲减应付，F4c；AI 禁止冲正 D52）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: SupplierReturnCreateInputSchema },
    response: { status: 201, schema: SupplierReturnSchema },
  }),
  defineRoute({
    module: 'purchase',
    operationId: 'supplier_return.detail.read',
    method: 'GET',
    path: '/api/v1/supplier-returns/{id}',
    domain: 'supplier_return',
    action: 'read',
    summary: '供应商退货单详情（普通读不记审计，D54 ②）',
    audit: { kind: 'none' },
    response: { status: 200, schema: SupplierReturnSchema },
  }),
];
