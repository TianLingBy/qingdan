-- 0035_workbench_position_domain.sql
-- 新增功能域 workbench（D89 / #289）：岗位模板与个人覆盖的 domain CHECK 必须放行 'workbench'。
--
-- 依据：
--   * packages/contracts/src/domains.ts —— DOMAINS 新增 workbench；
--   * packages/contracts/src/authz.ts —— ScopeMatrixSchema 新增 workbench；
--   * 岗位模板（position_permission）与个人覆盖（employee_permission_override）的 domain
--     在 0001 里是 CHECK 白名单；不改 CHECK，seed 的 workbench.read 与权限设置页写入都会失败。
--
-- 口径：只追加 workbench，不动其它域；历史迁移（0001-0034）不改，本文件纯前向追加。
-- 回滚说明：前向原则下不写 DROP；回滚应用即可让旧代码忽略该域（旧 CHECK 不含 workbench 时
-- 需先清掉 workbench 行，属运维另行处理）。

ALTER TABLE position_permission
  DROP CONSTRAINT position_permission_domain_check;

ALTER TABLE position_permission
  ADD CONSTRAINT position_permission_domain_check CHECK (
    domain IN (
      'purchase', 'processing', 'sales', 'internal_trade', 'settlement', 'commission',
      'customer_return', 'supplier_return', 'stocktake', 'product', 'customer', 'supplier',
      'processor', 'inventory_qty', 'inventory_flow', 'stocktake_page', 'employee',
      'permission', 'company', 'profit_report', 'audit', 'api_integration', 'workbench'
    )
  );

ALTER TABLE employee_permission_override
  DROP CONSTRAINT employee_permission_override_domain_check;

ALTER TABLE employee_permission_override
  ADD CONSTRAINT employee_permission_override_domain_check CHECK (
    domain IN (
      'purchase', 'processing', 'sales', 'internal_trade', 'settlement', 'commission',
      'customer_return', 'supplier_return', 'stocktake', 'product', 'customer', 'supplier',
      'processor', 'inventory_qty', 'inventory_flow', 'stocktake_page', 'employee',
      'permission', 'company', 'profit_report', 'audit', 'api_integration', 'workbench'
    )
  );

-- 默认给所有已有岗位授予 workbench.read（D89）：新端点 `GET /api/v1/todos` 的
-- 端点权限点是 workbench.read；不 backfill 的话，除老板（全权限免配）外所有
-- 既有岗位在迁移后都会 403。出厂预设的同一初值见 platform/db/seed.ts（新库）。
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'workbench', 'read', true
  FROM position
ON CONFLICT (position_id, domain, action) DO NOTHING;
