-- 20261120020000_purchase_preset_holes_backfill.sql
-- 预设覆盖护栏（#414）第一次跑出来抓到的采购预设漏洞，补授权（#415 之后单独一单）。
--
-- 抓到的四格（都是「业务上明明有人该做，但那个预设整块没有这个域」）：
--
--   processing.create       找加工厂下单本来是采购跟单的活。此前采购预设整块没有
--                           processing 域，建加工单只能靠老板。
--   processor.create        采购能建供应商（supplier.create），建不了加工厂。
--   processor.update        同上。加工厂改电话、换联系人只能找老板。
--   supplier_return.approve 供应商退货由采购发起并确认出库。此前采购预设没有
--                           supplier_return 任何一格，连发起（create）都做不了。
--
-- 同时补 processing.read 与 supplier_return.read —— 建完/发起的单要能看见自己建了什么。
-- 建单而无列表可看，是另一种形式的死态。
--
-- 边界（与 20261120010000 同口径）：
--   * 只补「仍是系统预设」的岗位（position.is_system = true 且 preset_key = 'purchase'）。
--     自定义岗位是老板自己排的权限，不由预设迁移改动。
--   * 不动 employee_permission_override：那是个人的显式覆盖，不该被预设 backfill 冲掉。
--   * 不动 employee 表：预设变更对已在职员工立即生效（权限是按 preset 实时算的）。
--   * 已被显式置为 granted = false 的格子会重新打开 —— 这是有意的，理由同上一条迁移：
--     旧口径下那几格根本不存在，任何「收回」都没有实际意义。
--
-- 刻意**不补**的两格（需要负责人裁定，不在本迁移里擅自决定）：
--   processing.approve       到货确认与完成会动库存与成本，仍归老板与经理。
--   supplier_return.delete   取消退货是高争议动作（释放待执行占用），仍归老板。
--   customer_return.approve  客户退货完成谁确认未定（仓管实际收货 / 财务退款）。
--
-- 回滚说明：前向原则下不写 DROP；如需回退，手工删掉采购预设的这几行即可。

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'processing', 'read', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'purchase'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'processing', 'create', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'purchase'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'processor', 'read', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'purchase'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'processor', 'create', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'purchase'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'processor', 'update', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'purchase'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'supplier_return', 'read', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'purchase'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'supplier_return', 'create', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'purchase'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'supplier_return', 'approve', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'purchase'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;
