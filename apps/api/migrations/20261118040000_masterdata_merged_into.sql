-- 20261118040000_masterdata_merged_into.sql
-- 主数据「合并」的落地结构（#302 块 D / D103）。
--
-- 依据：
--   * D98：`merge` 是独立权限动作（第 10 个动作），合并 = 两条档案揉成一条；
--   * D102：`masterdata_dedupe.state` 有三态 `pending / kept / merged`，本块负责写出 `merged`；
--   * D47：历史迁移 0001-20261118030000 一律不改，本文件纯前向追加。
--
-- 本文件只做三件事：
--   1. 四张主数据表各加 `merged_into_id`（被并进哪一条）+ 自指 CHECK + 反查索引；
--   2. 给「合并要改写的那 9 个引用列」补索引（PG 不会为 REFERENCES 自动建索引）；
--   3. 给 `masterdata_dedupe.left_id` 补索引（合并要按两侧 id 反查同一档案的其它待判对子）。
--
-- 回滚说明（前向原则下不写 DROP）：三样都是纯追加（列可空、索引不影响语义），
-- 回滚应用即可让旧代码忽略它们；要彻底移除另起后续迁移。

-- ---------------------------------------------------------------------------
-- 1. 被合并指向：`merged_into_id` 是「这条档案并到哪去了」的唯一答案
-- ---------------------------------------------------------------------------
--
-- 为什么不靠 `dedupe_state='merged'` 反推（D103②）：
--   `dedupe_state` 只说明「这条曾经参与过一次合并」，说不出合并的**方向**。
--   审计要回答「张记建材（老）现在挂在哪条档案上」，答案必须是这条边的终点；
--   没有这一列就只能把 `masterdata_dedupe` 里所有 `state='merged'` 的行捞出来
--   按 kind + id 在应用层拼图，遇到「A→B、B→C」这种链式合并还会拼错。
--
-- 为什么是 `ON DELETE RESTRICT` 而不是级联（D103）：
--   被合并的那条档案本身不该被物理删除（历史单据已改挂到留存档案，但档案行是
--   审计链上的节点）；留存档案更不能被删——它是引用终点。`RESTRICT` 让「删掉被引用的
--   档案」在数据库层直接失败，而不是悄悄把 `merged_into_id` 变成悬空指针。

ALTER TABLE customer
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES customer (id) ON DELETE RESTRICT;
ALTER TABLE supplier
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES supplier (id) ON DELETE RESTRICT;
ALTER TABLE processor
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES processor (id) ON DELETE RESTRICT;
ALTER TABLE product
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES product (id) ON DELETE RESTRICT;

COMMENT ON COLUMN customer.merged_into_id IS
  '被并进哪条客户档案；NULL = 未被合并。合并方向由这一列单向表达（D103②）';
COMMENT ON COLUMN supplier.merged_into_id IS
  '被并进哪条供应商档案；NULL = 未被合并（D103②）';
COMMENT ON COLUMN processor.merged_into_id IS
  '被并进哪条加工厂档案；NULL = 未被合并（D103②）';
COMMENT ON COLUMN product.merged_into_id IS
  '被并进哪条商品档案；NULL = 未被合并（D103②）';

-- 自指必须拦在数据库层：`A.merged_into_id = A` 会让「这条并到哪去了」形成自环，
-- 应用层任何一次递归解析都会原地打转。合并用例按 id 排序加锁后也能保证 A ≠ B，
-- 但那是应用层的约定，CHECK 才是最后一道。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customer_merged_into_self_check'
  ) THEN
    ALTER TABLE customer ADD CONSTRAINT customer_merged_into_self_check
      CHECK (merged_into_id IS NULL OR merged_into_id <> id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'supplier_merged_into_self_check'
  ) THEN
    ALTER TABLE supplier ADD CONSTRAINT supplier_merged_into_self_check
      CHECK (merged_into_id IS NULL OR merged_into_id <> id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'processor_merged_into_self_check'
  ) THEN
    ALTER TABLE processor ADD CONSTRAINT processor_merged_into_self_check
      CHECK (merged_into_id IS NULL OR merged_into_id <> id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_merged_into_self_check'
  ) THEN
    ALTER TABLE product ADD CONSTRAINT product_merged_into_self_check
      CHECK (merged_into_id IS NULL OR merged_into_id <> id);
  END IF;
