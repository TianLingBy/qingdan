import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 客户资料契约（masterdata 第二切，契约第一批 §2）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **编号 `customerNo` 是自由文本、可空、不唯一、不作全局检索主键**（D49）——
 *   定位客户走「进入某公司 → 按名称/联系人查看」，编号只给人看和对账；
 * - **公司隔离**（D15）：客户属于某一个公司，跨公司不可见；
 * - **客户没有金额/看价逻辑**：不得新增任何金额字段（售价、折扣、余额等都不在这里）；
 * - 写操作必记审计（D51）；停用属危险动作，AI 默认禁止（D52① / D54 危险动作清单）。
 */

/** 客户状态：停用后不出现在单据选客户弹窗（与商品同款）。 */
export const CustomerStatusSchema = z.enum(['启用', '停用']);

export const CustomerSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：客户属于某一个公司，跨公司不可见。 */
  companyId: z.string(),
  /** D49：自由文本编号，可空；后台不改写、不做唯一校验、不作检索主键。 */
  customerNo: z.string().nullable(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  /**
   * 账期（整数天，`>= 0`，可空）。
   * 契约第一批 §2 只列「账期」未给单位/边界；按任务口径先实现「整数天、>=0、可空」，
   * 上限与「0 是否等于现结」待负责人拍板，拍板前不扩展其它字段。
   */
  creditTermDays: z.number().int().min(0).nullable(),
  status: CustomerStatusSchema,
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Customer = z.infer<typeof CustomerSchema>;

/**
 * 客户列表查询：`keyword` 只匹配名称/联系人（D49），不支持按编号全局搜。
 * 分页沿用通用游标（`PageQuerySchema`）。
 */
export const CustomerListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  status: CustomerStatusSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
});

/** 可选字段（`name` 在创建时必填，故单独声明，避免展开覆盖）。 */
const customerOptionalFields = {
  customerNo: z.string().max(64).nullable().optional(),
  contactName: z.string().max(64).nullable().optional(),
  contactPhone: z.string().max(32).nullable().optional(),
  creditTermDays: z.number().int().min(0).nullable().optional(),
  status: CustomerStatusSchema.optional(),
} as const;

export const CustomerCreateInputSchema = z.object({
  /** 公司隔离（D15）：创建时必须显式给出归属公司，服务端再校验调用者可见性。 */
  companyId: z.string().uuid(),
  name: z.string().min(1).max(64),
  ...customerOptionalFields,
});

/** 更新：全字段可选、至少要改一个；`companyId` 不可改（换公司 = 新客户）。 */
export const CustomerUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    ...customerOptionalFields,
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });

export type CustomerCreateInput = z.infer<typeof CustomerCreateInputSchema>;
export type CustomerUpdateInput = z.infer<typeof CustomerUpdateInputSchema>;

/**
 * masterdata 的客户端点（5 条）。
 *
 * 权限：`customer.read` / `.create` / `.update` / `.delete`（scope = domain.action）。
 * 审计：写操作必记（D51）；普通读不记（D54 ②）。
 * AI：创建/修改允许（写操作默认要求 X-Reason，见 `reasonRequiredFor`）；
 *     **停用（delete）属危险动作，AI 默认禁止**（D52① / D54 危险动作清单）。
 * 并发：update / delete 强制 If-Match 强 ETag（客户详情会回 `version`，客户端拿得到）。
 */
export const CUSTOMER_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'masterdata',
    operationId: 'customer.list.read',
    method: 'GET',
    path: '/api/v1/customers',
    domain: 'customer',
    action: 'read',
    summary: '客户列表（按名称/联系人检索；普通读不记审计，D49 不按编号全局搜）',
    audit: { kind: 'none' },
    request: { query: CustomerListQuerySchema },
    response: { status: 200, schema: pageSchema(CustomerSchema) },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'customer.create',
    method: 'POST',
    path: '/api/v1/customers',
    domain: 'customer',
    action: 'create',
    summary: '新增客户（编号自由文本可空；客户无金额字段，D49）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    request: { body: CustomerCreateInputSchema },
    response: { status: 201, schema: CustomerSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'customer.detail.read',
    method: 'GET',
    path: '/api/v1/customers/{id}',
    domain: 'customer',
    action: 'read',
    summary: '客户详情（D15 跨公司不可见）',
    audit: { kind: 'none' },
    response: { status: 200, schema: CustomerSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'customer.update',
    method: 'PATCH',
    path: '/api/v1/customers/{id}',
    domain: 'customer',
    action: 'update',
    summary: '修改客户（强 ETag If-Match）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: CustomerUpdateInputSchema },
    response: { status: 200, schema: CustomerSchema },
  }),
  defineRoute({
    module: 'masterdata',
    operationId: 'customer.delete',
    method: 'DELETE',
    path: '/api/v1/customers/{id}',
    domain: 'customer',
    action: 'delete',
    summary: '停用客户（软删除，不做物理删除；危险动作，AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    // 回实体而不是 204：客户端要拿到新 `version` 才能继续并发写（与商品同款）。
    response: { status: 200, schema: CustomerSchema },
  }),
];
