-- 20261118020000_payment_permission_domain.sql
-- payment 域落地到权限表（D101 / #101）：岗位模板与个人覆盖的 domain CHECK 必须放行 'payment'。
--
-- 背景：payment 域在 packages/contracts/src/domains.ts 里早就存在（第 25 域，随 #101 契约落地），
-- 但 0001 的 position_permission / employee_permission_override 的 domain 是 CHECK 白名单，
-- 20261116043100 只追加过 workbench。不改 CHECK，会出现「契约上有 payment.create，
-- 权限设置页却写不进库」——非老板账号永远授不了发起支付的权限，
-- 而接口本身好使（老板运行时按 DOMAIN_KEYS 全量下发），问题只在授权侧，很难被测试发现。
--
-- 口径：
--   * 只追加 payment，不动其它域；存量迁移不改，本文件纯前向追加。
--   * 出厂预设的同一初值见 platform/db/seed.ts（新库）。
--
-- 回滚说明：前向原则下不写 DROP；回滚应用即可让旧代码忽略该域
-- （旧 CHECK 不含 payment 时需先清掉 payment 行，属运维另行处理）。

ALTER TABLE position_permission
  DROP CONSTRAINT position_permission_domain_check;

ALTER TABLE position_permission
  ADD CONSTRAINT position_permission_domain_check CHECK (
    domain IN (
      'purchase', 'processing', 'sales', 'internal_trade', 'settlement', 'commission',
      'customer_return', 'supplier_return', 'stocktake', 'product', 'customer', 'supplier',
      'processor', 'inventory_qty', 'inventory_flow', 'stocktake_page', 'employee',
      'permission', 'company', 'profit_report', 'audit', 'api_integration',
      'workbench', 'payment'
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
      'permission', 'company', 'profit_report', 'audit', 'api_integration',
      'workbench', 'payment'
    )
  );

-- 默认给老板 / 经理 / 财务三个预设授予 payment 的 read + create（D101）：
-- 发起收款是「建一笔收款意图」，财务与经理本来就管钱；不发起的岗位（仓管、采购）
-- 不该有，需要时由有 permission.update 的人在权限设置页单独授。
-- 不 backfill 的话，存量环境升级后除老板（运行时全量下发）外，财务点「收款」会 403。
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT p.tenant_id, p.id, d.domain, d.action, true
  FROM position p
 CROSS JOIN (VALUES ('payment', 'read'), ('payment', 'create')) AS d(domain, action)
 WHERE p.preset_key IN ('owner', 'manager', 'finance')
ON CONFLICT (position_id, domain, action) DO NOTHING;
