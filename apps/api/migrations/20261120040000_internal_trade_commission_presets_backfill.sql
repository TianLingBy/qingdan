-- 20261120040000_internal_trade_commission_presets_backfill.sql
-- 预设覆盖护栏（#414 / PR #415）派生的第二个洞：内部交易与提成比例两个域
-- 在非老板预设里几乎没有格子。
--
-- 补之前的状态：
--   internal_trade  经理有 read + view_handler（flatMap 顺带），其余预设零
--                   销售零、仓管零 —— 但发货与到货确认都是仓管的实物动作
--   commission      整块零（连 read 都没有）—— 销售看不见自己的提成比例
--
-- 按动作的实物归属分：
--   internal_trade.create / .update   经理 —— 调多少、什么内部价是要决策的事
--   internal_trade.ship              纯仓管 —— 发出侧确认发货、锁定本司批次
--   internal_trade.approve           纯仓管 —— 接收侧确认到货、批次转入本司
--   internal_trade.read              销售 + 纯仓管 + 销售+仓管 —— 知道货什么时候到
--   commission.read                  销售 + 财务 —— 提成比例对本人透明，藏起来只会变成猜
--   commission.create / .delete      财务 —— 定费率是财务的活（D77）
--
-- 刻意不补：
--   internal_trade.delete（取消内部交易单）—— 会释放占用，高争议，仍归老板
--   internal_trade.ship 不给经理      —— 经理已有 purchase.ship 可代班，内部交易
--                                        的实物动作交给仓管，避免同一动作两个来源
--
-- 边界（与前三条 backfill 同口径）：
--   * 只补「仍是系统预设」的岗位（position.is_system = true 且 preset_key 命中）。
--   * 不动 employee_permission_override。
--   * 不动 employee 表：权限按 preset 实时算。
--   * granted = false 会重新打开 —— 有意，理由同前。
--
-- 回滚说明：前向原则下不写 DROP；如需回退，手工删掉对应行即可。

-- 经理：内部交易单的开单与改单
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'internal_trade', 'create', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'manager'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'internal_trade', 'update', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'manager'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

-- 销售（两个预设 preset_key 都是 'sales'，都要）：看调拨单 + 看自己的提成比例
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'internal_trade', 'read', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'sales'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'commission', 'read', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'sales'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

-- 财务：提成比例的维护
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'commission', 'read', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'finance'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'commission', 'create', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'finance'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'commission', 'delete', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'finance'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

-- 纯仓管：内部交易的实物动作
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'internal_trade', 'read', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'warehouse'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'internal_trade', 'ship', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'warehouse'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT tenant_id, id, 'internal_trade', 'approve', true
  FROM position
 WHERE is_system = true
   AND preset_key = 'warehouse'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;
