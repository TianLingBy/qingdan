import { z } from 'zod';
import { AuditLogSchema } from './audit.js';
import { ScopeMatrixSchema } from './authz.js';
import { ApiErrorBodySchema } from './errors.js';

/**
 * 契约实体登记表（D57 ①）：每个实体必须在此登记并带 globalRegistry id，
 * OpenAPI 的 components.schemas 必须与这里一一对应（CI 断言数量一致）。
 */
export const ApiTokenSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  employeeId: z.string(),
  name: z.string(),
  scope: ScopeMatrixSchema,
  expiresAt: z.string().datetime().nullable(),
  ipAllowlist: z.array(z.string()),
  lastUsedAt: z.string().datetime().nullable(),
  status: z.enum(['active', 'revoked', 'expired']),
  /** 乐观锁版本（撤销时放进 If-Match；列表接口必须回读，否则第二次写只能猜）。 */
  version: z.number().int(),
  createdBy: z.string(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;
z.globalRegistry.add(ApiTokenSchema, { id: 'ApiToken' });

/** 创建响应：明文 secret 只在创建时返回一次，服务端只存 SHA-256（契约第三批 §2）。 */
export const ApiTokenCreatedSchema = ApiTokenSchema.extend({ secret: z.string() });
export type ApiTokenCreated = z.infer<typeof ApiTokenCreatedSchema>;
z.globalRegistry.add(ApiTokenCreatedSchema, { id: 'ApiTokenCreated' });

z.globalRegistry.add(ApiErrorBodySchema, { id: 'ApiErrorBody' });

export const ENTITIES = [
  { name: 'AuditLog', schema: AuditLogSchema },
  { name: 'ApiToken', schema: ApiTokenSchema },
  { name: 'ApiTokenCreated', schema: ApiTokenCreatedSchema },
  { name: 'ApiErrorBody', schema: ApiErrorBodySchema },
] as const;
