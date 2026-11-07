-- 0013_sales_orders.sql
-- 销售单 E（单头 + 商品明细 + 行批次引用 + 费用明细）。
--
-- 依据：
--   packages/contracts/src/sales-orders.ts（SalesOrder / SalesOrderLine /
--   SalesOrderFee / SalesOrderDetail）、《接口契约第一批》§3.3 / §5.1 / §5.2 / §10。
--
-- 口径：
--   * D15：四张表均带 tenant_id + company_id，并 ENABLE/FORCE RLS；
--   * D16：单号由服务端取号，格式 `E-<公司码4>-<日期8>-<流水4>`，租户内唯一；
--   * D20：商品行保存创建 / 修改时计算的加权平均批次成本下限，供行级留痕；
--   * D21：取消只置状态、不物理删除；有下游库存流水时由应用层拦截；
--   * D22：行批次引用只接受同一租户、同一公司的批次，应用层校验；
--   * D39：E 单费用行金额必须 >= 0，数据库 CHECK 兜底；
--   * D47：单据与明细不做物理删除，错账走冲正单据；
--   * D54：数量与金额统一使用 numeric(18,6)（复用 0001 的 amount domain）。
--
-- 历史迁移（0001-0012）一律不改：本文件是纯前向追加，回滚靠后续迁移。

-- ---------------------------------------------------------------------------
-- 1. 销售单单头
-- ---------------------------------------------------------------------------

CREATE TABLE sales_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_no text NOT NULL CHECK (length(btrim(order_no)) > 0),
  customer_id uuid NOT NULL REFERENCES customer (id) ON DELETE RESTRICT,
  handler_id uuid NOT NULL REFERENCES employee (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT '进行中'
    CHECK (status IN ('进行中', '已完成', '已取消')),
  goods_amount amount NOT NULL DEFAULT 0 CHECK (goods_amount >= 0),
  fee_amount amount NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  total_amount amount NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_tenant_order_no_key UNIQUE (tenant_id, order_no)
);

CREATE INDEX sales_order_tenant_company_customer_idx
  ON sales_order (tenant_id, company_id, customer_id);
CREATE INDEX sales_order_tenant_company_status_idx
  ON sales_order (tenant_id, company_id, status);

-- ---------------------------------------------------------------------------
-- 2. 商品明细（售价随单据，D20 下限按行保存）
-- ---------------------------------------------------------------------------

CREATE TABLE sales_order_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_id uuid NOT NULL REFERENCES sales_order (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  product_id uuid NOT NULL REFERENCES product (id) ON DELETE RESTRICT,
  qty amount NOT NULL CHECK (qty >= 0),
  unit_price amount NOT NULL CHECK (unit_price >= 0),
  amount amount NOT NULL CHECK (amount >= 0),
  -- D20：创建 / 修改时服务端按本行引用批次计算的加权平均批次成本。
  cost_floor amount NOT NULL CHECK (cost_floor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_line_order_line_no_key UNIQUE (order_id, line_no)
);

CREATE INDEX sales_order_line_tenant_order_idx
  ON sales_order_line (tenant_id, order_id);

-- 行可引用多个批次（D22）；line_no 保持请求中的 batchIds 顺序。
CREATE TABLE sales_order_line_batch (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_id uuid NOT NULL REFERENCES sales_order (id) ON DELETE RESTRICT,
  order_line_id uuid NOT NULL REFERENCES sales_order_line (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  batch_id uuid NOT NULL REFERENCES inventory_batch (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_line_batch_line_no_key UNIQUE (order_line_id, line_no)
);

CREATE INDEX sales_order_line_batch_tenant_order_idx
  ON sales_order_line_batch (tenant_id, order_id);
CREATE INDEX sales_order_line_batch_tenant_batch_idx
  ON sales_order_line_batch (tenant_id, batch_id);

-- ---------------------------------------------------------------------------
-- 3. 费用明细（D39：E 单费用行金额必须 >= 0）
-- ---------------------------------------------------------------------------

CREATE TABLE sales_order_fee (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_id uuid NOT NULL REFERENCES sales_order (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  fee_name text NOT NULL CHECK (length(btrim(fee_name)) > 0),
  qty amount NOT NULL CHECK (qty >= 0),
  unit_price amount NOT NULL CHECK (unit_price >= 0),
  amount amount NOT NULL CHECK (amount >= 0),
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_fee_order_line_no_key UNIQUE (order_id, line_no)
);

CREATE INDEX sales_order_fee_tenant_order_idx
  ON sales_order_fee (tenant_id, order_id);

-- ---------------------------------------------------------------------------
-- 4. updated_at 自动维护（明细随单头整体替换，不建触发器）
-- ---------------------------------------------------------------------------

CREATE FUNCTION sales_order_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_order_touch_updated_at
BEFORE UPDATE ON sales_order
FOR EACH ROW
EXECUTE FUNCTION sales_order_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. 应用角色授权 + RLS 兜底（D15 / D55①）
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order TO qingdan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order_line TO qingdan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order_line_batch TO qingdan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order_fee TO qingdan_app;

ALTER TABLE sales_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sales_order;
CREATE POLICY tenant_isolation ON sales_order
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE sales_order_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_line FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sales_order_line;
CREATE POLICY tenant_isolation ON sales_order_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE sales_order_line_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_line_batch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sales_order_line_batch;
CREATE POLICY tenant_isolation ON sales_order_line_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE sales_order_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_fee FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sales_order_fee;
CREATE POLICY tenant_isolation ON sales_order_fee
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
