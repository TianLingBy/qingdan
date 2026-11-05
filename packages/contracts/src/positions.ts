import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { PageQuerySchema, pageSchema } from './pagination.js';
import { ACTION_KEYS, DOMAIN_KEYS } from './domains.js';

/**
 * 岗位（权限模板）契约（M1 契约，2026-11-05）。
 *
 * 岗位归 `permission` 功能域（D44 的「权限设置」= 岗位 + 个人覆盖），
 * **不新增 `position` 功能域**；operationId 仍按资源命名 `platform.position.*`，
 * 与员工那批 `platform.employee.*` 一致。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **权限模板 = 功能域 × 动作**（D4）：词表直接取 `domains.ts`（与 authz 同源），
 *   不自造 domain / action；
 * - **「看价」不进动作勾选表**（D4）：`view_price` 是数据可见性开关、不属于「操作」，
 *   `actions` 里传入即校验失败；看价需按 D4 单独配置（本契约暂不建模独立字段）；
 * - **`presetKey` 只接受服务端预设值或 `null`**（D60②）：老板/经理/财务等角色判定
 *   靠 `position.preset_key`，不靠岗位名文本匹配；自定义岗位为 `null`；
 * - 写操作必记审计（D51）；权限模板变更属危险动作，**AI 默认禁止**（D54 ⑥）；
 * - **停用 = 软删除**，且**被员工占用的岗位不允许删**（`employee_company_position`
 *   仍引用该岗位时服务端必须拒绝，不能留下悬空绑定）。
 */

/**
 * D60② 服务端预设岗位标识。词表以该决策行为唯一真源，客户端不得自造。
 * 自定义岗位 `presetKey = null`。
 */
export const POSITION_PRESET_KEYS = [
  'owner',
  'manager',
  'finance',
  'sales',
  'purchase',
  'quality',
  'picking',
  'warehouse',
] as const;

export const PositionPresetKeySchema = z.enum(POSITION_PRESET_KEYS);
export type PositionPresetKey = z.infer<typeof PositionPresetKeySchema>;

/**
 * 动作勾选表可用动作 = 8 动作词表去掉 `view_price`（D4 第七轮确认）。
 * 只做词表过滤，不新增动作。
 */
const TEMPLATE_ACTION_KEYS = ACTION_KEYS.filter((action) => action !== 'view_price');

/** 权限模板的一行：某功能域下勾选的动作集合。 */
export const PositionActionEntrySchema = z
  .object({
    domain: z.enum(DOMAIN_KEYS as [string, ...string[]]),
    actions: z.array(z.enum(TEMPLATE_ACTION_KEYS as [string, ...string[]])).min(1),
  })
  .strict();

/**
 * 权限模板：每域至多一行（重复 domain 无意义，且会让生效权限计算出现歧义）。
 * `view_price` 不在枚举内，客户端误传即失败。
 */
export const PositionActionsSchema = z
  .array(PositionActionEntrySchema)
  .min(1)
  .refine((entries) => new Set(entries.map((entry) => entry.domain)).size === entries.length, {
    message: '同一功能域只能出现一次',
  });

/** 岗位状态：停用 = 软删除，停用后不再参与员工授权。 */
export const PositionStatusSchema = z.enum(['启用', '停用']);

export const PositionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  /** D60②：预设岗位标识；自定义岗位为 null。 */
  presetKey: PositionPresetKeySchema.nullable(),
  /** 权限模板（D4）：功能域 × 动作；`view_price` 不在此表内。 */
  actions: PositionActionsSchema,
  status: PositionStatusSchema,
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Position = z.infer<typeof PositionSchema>;

/** 岗位列表：分页 + 可按预设标识过滤（自定义岗位不传）。 */
export const PositionListQuerySchema = PageQuerySchema.extend({
  presetKey: PositionPresetKeySchema.optional(),
});

/**
 * 创建岗位入参。
 * `presetKey` 只能取服务端预设值或 null；`.strict()` 拒绝 `id` / `tenantId` 等越权字段。
 */
export const PositionCreateInputSchema = z
  .object({
    name: z.string().min(1).max(64),
    actions: PositionActionsSchema,
    presetKey: PositionPresetKeySchema.nullable().optional(),
  })
  .strict();

/**
 * 更新岗位入参：全字段可选、至少改一个。
 * `presetKey` 不可改——角色标识是身份锚点（D60②），改它等于换岗位。
 */
export const PositionUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    actions: PositionActionsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });

export type PositionCreateInput = z.infer<typeof PositionCreateInputSchema>;
export type PositionUpdateInput = z.infer<typeof PositionUpdateInputSchema>;

/**
 * 岗位端点（4 条）。domain = `permission`（D44），scope = `permission.<动作>`。
 *
 * 审计：写操作必记（D51/D54②）。
 * AI：创建/编辑/停用都会改变生效权限 → **默认禁止**（D54⑥）；停用另需 reason。
 * 并发：update / delete 强制 If-Match 强 ETag（实体回 `version`）。
 */
export const POSITION_ROUTES: readonly RouteDef[] = [
  defineRoute({
    operationId: 'platform.position.list',
    method: 'GET',
    path: '/api/v1/positions',
    domain: 'permission',
    action: 'read',
    summary: '岗位列表（分页；可按 presetKey 过滤，普通读不记审计）',
    audit: { kind: 'none' },
    request: { query: PositionListQuerySchema },
    response: { status: 200, schema: pageSchema(PositionSchema) },
  }),
  defineRoute({
    operationId: 'platform.position.create',
    method: 'POST',
    path: '/api/v1/positions',
    domain: 'permission',
    action: 'create',
    summary: '新建岗位（权限模板；presetKey 仅限服务端预设值或 null；AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: PositionCreateInputSchema },
    response: { status: 201, schema: PositionSchema },
  }),
  defineRoute({
    operationId: 'platform.position.update',
    method: 'PATCH',
    path: '/api/v1/positions/{id}',
    domain: 'permission',
    action: 'update',
    summary: '修改岗位权限模板（强 ETag If-Match；不可改 presetKey；AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    request: { body: PositionUpdateInputSchema },
    response: { status: 200, schema: PositionSchema },
  }),
  defineRoute({
    operationId: 'platform.position.delete',
    method: 'DELETE',
    path: '/api/v1/positions/{id}',
    domain: 'permission',
    action: 'delete',
    summary: '停用岗位（软删除；被员工占用的岗位不允许删；危险动作，AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    // 软删除：只把 status 置「停用」，不物理删（历史审计与绑定仍需可追溯）。
    // 被员工占用的岗位不允许删：实现须先检查 `employee_company_position` 引用并拒绝；
    // 拒绝错误码待 Lead 口径确认（建议 409），确认前不要在实现里自造。
    // 回实体而不是 204：客户端要拿到新 `version` 才能继续并发写（与员工/商品同款）。
    response: { status: 200, schema: PositionSchema },
  }),
];
