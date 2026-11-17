import { z } from 'zod';
import { CompanySchema } from './companies.js';
import { ACTION_KEYS, DOMAIN_KEYS } from './domains.js';
import { DOCUMENT_TYPES, type DocumentType } from './numbering.js';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 设置中心契约（Issue #298 / D93）。
 *
 * 设计正文：`docs/design-settings-center.md`。
 * 本文件声明概览与 /employees/me 系列（我的资料 / 换手机号 / 我的会话）五个端点。
 * 它们全部只作用于「登录者本人」：路径写死 `/me`、不接受任何员工 id 入参，
 * 服务端从会话上下文取 principal（design-settings-center §5.1）——
 * 这是防越权的根，不是风格选择：只要允许一个 `employeeId` 参数，任何拿到自己
 * Cookie 的人都能改别人的名字、换别人的登录号。
 *
 * 权限口径（§5.3②）：
 *   - 概览要 `company.read`；没有权限必须 403，**不许返回 `companies: []`**
 *     把「没权限」伪装成「没有公司」；
 *   - 概览只回脱敏手机号，完整号码不出服务端。
 */

const DOCUMENT_TYPE_KEYS = Object.keys(DOCUMENT_TYPES) as [DocumentType, ...DocumentType[]];

/** 概览里的租户摘要（0024 已删除 tenant.plan / expires_at，订阅走公司级 billing）。 */
export const SettingsTenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['启用', '停用']),
});

/**
 * 本人公司范围与岗位（I3）：只读。
 * 同一岗位绑定多家公司时会出现多条（companyId 不同），前端直接展示即可。
 */
export const SettingsPositionSchema = z.object({
  id: z.string(),
  name: z.string(),
  companyId: z.string(),
  companyName: z.string(),
});

/** 概览的 `me` 段：手机号只回脱敏值，`companies` 与顶层 `companies` 同源。 */
export const SettingsMeSchema = z.object({
  name: z.string(),
  phoneMasked: z.string(),
  companies: z.array(CompanySchema),
  positions: z.array(SettingsPositionSchema),
});

/** 编号预览（E1 / I2）：规则 + 下一个号；当月流水用满时 `next` 为 null。 */
export const SettingsNumberingSchema = z.object({
  type: z.enum(DOCUMENT_TYPE_KEYS),
  rule: z.string(),
  next: z.string().nullable(),
});

/**
 * 我的权限（B5）：直接来自 principal 的生效 scope（已含岗位并集 / 个人覆盖 / token 收窄）。
 * 概览不重新查权限表，避免与认证链路算出两份不一致的结果。
 */
export const SettingsPermissionSchema = z.object({
  domain: z.enum(DOMAIN_KEYS as [string, ...string[]]),
  action: z.enum(ACTION_KEYS as [string, ...string[]]),
});

/** `GET /api/v1/settings/overview`：一次聚合返回设置中心首屏所需数据。 */
export const SettingsOverviewSchema = z.object({
  tenant: SettingsTenantSchema,
  companies: z.array(CompanySchema),
  numbering: z.array(SettingsNumberingSchema),
  me: SettingsMeSchema,
  permissions: z.array(SettingsPermissionSchema),
});
export type SettingsOverview = z.infer<typeof SettingsOverviewSchema>;

// ---------------------------------------------------------------------------
// 我的资料（A2 / B2）：`PATCH /api/v1/employees/me`
//
// 为什么不复用 `PATCH /api/v1/employees/{id}`：那条要 `employee.update`，
// 且入参里有 `phone` / `isOwner` / `companyIds`——把「改自己」也塞进去，
// 普通员工就得先拿到「能改全部员工」的权限点，等于为了改名字送出一座城堡。
// ---------------------------------------------------------------------------

/** 税号：迁移里的 `company_tax_no_check` 同口径（15–20 位大写字母数字），非法值 422。 */
export const TaxNoSchema = z
  .string()
  .regex(/^[0-9A-Z]{15,20}$/, '税号应为 15–20 位大写字母或数字');

