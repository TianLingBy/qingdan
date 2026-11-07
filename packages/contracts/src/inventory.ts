import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 库存契约（inventory 首批只读，Issue #48 / D67）。
 *
 * **本批不登记任何 HTTP 写端点**：库存数字只能经 A / B / E / N / I / R / S 等单据用例
 * 调用 inventory 服务函数变更，不开放「直接改库存」的 HTTP 入口——否则会绕过单据、
 * 占用生命周期（提交即占用、取消释放、出库转已引用，D41）与审计（D51）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **数量与金额一律 decimal 字符串**（D54 `numeric(18,6)`），不用 `number`，避免浮点误差；
 * - **`remainingQty` / `availableQty` 是数据库生成列**（D67②），只读：
 *   `remaining_qty = inbound_qty - referenced_qty`、
 *   `available_qty = remaining_qty - in_transit_qty - pending_execution_qty`；
 *   应用角色不得写这两列，契约里也不提供任何写入入口；
 * - **可用量是唯一可引用数字**（D38）；四列口径见 D38，出库语义见 D41；
 * - **库存流水只追加**（D2① / D67④）：没有 update / delete，错账走冲正单据；
 * - 普通读不记审计（D54 ②）。
 */

/** 非负 decimal 字符串：数量与锁定单价（D54 `numeric(18,6)`，最多 6 位小数）。 */
const NonNegativeDecimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

/** 可负 decimal 字符串：库存流水变动量正入负出（D2① / D41）。 */
const SignedDecimal = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, '变动量必须是 decimal 字符串（可负、最多 6 位小数）');

/**
 * 批次待执行占用的来源（D67⑤：一期不建占用明细表，先从流水/单据反查）。
 * `qty` 为 decimal 字符串，与被占用批次的 `pendingExecutionQty` 同口径。
 */
export const PendingOccupancySchema = z.object({
  sourceDocType: z.string(),
  sourceDocId: z.string(),
  qty: NonNegativeDecimal,
});
export type PendingOccupancy = z.infer<typeof PendingOccupancySchema>;

/**
 * 库存批次（D67）：四个基础列持久化 + 两个派生列由数据库生成。
 *
 * 批次号由系统取号（D16），与商品经 `productId` 关联、不依赖商品编号（D49）。
 * `lockedUnitCost` 在 A 单入库或 B 单产出时锁定（D5），受「看价」权限约束（D27）。
 */
export const InventoryBatchSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：批次归属某一个公司，跨公司不可见；N 单在途批次仍归发出方（D22）。 */
  companyId: z.string(),
  productId: z.string(),
  /** 批次号（系统自动取号，D16）。 */
  batchNo: z.string(),
  /** 锁定单价：decimal 字符串（D54 / D5）。 */
  lockedUnitCost: NonNegativeDecimal,
  /** 入库量：decimal 字符串，基础列（D67①）。 */
  inboundQty: NonNegativeDecimal,
  /** 已引用量：decimal 字符串，基础列（D67①）。 */
  referencedQty: NonNegativeDecimal,
  /**
   * 剩余量：**数据库生成列**（D67②），只读。
   * `remaining_qty = inbound_qty - referenced_qty`。
   */
  remainingQty: NonNegativeDecimal,
  /** 在途占用：decimal 字符串，基础列（D67① / D22 / D31）。 */
  inTransitQty: NonNegativeDecimal,
  /** 待执行占用：decimal 字符串，基础列（D67① / D38 / D41）。 */
  pendingExecutionQty: NonNegativeDecimal,
  /**
   * 可用量：**数据库生成列**（D67②），只读，是唯一可引用数字（D38）。
   * `available_qty = remaining_qty - in_transit_qty - pending_execution_qty`。
   */
  availableQty: NonNegativeDecimal,
  /** 保管人（实物责任，F5）；变更需留痕。 */
  custodianId: z.string(),
  /** 乐观锁版本：后续写用例（经单据调用）用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InventoryBatch = z.infer<typeof InventoryBatchSchema>;

/**
 * 批次详情：在列表实体上补商品展示信息与待执行占用来源（D38 行详情 / D67⑤）。
 * 不新增任何可写字段；`productNo` 按 D49 是自由文本、可空。
 */
