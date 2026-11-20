-- 20261120060000_owner_read_all_backfill.sql
-- D106 补丁：老板预设的 `read_all`。
--
-- 背景：`20261120050000` 加了第 11 个动作 `read_all`，并给经理与财务补了四类单据的
-- 授权，但**漏了老板**。
--
-- 为什么必须补：
--   老板预设的授权行是在 `seed` 时按当时的 `ALL_ACTIONS` 展开写入库的。
--   `read_all` 是后加的动作，所以老库里老板根本不持有这一格 ——
--   `allowsScope(scope, 'sales', 'read_all')` 返回 false，
--   前端「看谁的」下拉不出现，`?scope=all` 直接 403。
--
--   新库（从零 seed）不受影响：`seed.ts` 里老板是
--   `ALL_DOMAINS.flatMap(domain => perms(domain, ALL_ACTIONS))`，自动带上新动作。
--   只有「已经 seed 过、后来才升级」的库会缺 —— 也就是每一个真实部署的库。
--
-- 为什么不在 `20261120050000` 里补：
--   那条迁移已经在 E 盘环境与 CI 上跑过（`schema-guard` 的 `applied` 记录里有了）。
--   改已应用过的迁移文件，新库与老库的结果会不一致，而这正是迁移最不该发生的事。
--
-- 只补系统预设、不动 `employee_permission_override`：管理员手工关掉某一格是刻意的，
-- 迁移不该把它打开。

INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT p.tenant_id, p.id, d.domain, 'read_all', true
  FROM position p
 CROSS JOIN (VALUES ('sales'), ('purchase'), ('processing'), ('internal_trade')) AS d(domain)
 WHERE p.is_system = true
   AND p.preset_key = 'owner'
ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true;
