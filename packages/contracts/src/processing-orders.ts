import { z } from 'zod';
import { HEADER_STATES, type CancelDecision } from './documents.js';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 加工单 B 契约（契约第一批 §3.2 / §5.2 / §9 / §10，第一批第三切）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **金额与数量一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`，避免浮点误差；
 * - **单号由服务端按 D16 生成**（格式 `B-<公司码4>-<日期8>-<流水4>`），创建入参不接收 `orderNo`；
 * - **公司隔离**（D15）：加工单归属某一个公司，跨公司不可见；
 * - **只能引用本公司批次**（D22）：`materialBatchIds` 由实现侧校验批次归属；
 * - **必须至少一条材料投入**（F2b）：包工包料（只收加工费）本质是采购成品，应走 A 单，
 *   不得走 B 单，否则批次成本公式被污染；schema 层用 `refine` 拒绝空数组；
 * - **B 单费用行金额必须 ≥ 0**（D39）：加工费 / 运杂费为负无现实意义，schema 层直接拒绝；
 * - **损耗量由我方人员在验收时一次填入，事后不改**（F3）：创建时可为空（null），
 *   完成端点一次性填入（`POST /complete`），修改入参仍**不接收** `lossQty`；
 * - **状态直接复用** `documents.ts` 的 `HEADER_STATES`（进行中 / 已完成 / 已取消，§10），
 *   不另造英文枚举（D54 §9-6）；
 * - **取消规则复用** `documents.ts` 的 `canCancel` / `assertCancelable`（D21），
 *   本文件不重写一套级联判断；
 * - 写操作必记审计（D51）；普通读不记（D54 ②）。
 *
 * 产出批次与全损耗（完成端点 `processing.order.complete`）：
 * - 可售量 > 0 时，完成时生成产出批次并锁价：
 *   `批次单价 =（引用材料成本 + 辅料 + 加工费 + 运杂费）÷ 可售量`（D5），
 *   材料成本全额进产出批次、只摊量不减价（D5 损耗口径）；
 * - 可售量 = 0（全损耗）→ 需**二次确认**（`confirmFullLoss`），**不生成产出批次**，
 *   材料与加工费**全额记为损失**并留痕（G2 / D26），投入批次库存照常扣减。
 *
 * 本批明确不做（等后续批次）：
 * - **不做损失记录的独立端点**（§9）：损失记录 `lossRecord` 只作为详情里的精简只读视图占位；
 * - **不做「包工包料走 A 单」的运行时校验实现**：F2b 是业务规则，
 *   本批只在 schema 层锁「至少一条材料投入」，跨单类型判断留到实现时补。
 */

/** decimal 字符串（D54 `numeric(18,6)`：最多 12 位整数 + 6 位小数，可负）。 */
const DecimalString = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（最多 6 位小数，D54）');

/** 非负 decimal 字符串：数量 / 单价 / 金额（D54 `numeric(18,6)`）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/** 单头三态（契约第一批 §10）：直接复用单据框架的 `HEADER_STATES`，不另造枚举。 */
export const ProcessingOrderStatusSchema = z.enum(HEADER_STATES);
export type ProcessingOrderStatus = z.infer<typeof ProcessingOrderStatusSchema>;

/**
 * 材料投入行（§3.2 / F2b）：按行记录「批次 + 投入数量」。
 * `qty` 为 decimal 字符串（D54 `numeric(18,6)`，非负）。
 */
export const ProcessingMaterialInputSchema = z.object({
  batchId: z.string().uuid(),
  qty: NonNegativeDecimal,
});
export type ProcessingMaterialInput = z.infer<typeof ProcessingMaterialInputSchema>;

/**
 * 材料投入明细（§3.2 / F2b）：**至少 1 条**，否则拒绝。
 * 只校验形状；「只能引用本公司批次」的归属校验由实现侧按 D22 做；
 * 「各行 `qty` 合计 = 请求体里的 `inputQty`」由开单 / 改单入参在请求体层校验。
 */
export const ProcessingMaterialBatchIdsSchema = z
  .array(ProcessingMaterialInputSchema)
  .refine((rows) => rows.length > 0, {
    message: 'B 单必须至少引用 1 个材料投入批次（F2b；包工包料请走 A 单）',
  });
export type ProcessingMaterialBatchIds = z.infer<typeof ProcessingMaterialBatchIdsSchema>;

/** `numeric(18,6)` 定点整数（微单位，×1e6）：用于精确求和，避免浮点误差。 */
function toMicros(value: string): bigint {
  const [int, frac = ''] = value.split('.');
  return BigInt(`${int}${frac.padEnd(6, '0')}`);
}

/** 判断材料各行 `qty` 合计是否严格等于请求体里的 `inputQty`（定点比较）。 */
function materialQtySumEqualsInput(value: {
  materialBatchIds: readonly { qty: string }[];
  inputQty: string;
}): boolean {
  const sum = value.materialBatchIds.reduce((acc, row) => acc + toMicros(row.qty), 0n);
  return sum === toMicros(value.inputQty);
}

const MATERIAL_QTY_SUM_MESSAGE = '材料投入各行数量合计必须等于投入量 inputQty（F2b / D5）';

/**
 * 归属单（D18 / D35）：可挂 E 或 N 单，选填；用于全损耗损失归属。
 * 只接收 D16 格式的 E / N 单号（`E-0001-20261105-0001` / `N-0001-20261105-0001`）。
 */
const AttributionDocSchema = z
  .string()
  .regex(/^[EN]-\d{4}-\d{8}-\d{4}$/, '归属单必须是 E 或 N 单号（D16 / D35）');

/**
 * 费用明细（§5.2）：加工费 / 运杂费等。
 * **B 单费用行金额必须 ≥ 0（D39）**，在 schema 层用 refine 拒绝，不只是注释。
 */
export const ProcessingOrderFeeSchema = z.object({
  feeName: z.string().min(1).max(64),
  qty: NonNegativeDecimal,
  unitPrice: NonNegativeDecimal,
  amount: DecimalString.refine((value) => Number(value) >= 0, {
    message: 'B 单费用行金额必须 ≥ 0（D39，加工费/运杂费为负无现实意义）',
  }),
  /** 备注可空（§5.2；条件必填只适用于 A 单负数费用）。 */
  remark: z.string().max(255).nullable(),
});
export type ProcessingOrderFee = z.infer<typeof ProcessingOrderFeeSchema>;

/** 创建入参里的费用行：`remark` 可省略（响应实体仍回 `null`）。 */
const ProcessingOrderFeeInputSchema = ProcessingOrderFeeSchema.extend({
  remark: z.string().max(255).nullable().optional(),
});

/**
 * 损失记录精简视图（§9）：详情里只回「损耗量 / 损失金额 / 记录时间」三项，
 * 独立损失记录端点不在本批（后续批次）。
 * 损失金额 = 材料 + 加工费（G2），必须为非负 decimal 字符串（D54）。
 */
export const ProcessingOrderLossRecordSchema = z.object({
  lossQty: NonNegativeDecimal,
  amount: NonNegativeDecimal,
  recordedAt: z.string().datetime(),
});
export type ProcessingOrderLossRecord = z.infer<typeof ProcessingOrderLossRecordSchema>;

/**
 * 加工单实体（§3.2）：`processorName` 为只读回显，单号服务端生成（D16）。
 *
 * 数量口径（D5 / F3）：
 * - `inputQty` 投入量，创建时必须给出；
 * - `lossQty` 损耗量，**创建时可为空，验收时一次填入、事后不改**（F3）；
 * - `sellableQty` 可售量 = 投入量 − 损耗量，**随 `lossQty` 一起为空 / 有值**；
 *   可售量为 0 即全损耗：需二次确认、不生成产出批次、材料与加工费全额记损失（G2 / D26）。
 */
export const ProcessingOrderSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：加工单归属某一个公司，跨公司不可见。 */
  companyId: z.string(),
  /** 单号（服务端按 D16 生成，格式 `B-<公司码4>-<日期8>-<流水4>`）。 */
  orderNo: z.string(),
  processorId: z.string(),
  /** 加工厂名只读回显，避免列表二次查询。 */
  processorName: z.string(),
  /** 成品商品：开单时由契约保证必填；历史单为 null（#150 决策 A）。 */
  outputProductId: z.string().nullable(),
  status: ProcessingOrderStatusSchema,
  /** 经手人（负责人）；无权查看负责人（非老板/经理）时服务端返回 null（Issue #227）。 */
  handlerId: z.string().nullable(),
  /** 材料投入明细（批次 + 行数量）：至少 1 条（F2b）；只能引用本公司批次（D22，实现侧校验）。 */
  materialBatchIds: ProcessingMaterialBatchIdsSchema,
  /** 辅料：选填，默认我方采购，进成本（§3.2）。 */
  auxMaterials: z.string().max(500).nullable(),
  fees: z.array(ProcessingOrderFeeSchema),
  /** 投入量：decimal 字符串（D54 / D5）。 */
  inputQty: NonNegativeDecimal,
  /** 损耗量：创建时可空，验收时一次填入、事后不改（F3）。 */
  lossQty: NonNegativeDecimal.nullable(),
  /** 可售量 = 投入量 − 损耗量；随 `lossQty` 一起为空 / 有值（D5 / F3）。 */
  sellableQty: NonNegativeDecimal.nullable(),
  /** 归属单（E 或 N 单号，选填；D18 / D35）。 */
  attributionDoc: AttributionDocSchema.nullable(),
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProcessingOrder = z.infer<typeof ProcessingOrderSchema>;

/**
 * 「是否可取消」口径（D21）：与 `documents.ts` 的 `CancelDecision` 一一对应，
 * 由实现侧调用 `canCancel` 推导后回给前端，前端直接渲染，不自行重算。
 */
export const ProcessingOrderCancelableSchema: z.ZodType<CancelDecision> = z.object({
  allowed: z.boolean(),
  reason: z.enum(['already_completed', 'already_cancelled', 'has_downstream']).nullable(),
});
export type ProcessingOrderCancelable = z.infer<typeof ProcessingOrderCancelableSchema>;

/**
 * 加工单详情（§3.2）：在列表实体上补产出批次、损失记录与取消判定。
 * - `outputBatchId`：完成前为 null；完成后按 D5 生成产出批次并回填；
 * - `lossRecord`：损失记录精简视图（§9），无损耗时为 null；
 * - `cancelable`：由 `canCancel` 推导（D21）。
 */
export const ProcessingOrderDetailSchema = ProcessingOrderSchema.extend({
  /** 产出批次：完成前为 null；可售量 = 0（全损耗）时也不生成（G2）。 */
  outputBatchId: z.string().nullable(),
  lossRecord: ProcessingOrderLossRecordSchema.nullable(),
  cancelable: ProcessingOrderCancelableSchema,
});
export type ProcessingOrderDetail = z.infer<typeof ProcessingOrderDetailSchema>;

/**
 * 完成加工单入参（D5 / F3 / G2）：
 * - `lossQty` 必填：验收时一次填入、事后不改（F3）；
 * - `custodianId` 选填：损失保管人（uuid）；
 * - `confirmFullLoss` 选填：可售量为 0（全损耗）时必须二次确认（G2 / D26）。
 */
export const ProcessingOrderCompleteBodySchema = z.object({
  lossQty: NonNegativeDecimal,
  custodianId: z.string().uuid().optional(),
  confirmFullLoss: z.boolean().optional(),
});
export type ProcessingOrderCompleteBody = z.infer<typeof ProcessingOrderCompleteBodySchema>;

/** 完成时生成的产出批次（D5）：数量与锁定单价均为 decimal 字符串。 */
export const ProcessingOrderCompleteOutputBatchSchema = z.object({
  id: z.string().uuid(),
  batchNo: z.string(),
  qty: NonNegativeDecimal,
  lockedUnitCost: NonNegativeDecimal,
});
export type ProcessingOrderCompleteOutputBatch = z.infer<typeof ProcessingOrderCompleteOutputBatchSchema>;

/** 完成结果里的损失记录精简视图：损耗量 + 说明。 */
export const ProcessingOrderCompleteLossRecordSchema = z.object({
  lossQty: NonNegativeDecimal,
  description: z.string(),
});
export type ProcessingOrderCompleteLossRecord = z.infer<typeof ProcessingOrderCompleteLossRecordSchema>;

/**
 * 完成加工单结果（D5 / G2）：
 * - 可售量 > 0 时回产出批次（已锁价）；全损耗时 `outputBatch` 为 null；
 * - `lossRecord` 仅在产生损耗时非空（全损耗亦同）。
 */
export const ProcessingOrderCompleteResultSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('已完成'),
  lossQty: NonNegativeDecimal,
  sellableQty: NonNegativeDecimal,
  outputBatch: ProcessingOrderCompleteOutputBatchSchema.nullable(),
  lossRecord: ProcessingOrderCompleteLossRecordSchema.nullable(),
});
export type ProcessingOrderCompleteResult = z.infer<typeof ProcessingOrderCompleteResultSchema>;

/**
 * 加工单列表查询：公司 / 加工厂 / 状态 / 关键字（单号或加工厂名），游标分页。
 * 公司隔离（D15）由服务端按调用者可见公司集合再收口。
 */
export const ProcessingOrderListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  processorId: z.string().uuid().optional(),
  status: ProcessingOrderStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * 开单入参（§3.2）：
 * - **不接收单号**（服务端按 D16 生成）；
 * - 材料投入至少 1 行（F2b），且各行 `qty` 合计必须等于 `inputQty`；
 * - 费用明细至少 1 行、金额 ≥ 0（§3.2 加工费/运杂费必填；D39）；
 * - 损耗量创建时可空（验收时一次填入，F3）；可售量由实现侧计算，不由入参传入。
 */
export const ProcessingOrderCreateInputSchema = z
  .object({
    companyId: z.string().uuid(),
    processorId: z.string().uuid(),
    /** 成品商品：开单必填，完成时据此确定产出批次的商品（#150 决策 A）。 */
    outputProductId: z.string().uuid(),
    handlerId: z.string().uuid(),
    materialBatchIds: ProcessingMaterialBatchIdsSchema,
    inputQty: NonNegativeDecimal,
    auxMaterials: z.string().max(500).nullable().optional(),
    fees: z
      .array(ProcessingOrderFeeInputSchema)
      .min(1, 'B 单至少 1 行费用明细（加工费 / 运杂费，§3.2）'),
    attributionDoc: AttributionDocSchema.nullable().optional(),
    lossQty: NonNegativeDecimal.nullable().optional(),
  })
  .refine(materialQtySumEqualsInput, {
    message: MATERIAL_QTY_SUM_MESSAGE,
    path: ['materialBatchIds'],
  });
export type ProcessingOrderCreateInput = z.infer<typeof ProcessingOrderCreateInputSchema>;

/**
 * 修改入参：全字段可选、至少改一个。
 * **只有「进行中」的加工单可改**（服务端按 D4 状态机校验；状态不是入参）。
 * **不含 `lossQty`**：损耗量验收时一次填入、事后不改（F3）；
 * **不含 `orderNo` / `status` / `sellableQty`**：单号服务端生成、状态走状态机、可售量由实现侧派生。
 * 同时给出 `materialBatchIds` 与 `inputQty` 时，各行 `qty` 合计必须等于 `inputQty`（同请求体校验）。
 */
export const ProcessingOrderUpdateInputSchema = z
  .object({
    processorId: z.string().uuid().optional(),
    /** 成品商品：可选修改（#150 决策 A）。 */
    outputProductId: z.string().uuid().optional(),
    handlerId: z.string().uuid().optional(),
    materialBatchIds: ProcessingMaterialBatchIdsSchema.optional(),
    inputQty: NonNegativeDecimal.optional(),
    auxMaterials: z.string().max(500).nullable().optional(),
    fees: z.array(ProcessingOrderFeeInputSchema).optional(),
    attributionDoc: AttributionDocSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' })
  .refine(
    (value) =>
      value.materialBatchIds === undefined ||
      value.inputQty === undefined ||
      materialQtySumEqualsInput({ materialBatchIds: value.materialBatchIds, inputQty: value.inputQty }),
    { message: MATERIAL_QTY_SUM_MESSAGE, path: ['materialBatchIds'] },
  );
export type ProcessingOrderUpdateInput = z.infer<typeof ProcessingOrderUpdateInputSchema>;

/**
 * processing 模块 B 加工单端点（6 条，共第一批 + 完成）。
 *
 * 权限：`processing.read` / `.create` / `.update` / `.approve` / `.delete`
 *      （scope = domain.action，D44）。
 * 审计：写操作必记（D51）；普通读不记（D54 ②）。
 * AI：**开单 / 完成属业务动作，默认禁止**（与既有写端点口径一致）；
 *     修改允许；**取消属危险动作，默认禁止且必须给原因**（D52① / D54 ⑥）。
 * 并发：update / cancel / complete 强制 If-Match 强 ETag。
 * 取消：规则复用 `documents.ts` 的 `assertCancelable`（D21：有下游不可取消，先取消下游）。
 */
export const PROCESSING_ORDER_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'processing',
    operationId: 'processing.order.list.read',
    method: 'GET',
    path: '/api/v1/processing-orders',
    domain: 'processing',
    action: 'read',
    summary: '加工单列表（按公司/加工厂/状态/单号或加工厂名检索；普通读不记审计，D15）',
    audit: { kind: 'none' },
    request: { query: ProcessingOrderListQuerySchema },
    response: { status: 200, schema: pageSchema(ProcessingOrderSchema) },
  }),
  defineRoute({
    module: 'processing',
    operationId: 'processing.order.create',
    method: 'POST',
    path: '/api/v1/processing-orders',
    domain: 'processing',
    action: 'create',
    summary:
      '开加工单（单号服务端按 D16 生成；至少 1 条材料投入 F2b；费用行 ≥ 0 D39；AI 默认禁止开单）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: ProcessingOrderCreateInputSchema },
    response: { status: 201, schema: ProcessingOrderSchema },
  }),
  defineRoute({
    module: 'processing',
    operationId: 'processing.order.detail.read',
    method: 'GET',
    path: '/api/v1/processing-orders/{id}',
    domain: 'processing',
    action: 'read',
    summary: '加工单详情（含产出批次占位、损失记录与取消判定 cancelable；普通读不记审计，D21/§9）',
    audit: { kind: 'none' },
    response: { status: 200, schema: ProcessingOrderDetailSchema },
  }),
  defineRoute({
    module: 'processing',
    operationId: 'processing.order.update',
    method: 'PATCH',
    path: '/api/v1/processing-orders/{id}',
    domain: 'processing',
    action: 'update',
    summary: '修改加工单（仅「进行中」可改；强 ETag If-Match；损耗量验收时一次填入，F3）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: ProcessingOrderUpdateInputSchema },
    response: { status: 200, schema: ProcessingOrderSchema },
  }),
  defineRoute({
    module: 'processing',
    operationId: 'processing.order.cancel',
    method: 'POST',
    path: '/api/v1/processing-orders/{id}/cancel',
    domain: 'processing',
    action: 'delete',
    summary: '取消加工单（复用 assertCancelable：有下游不可取消、先取消下游；危险动作 AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    response: { status: 200, schema: ProcessingOrderSchema },
  }),
  defineRoute({
    module: 'processing',
    operationId: 'processing.order.complete',
    method: 'POST',
    path: '/api/v1/processing-orders/{id}/complete',
    domain: 'processing',
    action: 'approve',
    summary: '完成加工单：确认损耗、扣材料、生成产出批次并锁价',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    requiresIfMatch: true,
    request: { body: ProcessingOrderCompleteBodySchema },
    response: { status: 200, schema: ProcessingOrderCompleteResultSchema },
  }),
];
