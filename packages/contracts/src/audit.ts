import { z } from 'zod';

/**
 * 操作日志契约（契约第三批 §1 + D54 缺口 3 裁定）。
 * 只追加、不可改删；业务失败也记；`tenantId` 业务操作必填，纯平台级（新增租户）可空。
 */
export const ACTOR_TYPES = ['platform', 'employee', 'ai', 'system'] as const;
export const AUDIT_RESULTS = ['success', 'fail'] as const;
export const AUDIT_SOURCES = ['web', 'cli', 'api', 'mcp', 'job'] as const;

/** `actorType=system` 时 actorId 固定此值（允许非 uuid，D54）。 */
export const SYSTEM_ACTOR_ID = 'system';

/** 平台开发者账号用 `platform:<账号 id>` 前缀，避免与员工 uuid 撞命名空间（D54）。 */
export const PLATFORM_ACTOR_PREFIX = 'platform:';

/** 敏感读（D54 ②）：导出 / 看价 / 看日志 / 看 Token 列表 / 含金额的详情。 */
export const SENSITIVE_READS = ['export', 'view_price', 'audit.read', 'token.list', 'amount.detail'] as const;

/** 危险动作（D54 ⑥）：删除 / 冲正 / 成本更正 / 结算确认 / 权限变更，默认禁止 AI 直接执行。 */
export const DANGEROUS_OPERATION_SUFFIXES = [
  '.delete',
  '.revoke',
  '.reverse',
  '.cost-correct',
  '.confirm',
  '.permission-update',
] as const;

export const AuditLogSchema = z.object({
  id: z.string(),
  time: z.string().datetime(),
  tenantId: z.string().nullable(),
  companyId: z.string().nullable(),
  actorType: z.enum(ACTOR_TYPES),
  actorId: z.string(),
  credentialId: z.string().nullable(),
  source: z.enum(AUDIT_SOURCES),
  action: z.string(),
  objectType: z.string(),
  objectId: z.string().nullable(),
  changeSummary: z.record(z.string(), z.unknown()).nullable(),
  result: z.enum(AUDIT_RESULTS),
  errorCode: z.string().nullable(),
  requestId: z.string(),
  ip: z.string().nullable(),
  ua: z.string().nullable(),
  reason: z.string().nullable(),
  businessTxId: z.string().nullable(),
  dryRun: z.boolean(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

z.globalRegistry.add(AuditLogSchema, { id: 'AuditLog' });
