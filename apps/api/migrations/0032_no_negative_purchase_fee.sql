-- 0032_no_negative_purchase_fee.sql
-- A 单（采购）费用金额收紧为「不得为负，最低 0」。
--
-- 原因（2026-11-15 产品口径）：
--   费用行（运费 / 杂费 / 加工费）由开单人手动填写，必填、最低 0。
--   费用一律增加采购成本，不存在「负数费用冲减成本」的业务场景；
--   原来的 D39（负数必须带备注，用于供应商返利 / 对方承担运费）随之作废。
--
-- 为什么这条收在数据库层：
--   契约层已把 `amount` 改成非负 schema，但历史数据与直连写入不受契约约束；
--   这里补一条 CHECK 兜底，避免绕过 API 写进负数把成本算歪。
--
-- 只收紧 A 单。B 单（processing_order_fee）与 E 单（sales_order_fee）暂不动，
-- 待主线确认后再单独出迁移。

-- 先删掉旧的「允许负数但要求备注」的约束，避免与新约束语义重叠。
ALTER TABLE purchase_order_fee
  DROP CONSTRAINT IF EXISTS purchase_order_fee_negative_requires_remark;

ALTER TABLE purchase_order_fee
  ADD CONSTRAINT purchase_order_fee_amount_non_negative CHECK (amount >= 0);
