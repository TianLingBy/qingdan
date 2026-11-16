-- 20261117013000_drop_masterdata_status.sql
-- 主数据去掉 status 列（客户 / 商品 / 供应商 / 加工厂）。
--
-- 背景：
--   * 0004-0007 给四张主数据表都加了 `status text NOT NULL DEFAULT '启用'
--     CHECK (status IN ('启用', '停用'))`，删除接口实际是软删除（置「停用」，
--     不物理删，D62⑤）；
--   * 本次变更取消「停用」概念：删除改为物理删除，行不再保留；
--     仍被单据引用时由现有外键（`ON DELETE RESTRICT`）拦下，
--     由 API 翻译成 409 `STATE_CONFLICT` + `details.reason = HAS_REFERENCES`。
--
-- 口径：
--   * 只删四张主数据表的 status；**不动** `employee.status`、也不动各类单据的 status；
--   * 列上的 CHECK 是列级约束，随 `DROP COLUMN` 一并删除，无需单独 DROP CONSTRAINT；
--   * 历史迁移 0004-0007 不改，本文件纯前向追加；
--   * 前端主数据列表不再有状态筛选，契约里这四个实体的 `status` 字段已移除。
--
-- 回滚说明：前向原则下不写回填；回滚需重新加列并按业务口径补默认值（运维另行处理）。

ALTER TABLE customer DROP COLUMN status;
ALTER TABLE product DROP COLUMN status;
ALTER TABLE supplier DROP COLUMN status;
ALTER TABLE processor DROP COLUMN status;
