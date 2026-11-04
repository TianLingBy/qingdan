import { z } from 'zod';
import { DOMAIN_KEYS, ACTION_KEYS } from './domains.js';
import { defineRoute, type RouteDef } from './registry.js';
import { ApiTokenCreatedSchema, ApiTokenSchema, EmployeeSummarySchema } from './entities.js';
import { AuditLogSchema } from './audit.js';
import { ScopeMatrixSchema } from './authz.js';
import { PageQuerySchema, pageSchema } from './pagination.js';

/**
 * 平台端点注册表（M0 骨架范围）。
 *
 * 一期规则（D54 缺口 10）：全部端点先在注册表登记签名，handler 允许先返 501。
 * 业务模块的端点在各自模块开工时登记；本文件只放 `platform` 内核已冻结的那批。
 */

const LoginInput = z.object({
  phone: z.string().min(6).max(32),
  code: z.string().min(1).max(16),
});
const LoginOutput = z.object({
  employeeId: z.string(),
  tenantId: z.string(),
  displayName: z.string(),
});
const MeOutput = z.object({
  employeeId: z.string(),
  tenantId: z.string(),
  displayName: z.string(),
  companyIds: z.array(z.string()),
  scope: ScopeMatrixSchema,
});

const CreateApiTokenInput = z.object({
  name: z.string().min(1).max(64),
  employeeId: z.string(),
  scope: ScopeMatrixSchema,
  expiresAt: z.string().datetime().nullable().optional(),
  ipAllowlist: z.array(z.string()).optional(),
});

const PermissionOverrideInput = z.object({
  overrides: z.array(
    z.object({
      domain: z.enum(DOMAIN_KEYS as [string, ...string[]]),
      action: z.enum(ACTION_KEYS as [string, ...string[]]),
      granted: z.boolean(),
    }),
  ),
});

const IdParam = z.object({ id: z.string() });

/**
 * 员工列表查询（D15 / D50）：在通用游标分页上追加数据范围过滤。
 * `keyword` 匹配姓名 / 工号 / 手机号后 4 位，始终在调用者可见公司范围内生效。
 */
export const EmployeeListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  status: z.enum(['在职', '停用']).optional(),
  keyword: z.string().min(1).max(64).optional(),
});

export const ROUTES: readonly RouteDef[] = [
  defineRoute({
    operationId: 'platform.health.read',
    method: 'GET',
    path: '/api/v1/health',
    domain: 'api_integration',
    action: 'read',
    summary: '健康检查（不认证、不记审计）',
    audit: { kind: 'none' },
    publicAccess: true,
    response: { status: 200, schema: z.object({ status: z.literal('ok'), version: z.string() }) },
  }),
  defineRoute({
    operationId: 'platform.openapi.read',
    method: 'GET',
    path: '/api/v1/openapi.json',
    domain: 'api_integration',
    action: 'read',
    summary: 'OpenAPI 3.1 文档（接口真源，公开只读）',
    audit: { kind: 'none' },
    publicAccess: true,
  }),
  defineRoute({
    operationId: 'platform.auth.login',
    method: 'POST',
    path: '/api/v1/auth/login',
    domain: 'employee',
    action: 'read',
    summary: '手机号 + 验证码登录（一期不发码，账号由后台/初始化脚本创建）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: LoginInput },
    response: { status: 200, schema: LoginOutput },
  }),
  defineRoute({
    operationId: 'platform.auth.logout',
    method: 'POST',
    path: '/api/v1/auth/logout',
    domain: 'employee',
    action: 'read',
    summary: '登出（只失效当前会话）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
  }),
  defineRoute({
    operationId: 'platform.auth.me',
    method: 'GET',
    path: '/api/v1/auth/me',
    domain: 'employee',
    action: 'read',
    summary: '当前登录主体与生效权限',
    audit: { kind: 'none' },
    response: { status: 200, schema: MeOutput },
  }),
  defineRoute({
    operationId: 'platform.employee.read',
    method: 'GET',
    path: '/api/v1/employees',
    domain: 'employee',
    action: 'read',
    summary: '员工列表（普通读不记审计；老板见全租户，非老板仅绑定公司集合）',
    audit: { kind: 'none' },
    request: { query: EmployeeListQuerySchema },
    response: { status: 200, schema: pageSchema(EmployeeSummarySchema) },
  }),
  defineRoute({
    operationId: 'platform.audit.read',
    method: 'GET',
    path: '/api/v1/audit-logs',
    domain: 'audit',
    action: 'read',
    summary: '操作日志查询（敏感读，必记审计；保留 180 天在线）',
    audit: { kind: 'sensitive-read' },
    request: { query: PageQuerySchema },
    response: { status: 200, schema: pageSchema(AuditLogSchema) },
  }),
  defineRoute({
    operationId: 'platform.token.create',
    method: 'POST',
    path: '/api/v1/api-tokens',
    domain: 'api_integration',
    action: 'create',
    summary: '创建 API Token（scope ⊆ 创建人授权，超出拒绝）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: CreateApiTokenInput },
    response: { status: 201, schema: ApiTokenCreatedSchema },
  }),
  defineRoute({
    operationId: 'platform.token.read',
    method: 'GET',
    path: '/api/v1/api-tokens',
    domain: 'api_integration',
    action: 'read',
    summary: 'Token 列表（敏感读，必记审计）',
    audit: { kind: 'sensitive-read' },
    request: { query: PageQuerySchema },
    response: { status: 200, schema: pageSchema(ApiTokenSchema) },
  }),
  defineRoute({
    operationId: 'platform.token.revoke',
    method: 'DELETE',
    path: '/api/v1/api-tokens/{id}',
    domain: 'api_integration',
    action: 'delete',
    summary: '撤销 Token（危险动作，AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
  }),
  defineRoute({
    operationId: 'platform.permission.update',
    method: 'PATCH',
    path: '/api/v1/employees/{employeeId}/permissions',
    domain: 'permission',
    action: 'update',
    summary: '员工个人级权限覆盖（D50；经理不可改老板/财务/其他经理）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    // If-Match 选填（员工 version 暂无读接口）：缺省跳过版本校验并审计 versionChecked=false；
    // 传入则仍按强 ETag 校验。见 permission-overrides.ts 用例注释。
    requiresIfMatch: false,
    dryRun: true,
    request: { body: PermissionOverrideInput },
  }),
];

export const ROUTE_PARAM = IdParam;
