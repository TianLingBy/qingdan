import { z } from 'zod';
import { CompanySchema } from './companies.js';
import { ACTION_KEYS, DOMAIN_KEYS } from './domains.js';
import { DOCUMENT_TYPES, type DocumentType } from './numbering.js';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 设置中心契约（Issue #298 / D93）。
 *
 * 设计正文：`docs/design-settings-center.md`。
 * 本块只声明概览这一个端点；/employees/me 系列（资料 / 换号 / 会话）在后续块补，
 * 避免一次性改动面过大。
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

/** 设置中心端点（本块只登记概览 1 条，全部挂 platform 模块）。 */
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
];
