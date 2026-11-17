-- 0033_stocktake_reject_reason.sql
-- 盘点单驳回原因（Issue #287）。
--
-- 依据：
--   packages/contracts/src/stocktakes.ts（stocktake.reject / StocktakeRejectInputSchema）
--   D15 / D47 / D51 / D52 / D54 / D60 / D67。
--
-- 口径：
--   * 状态枚举 0017 已含「已驳回」，本次只补原因列，让驳回可达且必须留痕；
--   * 驳回必须留原因：`已驳回` 状态下 reject_reason 非空；
--   * 原因长度 1~200（去首尾空白后），与契约 `reason` 上限一致；
--   * 驳回只改状态 / 原因 / 审批人 / version，**不动库存、不写 inventory_flow**
--     （与批准最大的区别，D47 / D67）；
--   * 历史迁移（0001-0032）一律不改：本文件是纯前向追加。

ALTER TABLE inventory_stocktake ADD COLUMN reject_reason text;

ALTER TABLE inventory_stocktake
  ADD CONSTRAINT inventory_stocktake_reject_reason_length_check
  CHECK (
    reject_reason IS NULL
    OR length(btrim(reject_reason)) BETWEEN 1 AND 200
  );

-- 驳回必须留原因；其他状态不要求（批准 / 待审批时为空）。
ALTER TABLE inventory_stocktake
  ADD CONSTRAINT inventory_stocktake_reject_reason_required_check
  CHECK (status <> '已驳回' OR reject_reason IS NOT NULL);
