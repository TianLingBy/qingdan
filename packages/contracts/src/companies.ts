import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 公司管理契约（M1 契约，2026-11-05）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **公司码 4 位、租户内顺序递增、由服务端自动发放**（D16）：`0001`~`9999`；
 *   入参**不接收** `code`（`.strict()` 让客户端误传直接失败，而不是静默丢弃），
 *   更新也**不可改公司码**（公司码是数据隔离与跨司溯源的刚性字段，见 D15/D22）；
 * - 写操作必记审计（D51）；普通读不记（D54②）；
 * - 新建公司属高影响动作，AI 默认禁止；改名按普通写操作放行（AI allow）。
 */

/** 公司码（D16）：定长 4 位数字，`0001`~`9999`；只出现在响应里。 */
export const CompanyCodeSchema = z
  .string()
  .regex(/^[0-9]{4}$/, '公司码必须是 4 位数字');

export const CompanySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** D16：服务端按租户内顺序发放的 4 位定长公司码（如 `0001`）。 */
  code: CompanyCodeSchema,
  name: z.string(),
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Company = z.infer<typeof CompanySchema>;

/** 公司列表：通用游标分页（D54）。 */
export const CompanyListQuerySchema = PageQuerySchema;

/**
 * 创建公司入参：只收名称。
 * 公司码由服务端按 D16 自动发放，`.strict()` 拒绝客户端传 `code` / `id`。
 */
export const CompanyCreateInputSchema = z
  .object({
    name: z.string().min(1).max(64),
  })
  .strict();

/**
 * 更新公司入参：目前只允许改名。
 * 公司码不可改（D16）；`.strict()` 让 `code` 传入即校验失败。
 */
export const CompanyUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(64),
  })
  .strict();

export type CompanyCreateInput = z.infer<typeof CompanyCreateInputSchema>;
export type CompanyUpdateInput = z.infer<typeof CompanyUpdateInputSchema>;

/**
 * 公司端点（3 条）。domain = `company`（D44「公司管理」），scope = `company.<动作>`。
 *
 * 审计：写操作必记（D51）；列表普通读不记（D54②）。
 * AI：新建默认禁止；改名允许。
 * 并发：update 强制 If-Match 强 ETag（实体回 `version`）。
 */
export const COMPANY_ROUTES: readonly RouteDef[] = [
  defineRoute({
    operationId: 'platform.company.list',
    method: 'GET',
    path: '/api/v1/companies',
    domain: 'company',
    action: 'read',
    summary: '公司列表（分页；普通读不记审计）',
    audit: { kind: 'none' },
    request: { query: CompanyListQuerySchema },
    response: { status: 200, schema: pageSchema(CompanySchema) },
  }),
  defineRoute({
    operationId: 'platform.company.create',
    method: 'POST',
    path: '/api/v1/companies',
    domain: 'company',
    action: 'create',
    summary: '新建公司（公司码由服务端按 D16 自动发放；AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: CompanyCreateInputSchema },
    response: { status: 201, schema: CompanySchema },
  }),
  defineRoute({
    operationId: 'platform.company.update',
    method: 'PATCH',
    path: '/api/v1/companies/{id}',
    domain: 'company',
    action: 'update',
    summary: '修改公司名称（强 ETag If-Match；不可改公司码）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: CompanyUpdateInputSchema },
    response: { status: 200, schema: CompanySchema },
  }),
];
