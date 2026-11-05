-- 0012_processing_orders.sql
-- 加工单 B（单头 + 材料投入批次 + 费用明细）。
--
-- 依据：
--   packages/contracts/src/processing-orders.ts（ProcessingOrder /
--   ProcessingOrderFee / ProcessingOrderDetail）、《接口契约第一批》§3.2 / §5.2 / §9 / §10。
--
-- 口径：
--   * D5 / F3：投入量在开单时录入；损耗量 / 可售量在本批可为空，
--     有值时 sellable_qty = input_qty - loss_qty，二者必须成对出现；
--   * D15：三张表均为 tenant_id + company_id 行级隔离，并 ENABLE/FORCE RLS；
--   * D16：单号由服务端取号，格式 `B-<公司码4>-<日期8>-<流水4>`，租户内唯一；
--   * D21：取消只置状态、不物理删除；有下游库存流水时由应用层拦截；
--   * D39：加工费 / 运杂费金额必须 >= 0，数据库 CHECK 兜底；
--   * D47：单据与明细不做物理删除，错账走冲正单据；
--   * D51：审计由应用层与业务写同事务落 audit_outbox，本迁移不建审计旁路；
--   * D54：金额与数量一律 numeric(18,6)（复用 0001 的 `amount` domain）；
--   * output_batch_id 是后续「验收 / 完成」生成产出批次的占位列，本批不写入；
--   * material_batch_ids 的契约数组顺序由 line_no 保持。
--
-- 历史迁移（0001-0011）一律不改：本文件是纯前向追加，回滚靠后续迁移。

-- ---------------------------------------------------------------------------
-- 1. 加工单单头
-- ---------------------------------------------------------------------------

CREATE TABLE processing_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 公司隔离（D15）：加工单归属单一公司，跨公司不可见。
  company_id uuid NOT NULL REFERENCES company (id),
  -- 单号（D16）：服务端取号，租户内唯一。
  order_no text NOT NULL CHECK (length(btrim(order_no)) > 0),
  -- 加工厂必须与单头同公司，被单据引用后禁止物理删除。
  processor_id uuid NOT NULL REFERENCES processor (id) ON DELETE RESTRICT,
  -- 经手人。
  handler_id uuid NOT NULL REFERENCES employee (id) ON DELETE RESTRICT,
  -- 状态复用单据框架三态（§10，D54 §9-6 保留中文原值）。
  status text NOT NULL DEFAULT '进行中'
    CHECK (status IN ('进行中', '已完成', '已取消')),
  -- 辅料说明；选填，进成本（§3.2）。
  aux_materials text CHECK (aux_materials IS NULL OR char_length(aux_materials) <= 500),
  -- 投入量、损耗量、可售量（D5 / F3 / D54）。
  input_qty amount NOT NULL CHECK (input_qty >= 0),
  loss_qty amount CHECK (loss_qty >= 0),
  sellable_qty amount CHECK (sellable_qty >= 0),
  -- 归属 E / N 单（D18 / D35），选填。
  attribution_doc text CHECK (
    attribution_doc IS NULL
    OR attribution_doc ~ '^[EN]-[0-9]{4}-[0-9]{8}-[0-9]{4}$'
  ),
  -- 产出批次占位：本批恒为 NULL，后续完成端点生成批次后回填。
  output_batch_id uuid REFERENCES inventory_batch (id) ON DELETE RESTRICT,
  -- 费用合计，由 processing_order_fee 的金额 SUM 维护；仅内部成本口径使用。
  fee_amount amount NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  -- 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processing_order_tenant_order_no_key UNIQUE (tenant_id, order_no),
  CONSTRAINT processing_order_loss_pair CHECK (
    (loss_qty IS NULL AND sellable_qty IS NULL)
    OR (
      loss_qty IS NOT NULL
      AND sellable_qty IS NOT NULL
      AND loss_qty <= input_qty
      AND sellable_qty = input_qty - loss_qty
    )
  )
);

CREATE INDEX processing_order_tenant_company_processor_idx
  ON processing_order (tenant_id, company_id, processor_id);
CREATE INDEX processing_order_tenant_company_status_idx
  ON processing_order (tenant_id, company_id, status);

-- ---------------------------------------------------------------------------
-- 2. 材料投入批次（至少 1 条由契约层校验，D22 公司归属由应用层校验）
-- ---------------------------------------------------------------------------

CREATE TABLE processing_order_material_batch (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_id uuid NOT NULL REFERENCES processing_order (id) ON DELETE RESTRICT,
  -- 保持请求数组顺序；修改时整体替换。
  line_no integer NOT NULL CHECK (line_no >= 1),
  batch_id uuid NOT NULL REFERENCES inventory_batch (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processing_order_material_batch_order_line_no_key UNIQUE (order_id, line_no)
);

CREATE INDEX processing_order_material_batch_tenant_order_idx
  ON processing_order_material_batch (tenant_id, order_id);
CREATE INDEX processing_order_material_batch_tenant_batch_idx
  ON processing_order_material_batch (tenant_id, batch_id);

-- ---------------------------------------------------------------------------
-- 3. 费用明细（D39：B 单加工费 / 运杂费金额必须 >= 0）
-- ---------------------------------------------------------------------------

CREATE TABLE processing_order_fee (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_id uuid NOT NULL REFERENCES processing_order (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  fee_name text NOT NULL CHECK (length(btrim(fee_name)) > 0),
  qty amount NOT NULL CHECK (qty >= 0),
  unit_price amount NOT NULL CHECK (unit_price >= 0),
  amount amount NOT NULL CHECK (amount >= 0),
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processing_order_fee_order_line_no_key UNIQUE (order_id, line_no)
);

CREATE INDEX processing_order_fee_tenant_order_idx
  ON processing_order_fee (tenant_id, order_id);

-- ---------------------------------------------------------------------------
-- 4. updated_at 自动维护（明细随单头整体替换，不建触发器）
-- ---------------------------------------------------------------------------

CREATE FUNCTION processing_order_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER processing_order_touch_updated_at
BEFORE UPDATE ON processing_order
FOR EACH ROW
EXECUTE FUNCTION processing_order_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. 应用角色授权 + RLS 兜底（D15 / D55①）
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON processing_order TO qingdan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON processing_order_material_batch TO qingdan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON processing_order_fee TO qingdan_app;

ALTER TABLE processing_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_order FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON processing_order;
CREATE POLICY tenant_isolation ON processing_order
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE processing_order_material_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_order_material_batch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON processing_order_material_batch;
CREATE POLICY tenant_isolation ON processing_order_material_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE processing_order_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_order_fee FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON processing_order_fee;
CREATE POLICY tenant_isolation ON processing_order_fee
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
