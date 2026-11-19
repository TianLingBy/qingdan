-- 20261120010000_purchase_ship_preset_backfill.sql
-- D94 口径补全（#402）：采购发货从 update 拆成独立的 `purchase.ship` 后，
-- 出厂预设的经理 / 纯仓管 / 采购三个岗位都该持有它 —— 采购员是实际发货人、
-- 仓管是实际出库人、经理要能代班。新库由 platform/db/seed.ts 直接写；本文件
-- 只补存量租户，是一次性的预设数据补全，不改任何业务逻辑。
--
-- 边界：
--   * 只补「仍是系统预设」的岗位（position.is_system = true 且 preset_key 命中三者）。
--     自定义岗位是老板自己排的权限，不由预设迁移改动。
--   * 不动 employee_permission_override：那是个人的显式覆盖，不该被预设 backfill 冲掉。
--   * 若某个预设的 purchase.ship 已被显式置为 granted = false，这里会重新打开 ——
--     **这是有意的**：那一轮的「收回」发生在旧口径下（当时根本没人能发货，
--     收回没有实际意义），保留它只会让改版后继续无人能发货。
-- 回滚说明：前向原则下不写 DROP；如需回退，手工删掉这三类岗位的 purchase/ship 行即可。

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'purchase', 'ship', true
  FROM position
 WHERE is_system = true
   AND preset_key IN ('manager', 'warehouse', 'purchase')
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;
