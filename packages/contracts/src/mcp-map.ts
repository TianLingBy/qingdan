import type { RouteDef } from './registry.js';

/**
 * MCP 工具命名（D54）：`qingdan_<domain>_<action>`，与 operationId 一对一。
 * operationId 形如 `platform.token.revoke` / `sales.create`，点转下划线。
 *
 * `workbench.todos.read` 是唯一显式例外（D89 / #289）：产品口径固定工具名
 * `qingdan_todos_read`，不随 operationId 的 `workbench.` 前缀变化；仍保持一对一。
 */
const TOOL_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  'workbench.todos.read': 'qingdan_todos_read',
};

export function mcpToolName(route: Pick<RouteDef, 'operationId'>): string {
  return (
    TOOL_NAME_OVERRIDES[route.operationId] ??
    `qingdan_${route.operationId.replace(/\./g, '_')}`
  );
}

/** 危险动作（D54 ⑥）：删除 / 驳回 / 冲正 / 成本更正 / 结算确认 / 权限变更 / 销售出库（D85）。 */
const DANGEROUS_SUFFIXES = ['.delete', '.reject', '.revoke', '.reverse', '.cost-correct', '.confirm', '.permission-update', '.dispatch_revoke', '.ship'];

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
