-- 0033_allow_view_handler_action.sql
-- 新增第 9 个权限动作 `view_handler`（看经手人），用于单据「负责人」字段可见性（D85 / #227）。
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