END
$$;

-- 两个方向都要能走索引：
--   * 「这条被并到哪去了」（正向：按 id 读一列，主键就够）；
--   * 「谁被并进了这条」（反向：`WHERE merged_into_id = $kept`，合并前校验 + 审计追溯用）。
-- 部分索引跳过绝大多数 `NULL` 行（未被合并的档案是常态），索引因此只有合并过的那几条。
CREATE INDEX IF NOT EXISTS customer_tenant_company_merged_into_idx
  ON customer (tenant_id, company_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplier_tenant_company_merged_into_idx
  ON supplier (tenant_id, company_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS processor_tenant_company_merged_into_idx
  ON processor (tenant_id, company_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_tenant_company_merged_into_idx
  ON product (tenant_id, company_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. 合并要改写的引用列：补索引（PG 不为外键自动建索引）
-- ---------------------------------------------------------------------------
--
-- 合并用例对每个引用列发一条
--   `UPDATE <table> SET <col> = $target WHERE tenant_id = $1 AND company_id = $2 AND <col> = $source`
-- 这 4 列已有 `(tenant_id, company_id, <col>)` 复合索引（建表时的业务索引），能吃：
--   * sales_order (tenant_id, company_id, customer_id)          —— 0013
--   * purchase_order (tenant_id, company_id, supplier_id)        —— 0010
--   * processing_order (tenant_id, company_id, processor_id)     —— 0012
--   * inventory_batch (tenant_id, company_id, product_id)        —— 0008
-- 其余 9 列没有可用索引，`UPDATE` 会全表扫；更糟的是 **`ON DELETE RESTRICT` 的引用检查
-- 也走同一条路径**（删一条被引用的档案要扫遍这些表），所以这 9 条索引不是「合并专用优化」。
-- 命名沿用建表时的 `<table>_tenant_company_<列>_idx`，前两列固定，第三列是引用列。

CREATE INDEX IF NOT EXISTS sales_order_line_tenant_company_product_idx
  ON sales_order_line (tenant_id, company_id, product_id);
CREATE INDEX IF NOT EXISTS purchase_order_line_tenant_company_product_idx
  ON purchase_order_line (tenant_id, company_id, product_id);
CREATE INDEX IF NOT EXISTS supplier_return_line_tenant_company_product_idx
  ON supplier_return_line (tenant_id, company_id, product_id);
CREATE INDEX IF NOT EXISTS customer_return_line_tenant_company_product_idx
  ON customer_return_line (tenant_id, company_id, product_id);
CREATE INDEX IF NOT EXISTS internal_trade_order_line_tenant_company_product_idx
  ON internal_trade_order_line (tenant_id, company_id, product_id);
CREATE INDEX IF NOT EXISTS processing_order_tenant_company_output_product_idx
  ON processing_order (tenant_id, company_id, output_product_id);
CREATE INDEX IF NOT EXISTS purchase_order_line_tenant_company_processor_idx
  ON purchase_order_line (tenant_id, company_id, processor_id);
CREATE INDEX IF NOT EXISTS inventory_batch_tenant_company_held_by_processor_idx
  ON inventory_batch (tenant_id, company_id, held_by_processor_id);
-- 加工厂报价（0007）：合并加工厂时历史报价要跟着改挂，否则留存厂丢了比价历史。
CREATE INDEX IF NOT EXISTS processor_quote_tenant_company_processor_idx
  ON processor_quote (tenant_id, company_id, processor_id);

-- ---------------------------------------------------------------------------
-- 3. 去重队列的反查索引（左侧）
-- ---------------------------------------------------------------------------
--
-- 合并的第 10 步要把 source 参与的其他待判对子一起收口：
--   `WHERE state='pending' AND id <> $pair AND (left_id = $source OR right_id = $source)`
-- `OR` 跨两列，规划器只能走 `BitmapOr`；`right_id` 有索引（20261117223000），
-- `left_id` 没有，缺了这条就只能退化成 Seq Scan 整表。
CREATE INDEX IF NOT EXISTS masterdata_dedupe_left_idx ON masterdata_dedupe (left_id);
