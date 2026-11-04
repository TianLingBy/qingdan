import type { RouteDef } from './registry.js';

/**
 * MCP 工具命名（D54）：`qingdan_<domain>_<action>`，与 operationId 一对一。
 * operationId 形如 `platform.token.revoke` / `sales.create`，点转下划线。
 */
export function mcpToolName(route: Pick<RouteDef, 'operationId'>): string {
  return `qingdan_${route.operationId.replace(/\./g, '_')}`;
}

/** 危险动作（D54 ⑥）：删除 / 冲正 / 成本更正 / 结算确认 / 权限变更。 */
const DANGEROUS_SUFFIXES = ['.delete', '.revoke', '.reverse', '.cost-correct', '.confirm', '.permission-update'];

export function isDangerousOperation(operationId: string): boolean {
  return DANGEROUS_SUFFIXES.some((s) => operationId.endsWith(s)) || operationId.includes('.permission.');
}

/**
 * MCP 层是否允许该工具被调用（默认拒绝危险动作，租户可配为「走审批」）。
 * 返回值直接用于工具描述与调用前拦截。
 */
export function mcpPolicy(route: RouteDef, tenantAllowsApproval: boolean): 'allow' | 'require-approval' | 'forbid' {
  if (route.ai.policy === 'allow') return 'allow';
  return tenantAllowsApproval ? 'require-approval' : 'forbid';
}
