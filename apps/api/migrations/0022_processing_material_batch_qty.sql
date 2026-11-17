-- 0022_processing_material_batch_qty.sql
-- 材料投入行补「每批投入数量」：B 单完成要按行扣库存、按行算材料成本。
--
-- 依据：
--   * 负责人 2026-11-08 拍板（#136 评论「第 10 题选 A」）；
--   * 现状缺口：processing_order_material_batch 只有 batch_id，整单只有一个 input_qty，
--     导致 D5 成本公式里的「材料成本」无法按批计算，完成时也无法确定各批扣多少；
--   * 契约同步：材料投入由 batchId 数组改为 { batchId, qty }[]，
--     并校验 sum(qty) = processing_order.input_qty；
--   * D54：数量一律 numeric(18,6)（复用 0001 的 amount domain）；
--   * 历史迁移不改，本文件纯前向追加（D47）。
--
-- 注意：本表在 0012 建表时没有数据；若某个环境已有行，需要先手工回填 qty 再执行
--       （本项目尚未上线，实际不存在这种环境）。

ALTER TABLE processing_order_material_batch
  ADD COLUMN qty amount NOT NULL CHECK (qty >= 0);

COMMENT ON COLUMN processing_order_material_batch.qty IS
  '该批材料的投入数量（D54 numeric(18,6)）；完成 B 单时按行扣减库存，并按 qty × 批次锁定价计材料成本（#136）';
