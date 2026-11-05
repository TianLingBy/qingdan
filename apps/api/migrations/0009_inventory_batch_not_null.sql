-- 0009_inventory_batch_not_null.sql
-- 批次必填字段收口：locked_unit_cost / custodian_id 收紧为 NOT NULL。
--
-- 依据：
--   《接口契约第一批》§7 批次（冻结口径）——「锁定单价 ✅必填」「保管人 ✅必填」。
--   0008_inventory_core.sql 建表时把这两列落成了可空，与契约不一致（PR #57 报出）。
--
-- 为什么不改 0008：
--   0008 已发布并带 checksum 记录，规则是「已发布形态的迁移不许改」；
--   修改历史文件会触发 checksum 漂移直接失败，因此用本文件前向收口。
--
-- 存量数据：
--   若目标库已存在 NULL 行，SET NOT NULL 会失败，需先回填后再执行本迁移，例如：
--     UPDATE inventory_batch
--        SET locked_unit_cost = 0
--      WHERE locked_unit_cost IS NULL;
--     UPDATE inventory_batch
--        SET custodian_id = <责任员工 uuid>
--      WHERE custodian_id IS NULL;
--   当前无生产数据（批次表尚未写入），故本文件直接收紧，不含回填语句。

ALTER TABLE inventory_batch ALTER COLUMN locked_unit_cost SET NOT NULL;
ALTER TABLE inventory_batch ALTER COLUMN custodian_id SET NOT NULL;
