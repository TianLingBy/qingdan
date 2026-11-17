-- 0028_processing_cost_snapshots.sql
-- B 单完成时保存跨模块读取到的成本结果，供全损耗报表只读聚合。
--
-- NULL 表示历史单据尚未经过新的完成流程；不要回填或猜测历史成本。

ALTER TABLE processing_order
  ADD COLUMN material_cost_amount amount
    CHECK (material_cost_amount IS NULL OR material_cost_amount >= 0),
  ADD COLUMN loss_amount amount
    CHECK (loss_amount IS NULL OR loss_amount >= 0);

COMMENT ON COLUMN processing_order.material_cost_amount IS
  'B 单完成时引用材料批次成本合计快照；历史单据可为空（D70 / #195）';
COMMENT ON COLUMN processing_order.loss_amount IS
  'B 单完成时最终损失金额快照；历史单据可为空（D70 / #195）';
