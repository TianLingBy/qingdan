-- 0023_processing_orders_output_product.sql
-- 加工单单头补「成品商品」：B 单完成要建产出批次，必须知道产出的是哪个商品（productId）。
--
-- 依据：
--   * issue #150 决策 A（负责人 2026-11-08 拍板）：开单时必填 outputProductId；
--   * 现状缺口：processing_order 表头没有成品商品列，完成端点无法确定产出批次的 product_id；
--   * 契约同步：ProcessingOrderCreateInput 必填 outputProductId（uuid），
--     实体 / 修改入参为可空 / 可选；
--   * 表列本身可空：仅用于兼容历史行（契约层保证新建必填；本项目尚无生产数据）；
--   * D47：历史迁移 0001-0022 一律不改，本文件纯前向追加。
--
-- 回滚说明（前向原则下不写 DROP）：
--   本列无 NOT NULL / 无默认值，回滚应用即可让旧代码忽略该列；
--   如需彻底移除，另起后续迁移 DROP COLUMN processing_order.output_product_id。

ALTER TABLE processing_order
  ADD COLUMN output_product_id uuid REFERENCES product (id);

COMMENT ON COLUMN processing_order.output_product_id IS
  '成品商品：开单时必填（契约层保证），历史行可空';
