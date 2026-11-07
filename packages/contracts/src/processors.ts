import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 加工厂资料契约（masterdata 第四切，契约第一批 §2）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **编号 `processorNo` 是自由文本、可空、不唯一、不作全局检索主键**（D49）——
 *   定位加工厂走「进入某公司 → 按名称/联系人查看」，编号只给人看和对账；
 * - **公司隔离**（D15）：加工厂属于某一个公司，跨公司不可见；
 * - **加工厂主表只存基础资料**（D64 ①）：历史加工价 / 比价记录由独立的
 *   `processor_quote` 子表承载，主表不得「顺手」加价格列；
 * - **报价只增不改**（D64 ④）：一次报价一行，不提供 update / delete 端点；
 * - 写操作必记审计（D51）；停用属危险动作，AI 默认禁止（D52① / D54 危险动作清单）。
 */

/** 加工厂状态：停用后不出现在单据选加工厂弹窗（与商品/客户/供应商同款）。 */
export const ProcessorStatusSchema = z.enum(['启用', '停用']);

export const ProcessorSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：加工厂属于某一个公司，跨公司不可见。 */
  companyId: z.string(),
  /** D49：自由文本编号，可空；后台不改写、不做唯一校验、不作检索主键。 */
  processorNo: z.string().nullable(),
  name: z.string(),
  contactName: z.string().nullable(),
  status: ProcessorStatusSchema,
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Processor = z.infer<typeof ProcessorSchema>;

/**
 * 日期：`yyyy-mm-dd`（D64 ② `quote_date`）。
 * 校验真实日历日（不是 4-2-2 形状检查），避免 `2026-13-01` 落表。
 */
const QuoteDateSchema = z.iso.date();

/**
 * 单价：decimal 字符串，最多 6 位小数（D54 `numeric(18,6)`）。
 * 与 `products.ts` 的金额正则保持一致；两处都未导出，改动时须同步。
 */
const UnitPriceSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '单价必须是 decimal 字符串，最多 6 位小数');

/**
 * 加工厂报价记录（D64）：一次报价一行，独立子表 `processor_quote`。
 * **只增不改**——记录落表后不提供修改/删除（D64 ④），避免比价历史被改写。
 */
export const ProcessorQuoteSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：报价记录跟随加工厂归属公司。 */
  companyId: z.string(),
  /** 指向 `processor.id`（D64 ②）。 */
  processorId: z.string(),
  /** 报价日期，`yyyy-mm-dd`；比价按「工序 + 日期区间」查询（D64 ③）。 */
  quoteDate: QuoteDateSchema,
  /** 工序名称（比价主键之一，D64 ③）。 */
  processName: z.string(),
  /** 单价 decimal 字符串（D54；DB numeric(18,6)）。 */
  unitPrice: UnitPriceSchema,
  remark: z.string().nullable(),
  /** 乐观锁版本：只增不改，但实体仍带版本以保持契约形状一致。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProcessorQuote = z.infer<typeof ProcessorQuoteSchema>;

/**
 * 加工厂列表查询：`keyword` 只匹配名称/联系人（D49），不支持按编号全局搜。
 * 分页沿用通用游标（`PageQuerySchema`）。
 */
export const ProcessorListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  status: ProcessorStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/**
 * 报价记录列表查询（D64 ③）：比价走「工序 + 日期区间」。
 * 三个过滤条件都可选；分页沿用通用游标。
 */
export const ProcessorQuoteListQuerySchema = PageQuerySchema.extend({
  processorId: z.string().optional(),
  processName: z.string().min(1).max(64).optional(),
  from: QuoteDateSchema.optional(),
  to: QuoteDateSchema.optional(),
});

/** 可选字段（`name` 在创建时必填，故单独声明，避免展开覆盖）。 */
const processorOptionalFields = {
  processorNo: z.string().max(64).nullable().optional(),
  contactName: z.string().max(64).nullable().optional(),
  status: ProcessorStatusSchema.optional(),
} as const;

export const ProcessorCreateInputSchema = z.object({
  /** 公司隔离（D15）：创建时必须显式给出归属公司，服务端再校验调用者可见性。 */
  companyId: z.string().uuid(),
  name: z.string().min(1).max(64),
  ...processorOptionalFields,
});

/** 更新：全字段可选、至少要改一个；`companyId` 不可改（换公司 = 新加工厂）。 */
export const ProcessorUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    ...processorOptionalFields,
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });

