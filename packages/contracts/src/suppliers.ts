import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 供应商资料契约（masterdata 第三切，契约第一批 §2）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **编号 `supplierNo` 是自由文本、可空、不唯一、不作全局检索主键**（D49）——
 *   定位供应商走「进入某公司 → 按名称/联系人查看」，编号只给人看和对账；
 * - **公司隔离**（D15）：供应商属于某一个公司，跨公司不可见；
 * - **供应商没有金额字段**：货款/返利在单据与结算上，不挂在供应商档案；
 * - 写操作必记审计（D51）；停用属危险动作，AI 默认禁止（D52① / D54 危险动作清单）。
 */

/** 供应商状态：停用后不出现在单据选供应商弹窗（与商品/客户同款）。 */
export const SupplierStatusSchema = z.enum(['启用', '停用']);

/**
 * 供货物料：自由文本清单（最多 20 项、每项 1-64 字）。
 * 契约第一批 §2 只写「供货物料」未给结构；按任务口径先实现「自由文本清单」，
 * 语义是物料名称还是关联物料 id 待负责人拍板，拍板前不改关联表。
 */
export const SuppliedMaterialsSchema = z.array(z.string().min(1).max(64)).max(20);

export const SupplierSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：供应商属于某一个公司，跨公司不可见。 */
  companyId: z.string(),
  /** D49：自由文本编号，可空；后台不改写、不做唯一校验、不作检索主键。 */
  supplierNo: z.string().nullable(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  /** 供货物料自由文本清单，默认空数组（口径见 `SuppliedMaterialsSchema`）。 */
  suppliedMaterials: SuppliedMaterialsSchema,
  status: SupplierStatusSchema,
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Supplier = z.infer<typeof SupplierSchema>;

/**
 * 供应商列表查询：`keyword` 只匹配名称/联系人（D49），不支持按编号全局搜。
 * 分页沿用通用游标（`PageQuerySchema`）。
 */
export const SupplierListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  status: SupplierStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/** 可选字段（`name` 在创建时必填，故单独声明，避免展开覆盖）。 */
const supplierOptionalFields = {
  supplierNo: z.string().max(64).nullable().optional(),
  contactName: z.string().max(64).nullable().optional(),
  contactPhone: z.string().max(32).nullable().optional(),
  status: SupplierStatusSchema.optional(),
} as const;

export const SupplierCreateInputSchema = z.object({
  /** 公司隔离（D15）：创建时必须显式给出归属公司，服务端再校验调用者可见性。 */
  companyId: z.string().uuid(),
  name: z.string().min(1).max(64),
  /** 省略时落空数组（不把「未填」和「清空」混在一起）。 */
  suppliedMaterials: SuppliedMaterialsSchema.default([]),
  ...supplierOptionalFields,
});

/** 更新：全字段可选、至少要改一个；`companyId` 不可改（换公司 = 新供应商）。 */
export const SupplierUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    suppliedMaterials: SuppliedMaterialsSchema.optional(),
    ...supplierOptionalFields,
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });

export type SupplierCreateInput = z.infer<typeof SupplierCreateInputSchema>;
export type SupplierUpdateInput = z.infer<typeof SupplierUpdateInputSchema>;

/**
 * masterdata 的供应商端点（5 条）。
 *
 * 权限：`supplier.read` / `.create` / `.update` / `.delete`（scope = domain.action）。
 * 审计：写操作必记（D51）；普通读不记（D54 ②）。
 * AI：创建/修改允许（写操作默认要求 X-Reason，见 `reasonRequiredFor`）；
 *     **停用（delete）属危险动作，AI 默认禁止**（D52① / D54 危险动作清单）。
 * 并发：update / delete 强制 If-Match 强 ETag（供应商详情会回 `version`，客户端拿得到）。
 */
export const SUPPLIER_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'masterdata',
    operationId: 'supplier.list.read',
    method: 'GET',
    path: '/api/v1/suppliers',
    domain: 'supplier',
    action: 'read',
    summary: '供应商列表（按名称/联系人检索；普通读不记审计，D49 不按编号全局搜）',
    audit: { kind: 'none' },
    request: { query: SupplierListQuerySchema },
    response: { status: 200, schema: pageSchema(SupplierSchema) },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'supplier.create',
    method: 'POST',
    path: '/api/v1/suppliers',
    domain: 'supplier',
    action: 'create',
    summary: '新增供应商（编号自由文本可空；供应商无金额字段，D49）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    request: { body: SupplierCreateInputSchema },
    response: { status: 201, schema: SupplierSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'supplier.detail.read',
    method: 'GET',
    path: '/api/v1/suppliers/{id}',
    domain: 'supplier',
    action: 'read',
    summary: '供应商详情（D15 跨公司不可见）',
    audit: { kind: 'none' },
    response: { status: 200, schema: SupplierSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'supplier.update',
    method: 'PATCH',
    path: '/api/v1/suppliers/{id}',
    domain: 'supplier',
    action: 'update',
    summary: '修改供应商（强 ETag If-Match）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: SupplierUpdateInputSchema },
    response: { status: 200, schema: SupplierSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'supplier.delete',
    method: 'DELETE',
    path: '/api/v1/suppliers/{id}',
    domain: 'supplier',
    action: 'delete',
    summary: '停用供应商（软删除，不做物理删除；危险动作，AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    // 回实体而不是 204：客户端要拿到新 `version` 才能继续并发写（与商品/客户同款）。
    response: { status: 200, schema: SupplierSchema },
  }),
];
