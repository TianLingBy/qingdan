import type { z } from 'zod';
import type { Action, DomainKey, Scope } from './domains.js';
import { DOMAIN_KEYS } from './domains.js';
import { MODULE_KEYS, type ModuleKey } from './modules.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** 审计策略：写操作全量；普通读不记；敏感读必记（D54 ②）。 */
export type AuditKind = 'write' | 'read' | 'sensitive-read' | 'none';

export interface RouteDef {
  /** 审计 action 与 MCP 工具的源键，格式 `domain.资源.动作`（D54 缺口 1）。 */
  readonly operationId: string;
  readonly method: HttpMethod;
  /** 含 `/api/v1` 前缀的完整路径（D54：`/api/v1/<kebab 复数>`）。 */
  readonly path: string;
  /**
   * 归属模块（D62）：`platform` 只挂自己的路由，业务模块的端点在各自模块挂载。
   * 不填默认 `platform`（M0 之前只有平台端点）。
   */
  readonly module: ModuleKey;
  /** 功能域 = 权限 scope 的域段 = OpenAPI tag。 */
  readonly domain: DomainKey;
  readonly action: Action;
  /** 由 defineRoute 推导，`<domain>.<action>`。 */
  readonly scope: Scope;
  readonly audit: { readonly kind: AuditKind; readonly required: boolean };
  readonly ai: { readonly policy: 'allow' | 'forbid'; readonly reasonRequired: boolean };
  readonly summary: string;
  /** 公开只读端点（如 openapi.json / health），不需要认证。 */
  readonly publicAccess: boolean;
  readonly idempotent: boolean;
  readonly requiresIfMatch: boolean;
  readonly dryRun: boolean;
  readonly request?: {
    readonly body?: z.ZodTypeAny;
    readonly query?: z.ZodTypeAny;
  };
  readonly response?: {
    readonly status: number;
    readonly schema: z.ZodTypeAny;
  };
}

export interface RouteInput extends Omit<RouteDef, 'module' | 'scope' | 'audit' | 'ai' | 'publicAccess' | 'idempotent' | 'requiresIfMatch' | 'dryRun'> {
  module?: ModuleKey;
  audit?: { kind: AuditKind; required?: boolean };
  ai?: { policy?: 'allow' | 'forbid'; reasonRequired?: boolean };
  publicAccess?: boolean;
  idempotent?: boolean;
  requiresIfMatch?: boolean;
  dryRun?: boolean;
}

export function defineRoute(input: RouteInput): RouteDef {
  const auditRequired = input.audit?.required ?? (input.audit?.kind === 'write' || input.audit?.kind === 'sensitive-read');
  return {
    ...input,
    module: input.module ?? 'platform',
    scope: `${input.domain}.${input.action}` as Scope,
    audit: { kind: input.audit?.kind ?? 'none', required: auditRequired },
    ai: { policy: input.ai?.policy ?? 'allow', reasonRequired: input.ai?.reasonRequired ?? false },
    publicAccess: input.publicAccess ?? false,
    idempotent: input.idempotent ?? false,
    requiresIfMatch: input.requiresIfMatch ?? false,
    dryRun: input.dryRun ?? false,
  };
}

/** 注册表自检：任何一条不合规都返回错误串（CI 断言为空数组）。 */
export function validateRegistry(routes: readonly RouteDef[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  for (const r of routes) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9-]*)+$/.test(r.operationId)) errors.push(`${r.operationId}: operationId 必须是小写点分串`);
    if (!r.path.startsWith('/api/v1/')) errors.push(`${r.operationId}: 路径必须以 /api/v1/ 开头`);
    if (!/^\/api\/v1\/[a-z0-9.-]+(\/[a-z0-9{}_.-]+)*$/i.test(r.path)) errors.push(`${r.operationId}: 路径不符合 kebab 规则`);
    if (!DOMAIN_KEYS.includes(r.domain)) errors.push(`${r.operationId}: 未登记的功能域 ${String(r.domain)}`);
    if (!(MODULE_KEYS as string[]).includes(r.module)) {
      errors.push(`${r.operationId}: 未登记的归属模块 ${String(r.module)}（D62）`);
    }
    if (!r.operationId.startsWith(r.domain) && !r.operationId.startsWith('platform.')) {
      errors.push(`${r.operationId}: operationId 应以功能域或 platform 开头（审计 action 约定）`);
    }
    if (r.audit.kind !== 'none' && !r.publicAccess && r.method === 'GET' && r.audit.kind === 'write') {
      errors.push(`${r.operationId}: GET 不应是审计 write`);
    }
    if (ids.has(r.operationId)) errors.push(`${r.operationId}: operationId 重复`);
    ids.add(r.operationId);
    const key = `${r.method} ${r.path}`;
    if (endpoints.has(key)) errors.push(`${key}: 端点重复`);
    endpoints.add(key);
  }
  return errors;
}

export function findRoute(routes: readonly RouteDef[], operationId: string): RouteDef | undefined {
  return routes.find((r) => r.operationId === operationId);
}

/** 按归属模块切分路由（D62）：各模块只挂自己的，platform 不得遍历整张表。 */
export function routesOfModule(routes: readonly RouteDef[], module: ModuleKey): RouteDef[] {
  return routes.filter((r) => r.module === module);
}

/** 注册表里出现过的归属模块（去重，保持登记顺序）。 */
export function modulesOf(routes: readonly RouteDef[]): ModuleKey[] {
  const seen: ModuleKey[] = [];
  for (const route of routes) {
    if (!seen.includes(route.module)) seen.push(route.module);
  }
  return seen;
}