export const InventoryBatchDetailSchema = InventoryBatchSchema.extend({
  productName: z.string(),
  productNo: z.string().nullable(),
  pendingOccupancies: z.array(PendingOccupancySchema),
});
export type InventoryBatchDetail = z.infer<typeof InventoryBatchDetailSchema>;

/**
 * 库存流水（D2① / D67④）：只追加，与单据同事务写入。
 * `delta` 正入负出；没有 `version` / `updatedAt`——流水落表后不再修改。
 */
export const InventoryFlowSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：流水跟随批次归属公司。 */
  companyId: z.string(),
  /** 指向批次 `inventory_batch.id`。 */
  batchId: z.string(),
  /** 变动量：可负的 decimal 字符串（正入负出，D2① / D41）。 */
  delta: SignedDecimal,
  /** 来源单据类型（A / B / E / N / I / R / S 等，由各单据模块登记）。 */
  sourceDocType: z.string(),
  /** 来源单据 id。 */
  sourceDocId: z.string(),
  /** 经手人。 */
  handledBy: z.string(),
  occurredAt: z.string().datetime(),
});
export type InventoryFlow = z.infer<typeof InventoryFlowSchema>;

/**
 * 批次列表查询：按公司 / 商品 / 关键字（匹配批次号或商品名）过滤，游标分页。
 * 公司隔离（D15）由服务端按调用者可见公司集合再收口。
 */
export const InventoryBatchListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * 库存流水查询：按公司 / 批次 / 来源单据过滤，游标分页。
 * 来源单据类型与 id 是自由取值，枚举由各单据模块自行登记，本批不收口。
 */
export const InventoryFlowListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  batchId: z.string().min(1).optional(),
  sourceDocType: z.string().min(1).max(32).optional(),
  sourceDocId: z.string().min(1).max(64).optional(),
});

/**
 * inventory 首批端点（共 3 条，全部只读）。
 *
 * 权限：`inventory_qty.read`（批次）/ `inventory_flow.read`（流水）——
 *   scope 按功能域拆分（D44），operationId 用 `inventory.*` 伞名（Issue #48）。
 * 审计：普通读不记（D54 ②）。
 * 写入口：**本批不登记**；库存写入只能经单据用例（Issue #48 §2）。
 */
export const INVENTORY_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'inventory',
    operationId: 'inventory.batch.list.read',
    method: 'GET',
    path: '/api/v1/inventory/batches',
    domain: 'inventory_qty',
    action: 'read',
    summary: '库存批次列表（按公司/商品/批次号或商品名检索；普通读不记审计，D38）',
    audit: { kind: 'none' },
    request: { query: InventoryBatchListQuerySchema },
    response: { status: 200, schema: pageSchema(InventoryBatchSchema) },
  }),
  defineRoute({
    module: 'inventory',
    operationId: 'inventory.batch.detail.read',
    method: 'GET',
    path: '/api/v1/inventory/batches/{id}',
    domain: 'inventory_qty',
    action: 'read',
    summary: '库存批次详情（四列口径 + 待执行占用来源；普通读不记审计，D38/D67）',
    audit: { kind: 'none' },
    response: { status: 200, schema: InventoryBatchDetailSchema },
  }),
  defineRoute({
    module: 'inventory',
    operationId: 'inventory.flow.read',
    method: 'GET',
    path: '/api/v1/inventory/flows',
    domain: 'inventory_flow',
    action: 'read',
    summary: '库存流水列表（按公司/批次/来源单据检索；只追加流水，普通读不记审计，D2①/D67④）',
    audit: { kind: 'none' },
    request: { query: InventoryFlowListQuerySchema },
    response: { status: 200, schema: pageSchema(InventoryFlowSchema) },
  }),
];