/**
 * 报价落表入参（D64 ④ 只增）：创建后不可改，故没有对应的 Update 入参。
 * `remark` 长度上限先按 256 收口，待负责人拍板。
 */
export const ProcessorQuoteCreateInputSchema = z.object({
  /** 公司隔离（D15）：必须显式给出归属公司，服务端再校验调用者可见性。 */
  companyId: z.string().uuid(),
  processorId: z.string().min(1),
  quoteDate: QuoteDateSchema,
  processName: z.string().min(1).max(64),
  unitPrice: UnitPriceSchema,
  remark: z.string().max(256).nullable().optional(),
});

export type ProcessorCreateInput = z.infer<typeof ProcessorCreateInputSchema>;
export type ProcessorUpdateInput = z.infer<typeof ProcessorUpdateInputSchema>;
export type ProcessorQuoteCreateInput = z.infer<typeof ProcessorQuoteCreateInputSchema>;

/**
 * masterdata 的加工厂端点（共 7 条 = 加工厂 5 条 + 报价记录 2 条）。
 *
 * 权限：`processor.read` / `.create` / `.update` / `.delete`（scope = domain.action）。
 * 审计：写操作必记（D51）；普通读不记（D54 ②）。
 * AI：创建/修改允许（写操作默认要求 X-Reason，见 `reasonRequiredFor`）；
 *     **停用（delete）属危险动作，AI 默认禁止**（D52① / D54 危险动作清单）。
 * 并发：update / delete 强制 If-Match 强 ETag（详情会回 `version`，客户端拿得到）。
 * 报价记录（D64 ④）：**只提供 list / create**，不提供 update / delete——
 *   报价是一次性历史事实，允许改价会让比价与审计失真；录错只能新录一行。
 */
export const PROCESSOR_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'masterdata',
    operationId: 'processor.list.read',
    method: 'GET',
    path: '/api/v1/processors',
    domain: 'processor',
    action: 'read',
    summary: '加工厂列表（按名称/联系人检索；普通读不记审计，D49 不按编号全局搜）',
    audit: { kind: 'none' },
    request: { query: ProcessorListQuerySchema },
    response: { status: 200, schema: pageSchema(ProcessorSchema) },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'processor.create',
    method: 'POST',
    path: '/api/v1/processors',
    domain: 'processor',
    action: 'create',
    summary: '新增加工厂（编号自由文本可空；主表只存基础资料，D49/D64）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    request: { body: ProcessorCreateInputSchema },
    response: { status: 201, schema: ProcessorSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'processor.detail.read',
    method: 'GET',
    path: '/api/v1/processors/{id}',
    domain: 'processor',
    action: 'read',
    summary: '加工厂详情（D15 跨公司不可见）',
    audit: { kind: 'none' },
    response: { status: 200, schema: ProcessorSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'processor.update',
    method: 'PATCH',
    path: '/api/v1/processors/{id}',
    domain: 'processor',
    action: 'update',
    summary: '修改加工厂（强 ETag If-Match；不改报价历史）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: ProcessorUpdateInputSchema },
    response: { status: 200, schema: ProcessorSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'processor.delete',
    method: 'DELETE',
    path: '/api/v1/processors/{id}',
    domain: 'processor',
    action: 'delete',
    summary: '停用加工厂（软删除，不做物理删除；危险动作，AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    // 回实体而不是 204：客户端要拿到新 `version` 才能继续并发写（与商品/客户/供应商同款）。
    response: { status: 200, schema: ProcessorSchema },
  }),
  defineRoute({
    module: 'masterdata',
    // 不用 `processor.quote.list.read`：CLI 按 operationId 末两段生成命令名（`buildActionNames`），
    // domain 内已因 read 撞名整域改用末两段，那条会压成 `list-read`，和 `processor.list.read` 重复注册。
    operationId: 'processor.quote.read',
    method: 'GET',
    path: '/api/v1/processor-quotes',
    domain: 'processor',
    action: 'read',
    summary: '加工厂报价记录列表（按工序 + 日期区间比价；普通读不记审计，D64③）',
    audit: { kind: 'none' },
    request: { query: ProcessorQuoteListQuerySchema },
    response: { status: 200, schema: pageSchema(ProcessorQuoteSchema) },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'processor.quote.create',
    method: 'POST',
    path: '/api/v1/processor-quotes',
    domain: 'processor',
    action: 'create',
    summary: '新增加工厂报价记录（一次报价一行，只增不改，D64④）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    request: { body: ProcessorQuoteCreateInputSchema },
    response: { status: 201, schema: ProcessorQuoteSchema },
  }),
];
