-- 0029_processing_partial_loss_snapshot.sql
ALTER TABLE processing_order
  ADD COLUMN partial_loss_amount amount
    CHECK (partial_loss_amount IS NULL OR partial_loss_amount >= 0);

COMMENT ON COLUMN processing_order.partial_loss_amount IS
  'B 单部分损耗金额快照；全损耗单为 0，历史单据可为空（#186/#197）';