/**
 * 公司四字段（B2）：全部可空——清空一个字段就是传 `null`，
 * 与「没传这个字段（保持原值）」在语义上必须能区分开，所以可选 + 可空。
 */
export const SettingsCompanyProfileSchema = z
  .object({
    address: z.string().trim().max(200).nullable().optional(),
    contactPhone: z.string().trim().max(32).nullable().optional(),
    taxNo: TaxNoSchema.nullable().optional(),
    logoUrl: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/**
 * 资料保存入参：`name`（我的名字）与 `company`（公司四字段）都可选，
 * 但不能两个都不给——空请求没有语义，直接 422 比「返回 200 但什么都没改」诚实。
 */
export const SettingsProfileUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    company: SettingsCompanyProfileSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.company !== undefined, {
    message: '至少要提供 name 或 company 其中一项',
  });

/** 资料保存响应：回本人摘要 + 本次触及的公司（没改公司时为 null）。 */
export const SettingsProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  phoneMasked: z.string(),
  version: z.number().int(),
  company: CompanySchema.nullable(),
});
export type SettingsProfile = z.infer<typeof SettingsProfileSchema>;

// ---------------------------------------------------------------------------
// 换手机号（A3）：新号收码 → 确认 → 改号并吊销全部会话。
//
// 为什么不是一步改完：手机号就是登录账号，一步改意味着「验证码发错了号也照样生效」。
// 拆成 request / confirm 两步，新号必须真的收到码，改号才落地。
// ---------------------------------------------------------------------------

/** 换号申请入参：只收新号，不收任何员工 id（本人从会话取）。 */
export const SettingsPhoneChangeRequestSchema = z
  .object({
    phone: z.string().regex(/^1[0-9]{10}$/, '手机号应为 11 位，1 开头'),
  })
  .strict();

/** 换号申请响应：只回脱敏新号 + 重发间隔，不回验证码（码只走短信）。 */
export const SettingsPhoneChangeRequestResultSchema = z.object({
  phoneMasked: z.string(),
  resendAfterSeconds: z.number().int(),
  expiresAt: z.string(),
});
export type SettingsPhoneChangeRequestResult = z.infer<
  typeof SettingsPhoneChangeRequestResultSchema
>;

/** 换号确认入参：6 位数字码。 */
export const SettingsPhoneChangeConfirmSchema = z
  .object({
    code: z.string().regex(/^[0-9]{6}$/, '验证码应为 6 位数字'),
  })
  .strict();

/** 换号确认响应：新号脱敏 + 被吊销的会话数（改号后所有旧 token 必须立刻失效）。 */
export const SettingsPhoneChangeResultSchema = z.object({
  phoneMasked: z.string(),
  sessionsRevoked: z.number().int(),
});
export type SettingsPhoneChangeResult = z.infer<typeof SettingsPhoneChangeResultSchema>;

// ---------------------------------------------------------------------------
// 我的会话（A6）：列表 + 踢下线。
//
// 只回「设备标识 + 时间」，不回 token（服务端本来也只有哈希）、不回 UA 原文、
// 不回完整 IP——这张表的 ip / user_agent 是排障用的原始痕迹，不是给人看的资料。
// ---------------------------------------------------------------------------

export const SettingsSessionSchema = z.object({
  id: z.string(),
  /** 由 UA 派生的可读标识（如「Chrome · Windows」），不是 UA 原文。 */
  deviceLabel: z.string(),
  issuedAt: z.string(),
  lastSeenAt: z.string().nullable(),
  expiresAt: z.string(),
  /** 非 null = 已吊销；列表里同时返回已吊销会话，便于「我刚踢了谁」有据可查。 */
  revokedAt: z.string().nullable(),
  /** 是否就是发起本次请求的这条会话。 */
  current: z.boolean(),
  /** 仍可用于访问（未吊销且未过期）。 */
  active: z.boolean(),
});
export type SettingsSession = z.infer<typeof SettingsSessionSchema>;

