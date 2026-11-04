import { z } from 'zod';

/**
 * 权限 scope：功能域 × 动作子集（契约第三批 §2）。
 * 存 JSON 用数组形态（每域一项，按 domain 去重），便于审计与 diff。
 */
export const ScopeEntrySchema = z.object({
  domain: z.enum([
    'purchase',
    'processing',
    'sales',
    'internal_trade',
    'settlement',
    'commission',
    'customer_return',
    'supplier_return',
    'stocktake',
    'product',
    'customer',
    'supplier',
    'processor',
    'inventory_qty',
    'inventory_flow',
    'stocktake_page',
    'employee',
    'permission',
    'company',
    'profit_report',
    'audit',
    'api_integration',
  ]),
  actions: z.array(
    z.enum(['read', 'create', 'update', 'approve', 'ship', 'delete', 'view_price', 'export']),
  ),
});

export const ScopeMatrixSchema = z.array(ScopeEntrySchema);
export type ScopeMatrix = z.infer<typeof ScopeMatrixSchema>;

export function allowsScope(
  scope: readonly ScopeMatrix[number][],
  domain: ScopeMatrix[number]['domain'],
  action: ScopeMatrix[number]['actions'][number],
): boolean {
  return scope.some((e) => e.domain === domain && e.actions.includes(action));
}

/**
 * D52.1 ①：token 创建时 scope 必须是创建人自身授权的子集，超出直接拒绝创建。
 * 这里只做集合比较；创建人的授权集由 platform 权限引擎现算后传入。
 */
export function scopeIsSubset(
  requested: readonly ScopeMatrix[number][],
  granted: readonly ScopeMatrix[number][],
): boolean {
  return requested.every((req) => req.actions.every((a) => allowsScope(granted, req.domain, a)));
}

/**
 * D50 / D15 三层生效顺序（实现必须按此顺序，不得重排）：
 *   ① 岗位并集基线（可多岗、多公司）
 *   ② ⊕ 员工个人覆盖（可增可减，优先于基线）
 *   ③ ∩ 公司集合（数据可见范围）
 * 纯字符串列表，供测试与文档对齐；判定实现在 apps/api/src/platform/authz。
 */
export const AUTHZ_LAYER_ORDER = ['position_union', 'employee_override', 'company_set'] as const;
