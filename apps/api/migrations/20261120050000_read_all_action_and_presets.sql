-- 20261120050000_read_all_action_and_presets.sql
-- 第 11 个权限动作 `read_all`（看全部）+ 三处预设补授（D106）。
--
-- 口径来源：负责人 2026-11-20 拍板 ——
--   「默认看自己的」「有权限就能看全部，预设里经理财务都可以」「审批也算个权限点」「老板全都可以有」
--   「有权限才能开单、看单」「凡事自己开的单，自己就有所有权限」。
--
-- 这份迁移做四件事：
--   1. 放宽两张权限表的 action CHECK，允许第 11 个动作 `read_all`；
--   2. 经理与财务补四类单据的 `read_all`（要能看全公司的单）；
--   3. 经理补 `sales.approve` / `processing.approve`（签收与到货确认）；
--   4. 经理与财务补 `inventory_qty.approve` —— 这条 11 月就写进 D42 了，一直没种进 seed。
--
-- 纯前向、不删列、不改历史迁移。runner 对每个文件单独开事务（src/platform/db/migrate.ts），
-- 本文件不写 BEGIN / COMMIT。
--
-- 为什么必须单独发一条迁移而不是只改 seed：`seed` 只在新库初始化时跑，
-- 已经在用的库（E 盘那套、任何已部署的）不会重新 seed，CHECK 不放宽就会在
-- 「权限设置页勾一下『看全部』」时 400。

-- ---------------------------------------------------------------------------
-- 1. 放宽 action CHECK 到 11 个（追加 read_all，前 10 个原样保留）
--    `read_all` 排第二位而不是末尾：它和 `read` 是同一族（查 vs 查全部），
--    排序上挨着，权限矩阵勾选表一眼能看出这两个是一组。
-- ---------------------------------------------------------------------------

ALTER TABLE position_permission
  DROP CONSTRAINT IF EXISTS position_permission_action_check;

ALTER TABLE position_permission
  ADD CONSTRAINT position_permission_action_check
  CHECK (action IN ('read', 'read_all', 'create', 'update', 'approve', 'ship', 'delete', 'merge', 'view_price', 'view_handler', 'export'));

ALTER TABLE employee_permission_override
  DROP CONSTRAINT IF EXISTS employee_permission_override_action_check;

ALTER TABLE employee_permission_override
  ADD CONSTRAINT employee_permission_override_action_check
  CHECK (action IN ('read', 'read_all', 'create', 'update', 'approve', 'ship', 'delete', 'merge', 'view_price', 'view_handler', 'export'));

-- ---------------------------------------------------------------------------
-- 2. 经理 / 财务补 `read_all`（四类单据）
--    员工之间默认互相看不了单；要看全部就得有这一格。经理与财务是预设里最该有的两个。
--    纯仓管与采购刻意不给：仓管的视角是货不是单，采购只看自己跟的。
-- ---------------------------------------------------------------------------

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT p.tenant_id, p.id, d.domain, 'read_all', true
FROM position p
CROSS JOIN (VALUES ('sales'), ('purchase'), ('processing'), ('internal_trade')) AS d(domain)
WHERE p.is_system = true AND p.preset_key IN ('manager', 'finance')
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

-- ---------------------------------------------------------------------------
-- 3. 经理补 `sales.approve`（客户签收）与 `processing.approve`（加工到货确认）
--    两个都是「把单子推到终态」的审批动作，属于管理职责而不是执行动作：
--    销售签收 = 确认收入，加工到货 = 确认损耗与产出，都要有人复核。
-- ---------------------------------------------------------------------------

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT p.tenant_id, p.id, d.domain, d.action, true
FROM position p
CROSS JOIN (VALUES ('sales', 'approve'), ('processing', 'approve')) AS d(domain, action)
WHERE p.is_system = true AND p.preset_key = 'manager'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;

-- ---------------------------------------------------------------------------
-- 4. 经理 + 财务补 `inventory_qty.approve`（成本更正审批）
--    D42 原文：「改批次价须走 platform 审批（老板 / 经理 / 财务可审批）」——
--    这句话 11 月就写进决策了，但 seed 里一直只有老板持有这一格，另外两个预设都缺。
--    不是新口径，是补落地。
-- ---------------------------------------------------------------------------

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT p.tenant_id, p.id, 'inventory_qty', 'approve', true
FROM position p
WHERE p.is_system = true AND p.preset_key IN ('manager', 'finance')
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;
