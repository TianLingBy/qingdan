-- 20261120030000_customer_return_preset_backfill.sql
-- 预设覆盖护栏（#414 / PR #415）跑出来的最大一个洞：`customer_return` 整块在
-- 任何非老板预设里都不存在 —— 连发起都做不了。
--
-- 现状（补之前）：
--   * 销售预设：没有 customer_return 任何一格
--   * 销售+仓管：同样没有
--   * 纯仓管：同样没有
--   * 财务：同样没有
--   只有经理通过 flatMap 拿到 customer_return.read，老板全量。
--
-- 后果：前端 `ReversalsPage.tsx:142-143` 已经按权限判了
--       canCreate={allows(scope, 'customer_return', 'create')}
--       canApprove={allows(scope, 'customer_return', 'approve')}
--       所以销售的「新建客户退货」按钮是灰的、仓管的「确认」按钮也是灰的 ——
--       整个客户退货功能只有老板一个人能用。
--
-- 补法（按动作的实物归属分）：
--   create   登记退货 —— 客户先找销售，所以给销售。
--   approve  确认收货并入库 —— 货回到库房才算数，所以给仓管。
--   财务不给：退款走结算模块（settlement），customer_return.approve 只管入库这件事。
--
-- 边界（与 20261120010000 / 20261120020000 同口径）：
--   * 只补「仍是系统预设」的岗位（position.is_system = true 且 preset_key 命中）。
--     自定义岗位是老板自己排的权限，不由预设迁移改动。
--   * 不动 employee_permission_override：那是个人的显式覆盖，不该被预设 backfill 冲掉。
--   * 不动 employee 表：权限按 preset 实时算，预设变了在职员工立刻生效。
--   * 已被显式置为 granted = false 的格子会重新打开 —— 这是有意的：旧口径下
--     这些格子根本不存在，任何「收回」都没有实际意义。
--
-- 回滚说明：前向原则下不写 DROP；如需回退，手工删掉这三类岗位的 customer_return 行即可。

-- 销售：登记退货 + 看列表/详情
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'customer_return', 'read', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'sales'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'customer_return', 'create', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'sales'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

-- 纯仓管：确认收货入库 + 看列表/详情（create 归销售，仓管不登记）
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'customer_return', 'read', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'warehouse'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'customer_return', 'approve', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'warehouse'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

-- 销售+仓管是一岗兼两职：三个动作都要。
-- 注意两个预设的 preset_key 同为 'sales'，前两条已经给它们都插了 read/create，
-- 这一条只补 approve 给「销售+仓管」那一个（按 name 区分 —— 用 scope 反查太脆弱，
-- 用 name 至少改的时候一眼能看出是哪一个）。
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'customer_return', 'approve', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'sales'
   AND name = '销售+仓管'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;
