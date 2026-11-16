-- 20261116154500_allow_view_handler_action.sql
-- 新增第 9 个权限动作 `view_handler`（看经手人），用于单据「负责人」字段可见性（D90 / #227）。
--
-- 0001 里 `position_permission.action` 与 `employee_permission_override.action` 的内联
-- CHECK 只允许 8 个动作，这里放宽为 9 个（追加 view_handler），不改动既有 8 个动作。
-- 契约层已同步：`packages/contracts/src/domains.ts` ACTIONS + `authz.ts` 枚举。

ALTER TABLE position_permission
  DROP CONSTRAINT IF EXISTS position_permission_action_check;

ALTER TABLE position_permission
  ADD CONSTRAINT position_permission_action_check
  CHECK (action IN ('read', 'create', 'update', 'approve', 'ship', 'delete', 'view_price', 'view_handler', 'export'));

ALTER TABLE employee_permission_override
  DROP CONSTRAINT IF EXISTS employee_permission_override_action_check;

ALTER TABLE employee_permission_override
  ADD CONSTRAINT employee_permission_override_action_check
  CHECK (action IN ('read', 'create', 'update', 'approve', 'ship', 'delete', 'view_price', 'view_handler', 'export'));

-- 存量库补授：owner / manager 是默认岗位预设，不是运行时角色判定。
-- 只给这两个预设岗位补四类单据域的 view_handler；自定义岗位保持未授予，管理员可后续显式授予。
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT p.tenant_id, p.id, d.domain, 'view_handler', true
FROM position p
CROSS JOIN (VALUES ('sales'), ('purchase'), ('processing'), ('internal_trade')) AS d(domain)
WHERE p.preset_key IN ('owner', 'manager')
ON CONFLICT (position_id, domain, action) DO NOTHING;
