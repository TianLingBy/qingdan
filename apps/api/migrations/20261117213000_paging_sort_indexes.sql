-- D95 页码分页与排序：为三个试点列表的排序键建复合索引。
-- 为什么都带 id：排序一律以 id 收尾保证稳定序，复合索引必须与 ORDER BY 完全对齐才能走索引扫描，
-- 否则 PostgreSQL 会改成 Sort 节点，几万行时每次翻页都要重排一遍。
-- 为什么用 IF NOT EXISTS：迁移要能在已经手工建过索引的环境上重复执行。
-- 列名依据：
--   sales_order.occurred_at 不存在（0013_sales_orders.sql 只有 created_at），排序键用 created_at；
--   purchase_order 同理（0010_purchase_orders.sql）；
--   inventory_batch.inbound_at 不存在（0008_inventory_core.sql 无该列），入厂时间用 created_at 兜底。
CREATE INDEX IF NOT EXISTS sales_order_created_at_id_idx
  ON sales_order (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS purchase_order_created_at_id_idx
  ON purchase_order (created_at DESC, id DESC);
-- available_qty 是 STORED 生成列（0008_inventory_core.sql:47-49），生成列可建索引。
CREATE INDEX IF NOT EXISTS inventory_batch_created_at_id_idx
  ON inventory_batch (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS inventory_batch_available_qty_id_idx
  ON inventory_batch (available_qty DESC, id DESC);
