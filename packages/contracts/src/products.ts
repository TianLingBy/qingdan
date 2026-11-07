import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 商品资料契约（masterdata 模块首切，Issue #15 / 契约第一批 §2）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **编号 `productNo` 是自由文本、可空、不唯一、不作全局检索主键**（D49）——
 *   定位商品用 uuid/名称/别名，编号只给人看和对账；
 * - **商品不挂成本字段**：成本在批次上（D5），商品表加成本列即违纪；
 * - **金额一律 decimal 字符串**（D54），不用 number，避免浮点误差；
 * - **默认售价受「看价」权限管**（D4.1 / D27）：调用者无 `product.view_price` 时
 *   服务端把 `defaultSalePrice` 返回为 `null`，而不是省略字段（前端不必猜键是否存在）。
 */

/** 商品状态：停用后不出现在单据选对象弹窗（模块验收标准）。 */
export const ProductStatusSchema = z.enum(['启用', '停用']);

export const ProductSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：商品属于某一个公司，跨公司不可见。 */
  companyId: z.string(),
  /** D49：自由文本编号，可空；后台不改写、不做唯一校验。 */
  productNo: z.string().nullable(),
  name: z.string(),
  /** 别名用于检索（D49 允许按名称/别名查，但不把编号当检索键）。 */
  aliases: z.array(z.string()),
  specification: z.string().nullable(),
  unit: z.string(),
  status: ProductStatusSchema,
  /** decimal 字符串（D54）；无看价权限时为 null（D27）。 */
  defaultSalePrice: z.string().nullable(),
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

/**
 * 商品列表查询：`keyword` 只匹配名称与别名（D49），不支持按编号全局搜。
 * 分页沿用通用游标（`PageQuerySchema`）。
 */
export const ProductListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  status: ProductStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/** 金额输入：decimal 字符串，最多 6 位小数（D54 `numeric(18,6)`）。 */
const DecimalInput = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '金额必须是 decimal 字符串，最多 6 位小数');

/** 可选字段（`name` / `unit` 在创建时必填，故单独声明，避免展开覆盖）。 */
const productOptionalFields = {
  productNo: z.string().max(64).nullable().optional(),
  aliases: z.array(z.string().min(1).max(64)).max(20).optional(),
  specification: z.string().max(128).nullable().optional(),
  status: ProductStatusSchema.optional(),
  defaultSalePrice: DecimalInput.nullable().optional(),
} as const;

export const ProductCreateInputSchema = z.object({
  /** 公司隔离（D15）：创建时必须显式给出归属公司，服务端再校验调用者可见性。 */
  companyId: z.string().uuid(),
  name: z.string().min(1).max(64),
  unit: z.string().min(1).max(16),
  ...productOptionalFields,
});

/** 更新：全字段可选、至少要改一个；`companyId` 不可改（换公司 = 新商品）。 */
export const ProductUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    unit: z.string().min(1).max(16).optional(),
    ...productOptionalFields,
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });

export type ProductCreateInput = z.infer<typeof ProductCreateInputSchema>;
export type ProductUpdateInput = z.infer<typeof ProductUpdateInputSchema>;

/**
 * masterdata 的商品端点（5 条）。
 *
 * 权限：`product.read` / `.create` / `.update` / `.delete`（scope = domain.action）。
 * 审计：写操作必记（D51）；普通读不记（D54 ②）。
 * AI：创建/修改允许（写操作默认要求 X-Reason，见 `reasonRequiredFor`）；
 *     **停用（delete）属危险动作，AI 默认禁止**（D52① / D54 危险动作清单）。
 * 并发：update / delete 强制 If-Match 强 ETag（商品详情会回 `version`，客户端拿得到）。
 */
export const PRODUCT_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'masterdata',
    operationId: 'product.list.read',
    method: 'GET',
    path: '/api/v1/products',
    domain: 'product',
    action: 'read',
    summary: '商品列表（按名称/别名检索；普通读不记审计，D49 不按编号全局搜）',
    audit: { kind: 'none' },
    request: { query: ProductListQuerySchema },
    response: { status: 200, schema: pageSchema(ProductSchema) },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'product.create',
    method: 'POST',
    path: '/api/v1/products',
    domain: 'product',
    action: 'create',
    summary: '新增商品（编号自由文本可空；默认售价受看价权限管，D4.1/D49）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    request: { body: ProductCreateInputSchema },
    response: { status: 201, schema: ProductSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'product.detail.read',
    method: 'GET',
    path: '/api/v1/products/{id}',
    domain: 'product',
    action: 'read',
    summary: '商品详情（无看价权限时默认售价返回 null，D27）',
    audit: { kind: 'none' },
    response: { status: 200, schema: ProductSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'product.update',
    method: 'PATCH',
    path: '/api/v1/products/{id}',
    domain: 'product',
    action: 'update',
    summary: '修改商品（强 ETag If-Match；改默认售价需看价权限）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: ProductUpdateInputSchema },
    response: { status: 200, schema: ProductSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'product.delete',
    method: 'DELETE',
    path: '/api/v1/products/{id}',
    domain: 'product',
    action: 'delete',
    summary: '停用商品（软删除，不做物理删除；危险动作，AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    // 回实体而不是 204：客户端要拿到新 `version` 才能继续并发写（与 token.revoke 的 204 不同，
    // 因为商品停用后仍会被列表/详情读取，回读实体更贴近实际用法）。
    response: { status: 200, schema: ProductSchema },
  }),
];
