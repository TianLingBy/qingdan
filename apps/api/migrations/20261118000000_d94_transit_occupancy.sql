-- 20261118000000_d94_transit_occupancy.sql
-- D94：在途货允许被建单占用。
--
-- 原生成列把 pending 与 in_transit 直接相加扣减；当在途 5、再占用 5 时会得到 -5，
-- 违反 available_qty >= 0。改为：占用优先抵在途量，只有超过在途部分的占用再扣在库可用：
--   available = inbound - referenced - in_transit - GREATEST(pending - in_transit, 0)
-- 到货把 in_transit 清零后，pending 关系自然保留，不需要重建占用。

ALTER TABLE inventory_batch
  DROP CONSTRAINT IF EXISTS inventory_batch_available_qty_nonnegative;

ALTER TABLE inventory_batch
  DROP COLUMN available_qty;

ALTER TABLE inventory_batch
  ADD COLUMN available_qty amount GENERATED ALWAYS AS (
    inbound_qty
    - referenced_qty
    - in_transit_qty
    - GREATEST(pending_execution_qty - in_transit_qty, 0::amount)
  ) STORED;

ALTER TABLE inventory_batch
  ADD CONSTRAINT inventory_batch_available_qty_nonnegative
  CHECK (available_qty >= 0);