export const SettingsSessionListSchema = z.object({
  items: z.array(SettingsSessionSchema),
});
export type SettingsSessionList = z.infer<typeof SettingsSessionListSchema>;

export const SettingsSessionRevokeResultSchema = z.object({
  id: z.string(),
  revokedAt: z.string(),
});
export type SettingsSessionRevokeResult = z.infer<typeof SettingsSessionRevokeResultSchema>;

/** 设置中心端点（全部挂 platform 模块）。 */
export const SETTINGS_ROUTES: readonly RouteDef[] = [
  defineRoute({
    operationId: 'platform.settings.overview',
    method: 'GET',
    path: '/api/v1/settings/overview',
    domain: 'company',
    action: 'read',
    summary: '设置中心概览（无 company.read → 403；手机号脱敏；只返回可访问公司）',
    audit: { kind: 'none' },
    response: { status: 200, schema: SettingsOverviewSchema },
  }),
  defineRoute({
    operationId: 'platform.settings.update_profile',
    method: 'PATCH',
    path: '/api/v1/employees/me',
    domain: 'employee',
    action: 'update',
    summary: '保存我的资料（只改本人；name 免业务 scope，公司四字段需 company.update）',
    audit: { kind: 'write' },
    // 并发守卫走员工的 version（强 ETag），与 /employees/{id} 同一套 D60① 口径。
    requiresIfMatch: true,
    request: { body: SettingsProfileUpdateSchema },
    response: { status: 200, schema: SettingsProfileSchema },
  }),
  defineRoute({
    operationId: 'platform.settings.request_phone_change',
    method: 'POST',
    path: '/api/v1/employees/me/phone/request',
    domain: 'employee',
    action: 'update',
    summary: '申请换手机号（向新号发 6 位码；同号 60 秒一条、24 小时最多 10 条）',
    audit: { kind: 'write' },
    // 发码就是发短信、要花钱，频控只能挡住「同号刷」，挡不住 AI 凭证换着号批量发；
    // 这类有外部成本的动作不该由 AI 触发（D54 ⑥ 危险动作默认禁止）。
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: SettingsPhoneChangeRequestSchema },
    response: { status: 200, schema: SettingsPhoneChangeRequestResultSchema },
  }),
  defineRoute({
    operationId: 'platform.settings.confirm_phone_change',
    method: 'POST',
    path: '/api/v1/employees/me/phone/confirm',
    domain: 'employee',
    action: 'update',
    summary: '确认换手机号（码一次性；成功后改手机号并吊销本人全部会话）',
    audit: { kind: 'write' },
    // 改的是登录账号本身：确认完旧号就登不进来。AI 凭证能触发这个 = 能锁死一个员工账号。
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: SettingsPhoneChangeConfirmSchema },
    response: { status: 200, schema: SettingsPhoneChangeResultSchema },
  }),
  defineRoute({
    operationId: 'platform.settings.sessions',
    method: 'GET',
    path: '/api/v1/employees/me/sessions',
    domain: 'employee',
    action: 'read',
    summary: '我的登录会话（只回设备标识与时间，不回 token / UA 原文）',
    audit: { kind: 'none' },
    response: { status: 200, schema: SettingsSessionListSchema },
  }),
  defineRoute({
    operationId: 'platform.settings.revoke_session',
    method: 'DELETE',
    path: '/api/v1/employees/me/sessions/{id}',
    domain: 'employee',
    action: 'update',
    summary: '踢掉我的一条会话（只限本人；id 不属于本人 → 403）',
    audit: { kind: 'write' },
    // 踢会话 = 把一条登录态挤下线。AI 凭证凭什么替人干掉一个登录态（D54 ⑥）。
    ai: { policy: 'forbid', reasonRequired: true },
    response: { status: 200, schema: SettingsSessionRevokeResultSchema },
  }),
];
