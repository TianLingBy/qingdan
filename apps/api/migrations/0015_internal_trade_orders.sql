-- 0015_internal_trade_orders.sql
-- 内部交易单 N（单头 + 商品明细 + 行批次引用）。
--
-- 依据：
--   packages/contracts/src/internal-trade-orders.ts
--   《接口契约第二批》§1 / §3，D15 / D16 / D21 / D22 / D51 / D54 / D68。
--
-- 口径：
--   * D15：三张表均带 tenant_id + company_id，并 ENABLE/FORCE RLS；
--   * D16：单号由服务端取号，格式 `N-<公司码4>-<日期8>-<流水4>`，租户内唯一；
--   * D21：取消只置状态、不物理删除；有库存流水等直接下游时由应用层拦截；
--   * D22：明细行只引用发出公司的批次，应用层校验归属与商品一致性；
--   * D54：数量与金额统一使用 numeric(18,6)（复用 0001 的 amount domain）；
--   * D68：状态使用独立四态；内部价只保存制单人手填值，不自动计算。
--
-- company_id 固定表示发出公司，便于沿用模块内的公司隔离与 RLS 模式；
-- 接收方可见性由查询同时检查 from_company_id / to_company_id。
--
-- 历史迁移（0001-0014）一律不改：本文件是纯前向追加，回滚靠后续迁移。

CREATE TABLE internal_trade_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  from_company_id uuid NOT NULL REFERENCES company (id),
  to_company_id uuid NOT NULL REFERENCES company (id),
  order_no text NOT NULL CHECK (length(btrim(order_no)) > 0),
  handler_id uuid NOT NULL REFERENCES employee (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT '进行中'
    CHECK (status IN ('进行中', '在途', '已完成', '已取消')),
  internal_price amount NOT NULL CHECK (internal_price >= 0),
  in_transit_qty amount NOT NULL DEFAULT 0 CHECK (in_transit_qty >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT internal_trade_order_tenant_order_no_key UNIQUE (tenant_id, order_no),
  CONSTRAINT internal_trade_order_company_matches_from
    CHECK (company_id = from_company_id),
  CONSTRAINT internal_trade_order_distinct_companies
    CHECK (from_company_id <> to_company_id)
);

CREATE INDEX internal_trade_order_tenant_from_company_idx
  ON internal_trade_order (tenant_id, from_company_id);
CREATE INDEX internal_trade_order_tenant_to_company_idx
  ON internal_trade_order (tenant_id, to_company_id);
CREATE INDEX internal_trade_order_tenant_status_idx
  ON internal_trade_order (tenant_id, status);

CREATE TABLE internal_trade_order_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_id uuid NOT NULL REFERENCES internal_trade_order (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  product_id uuid NOT NULL REFERENCES product (id) ON DELETE RESTRICT,
  qty amount NOT NULL CHECK (qty >= 0),
  unit_price amount NOT NULL CHECK (unit_price >= 0),
  amount amount NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT internal_trade_order_line_order_line_no_key UNIQUE (order_id, line_no)
);

CREATE INDEX internal_trade_order_line_tenant_order_idx
  ON internal_trade_order_line (tenant_id, order_id);

CREATE TABLE internal_trade_order_line_batch (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_id uuid NOT NULL REFERENCES internal_trade_order (id) ON DELETE RESTRICT,
  order_line_id uuid NOT NULL REFERENCES internal_trade_order_line (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  batch_id uuid NOT NULL REFERENCES inventory_batch (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT internal_trade_order_line_batch_line_no_key UNIQUE (order_line_id, line_no)
);

CREATE INDEX internal_trade_order_line_batch_tenant_order_idx
  ON internal_trade_order_line_batch (tenant_id, order_id);
CREATE INDEX internal_trade_order_line_batch_tenant_batch_idx
  ON internal_trade_order_line_batch (tenant_id, batch_id);

CREATE FUNCTION internal_trade_order_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER internal_trade_order_touch_updated_at
BEFORE UPDATE ON internal_trade_order
FOR EACH ROW
EXECUTE FUNCTION internal_trade_order_touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON internal_trade_order TO qingdan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON internal_trade_order_line TO qingdan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON internal_trade_order_line_batch TO qingdan_app;

ALTER TABLE internal_trade_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_trade_order FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON internal_trade_order;
CREATE POLICY tenant_isolation ON internal_trade_order
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE internal_trade_order_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_trade_order_line FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON internal_trade_order_line;
CREATE POLICY tenant_isolation ON internal_trade_order_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE internal_trade_order_line_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_trade_order_line_batch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON internal_trade_order_line_batch;
CREATE POLICY tenant_isolation ON internal_trade_order_line_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
