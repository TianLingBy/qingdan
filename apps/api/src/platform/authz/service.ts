import {
  ACTION_KEYS,
  AppError,
  DOMAIN_KEYS,
  ScopeMatrixSchema,
  allowsScope,
  type ScopeMatrix,
} from '@qingdan/contracts';
import type { SqlClient } from '../db/client.js';

/**
 * 权限判定服务（D15 / D50 / D52.1 / domain-model §2.3）。
 *
 * 三层合并，一条 SQL 出结果（每请求现算、不缓存 —— D52.1②）：
 *   ① 岗位并集基线：员工在「绑定公司集合」内全部绑定的 position_permission ∪；
 *   ② ⊕ 个人覆盖：granted=true 加、granted=false 减（覆盖优先于基线）；
 *   ③ 公司集合：员工绑定公司；老板 ⇒ 全租户公司。
 * 再把 token scope（若为 AI/API 凭证）按交集收窄 —— scope 只能减不能加，AI 生效权限恒 ⊆ 委托人权限。
 *
 * 员工停用 / 租户停用 / 员工不属于该租户 → 返回 null（调用方映射 401/403）。
 * tenant 表不参与 RLS（隔离根），其余表在 RLS 下运行——调用方必须已按请求设置 `app.tenant_id`。
 */

export interface AuthzInput {
  readonly employeeId: string;
  readonly tenantId: string;
  /** API Token / AI 凭证的 scope；人类会话不传。 */
  readonly tokenScope?: ScopeMatrix;
}

export interface AuthzResult {
  /** 数据可见范围；老板 = 全租户公司。 */
  readonly companyIds: readonly string[];
  /** 已含个人覆盖与 token scope 交集的生效权限。 */
  readonly scope: ScopeMatrix;
  /** 是否老板（employee.is_owner）；供 /auth/me 下发身份位（Issue #227）。 */
  readonly isOwner: boolean;
}

interface PermissionRow {
  domain: string;
  action: string;
}

interface AuthzQueryRow {
  company_ids: string[] | null;
  permissions: PermissionRow[] | null;
  is_owner: boolean;
}

const AUTHZ_SQL = `WITH emp AS (
  SELECT e.id, e.is_owner
  FROM employee e
  JOIN tenant t ON t.id = e.tenant_id
  WHERE e.id = $1
    AND e.tenant_id = $2
    AND e.status = '在职'
    AND t.status = '启用'
),
company_set AS (
  SELECT c.id AS company_id
  FROM company c
  JOIN emp ON emp.is_owner AND c.tenant_id = $2
  UNION
  SELECT ecp.company_id
  FROM employee_company_position ecp
  JOIN emp ON ecp.employee_id = emp.id AND NOT emp.is_owner
),
base_permission AS (
  SELECT DISTINCT pp.domain, pp.action
  FROM employee_company_position ecp
  JOIN emp ON ecp.employee_id = emp.id
  JOIN position_permission pp ON pp.position_id = ecp.position_id AND pp.tenant_id = $2
  WHERE pp.granted
),
overrides AS (
  SELECT domain, action, granted
  FROM employee_permission_override
  WHERE employee_id = $1 AND tenant_id = $2
),
final_permission AS (
  SELECT domain, action
  FROM base_permission b
  WHERE NOT EXISTS (
    SELECT 1 FROM overrides o
    WHERE o.domain = b.domain AND o.action = b.action AND NOT o.granted
  )
  UNION
  SELECT domain, action FROM overrides WHERE granted
)
SELECT
  (SELECT coalesce(json_agg(company_id ORDER BY company_id), '[]'::json) FROM company_set) AS company_ids,
  (
    SELECT coalesce(json_agg(json_build_object('domain', domain, 'action', action)), '[]'::json)
    FROM final_permission
  ) AS permissions,
  (SELECT is_owner FROM emp) AS is_owner
FROM emp`;

/**
 * 一条 SQL 算出员工生效权限；员工/租户停用或不属于该租户时返回 null。
 */
export async function computeAuthz(db: SqlClient, input: AuthzInput): Promise<AuthzResult | null> {
  const result = await db.query<AuthzQueryRow>(AUTHZ_SQL, [input.employeeId, input.tenantId]);
  const row = result.rows[0];
  if (!row) return null;

  const companyIds = (row.company_ids ?? []).map(String).sort();

  // 老板 = 全权限免配（D15 / F8）：不依赖岗位绑定，直接给全量域 × 动作。
  if (row.is_owner) {
    const ownerScope = DOMAIN_KEYS.map((domain) => ({
      domain,
      actions: [...ACTION_KEYS],
    })) as ScopeMatrix;
    const narrowed = input.tokenScope
      ? ownerScope
          .map((entry) => ({
            ...entry,
            actions: entry.actions.filter((action) => allowsScope(input.tokenScope!, entry.domain, action)),
          }))
          .filter((entry) => entry.actions.length > 0)
      : ownerScope;
    const parsedOwner = ScopeMatrixSchema.safeParse(narrowed);
    if (!parsedOwner.success) {
      throw new AppError('INTERNAL_ERROR', '老板全量权限不符合契约域/动作取值', {
        employeeId: input.employeeId,
        tenantId: input.tenantId,
      });
    }
    return { companyIds, scope: parsedOwner.data, isOwner: true };
  }

  const byDomain = new Map<string, string[]>();
  for (const permission of row.permissions ?? []) {
    const actions = byDomain.get(permission.domain) ?? [];
    actions.push(permission.action);
    byDomain.set(permission.domain, actions);
  }

  let scope: ScopeMatrix = [...byDomain.entries()]
    .map(([domain, actions]) => ({
      domain: domain as ScopeMatrix[number]['domain'],
      actions: actions.sort() as ScopeMatrix[number]['actions'],
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));

  if (input.tokenScope) {
    // 交集：token scope 只能收窄员工的生效权限，绝不能补出员工没有的权限（D52.1① / 不变量 I7）。
    scope = scope
      .map((entry) => ({
        ...entry,
        actions: entry.actions.filter((action) =>
          allowsScope(input.tokenScope!, entry.domain, action),
        ),
      }))
      .filter((entry) => entry.actions.length > 0);
  }

  const parsed = ScopeMatrixSchema.safeParse(scope);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', '权限数据超出契约域/动作取值，拒绝判定', {
      employeeId: input.employeeId,
      tenantId: input.tenantId,
    });
  }

  return { companyIds, scope: parsed.data, isOwner: false };
}
