-- 0011_supplier_returns.sql
-- S 供应商退货（单头 + 商品明细 + 明细批次关联）。
--
-- 依据：
--   packages/contracts/src/supplier-returns.ts
--   F4c / D15 / D16 / D21 / D22 / D47 / D51 / D54。
--
-- 口径：
--   * F4c：供应商退货只做退钱；表结构不设退货类型、抵下次货款或换货字段；
--   * D15：三张表均带 tenant_id + company_id，并启用 FORCE RLS；
--   * D16：return_no 由服务端生成，格式 `S-<公司码4>-<日期8>-<流水4>`，租户内唯一；
--   * D22：明细引用的批次必须是本公司批次，且批次商品与明细商品一致；
--   * D47：S 单只追加，不物理删除；应用角色只授 SELECT / INSERT；
--   * D54：数量与金额沿用 amount 域 numeric(18,6)，明细金额与应退金额由 SQL 计算 / 聚合。
--
-- 历史迁移（0001-0010）一律不改：本文件是纯前向追加。

-- ---------------------------------------------------------------------------
-- 1. 供应商退货单头
-- ---------------------------------------------------------------------------

CREATE TABLE supplier_return (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  return_no text NOT NULL CHECK (length(btrim(return_no)) > 0),
  original_purchase_order_id uuid NOT NULL
    REFERENCES purchase_order (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT '进行中'
    CHECK (status IN ('进行中', '已完成', '已取消')),
  -- 应退金额 = 明细金额合计，由服务端 SQL 聚合，必须为正数（F4c）。
  refund_amount amount NOT NULL CHECK (refund_amount > 0),
  remark text CHECK (remark IS NULL OR length(remark) <= 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_return_tenant_return_no_key UNIQUE (tenant_id, return_no)
);

CREATE INDEX supplier_return_tenant_company_order_idx
  ON supplier_return (tenant_id, company_id, original_purchase_order_id);
CREATE INDEX supplier_return_tenant_company_status_idx
  ON supplier_return (tenant_id, company_id, status);

-- ---------------------------------------------------------------------------
-- 2. 商品明细
-- ---------------------------------------------------------------------------

CREATE TABLE supplier_return_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  return_id uuid NOT NULL REFERENCES supplier_return (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  product_id uuid NOT NULL REFERENCES product (id) ON DELETE RESTRICT,
  qty amount NOT NULL CHECK (qty >= 0),
  unit_price amount NOT NULL CHECK (unit_price >= 0),
  -- 服务端以 qty × unit_price 计算，不信任客户端传入的 amount。
  amount amount NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_return_line_return_line_no_key UNIQUE (return_id, line_no)
);

CREATE INDEX supplier_return_line_tenant_return_idx
  ON supplier_return_line (tenant_id, return_id);

-- ---------------------------------------------------------------------------
-- 3. 明细引用的批次（一行可引多个本公司批次，D22）
-- ---------------------------------------------------------------------------

CREATE TABLE supplier_return_line_batch (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  return_line_id uuid NOT NULL
    REFERENCES supplier_return_line (id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES inventory_batch (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (return_line_id, batch_id)
);

CREATE INDEX supplier_return_line_batch_tenant_company_batch_idx
  ON supplier_return_line_batch (tenant_id, company_id, batch_id);

-- ---------------------------------------------------------------------------
-- 4. 应用角色授权 + RLS 兜底（D15 / D47 / D55）
-- ---------------------------------------------------------------------------

-- S 单、明细与批次关联均只追加；错账走后续冲正单据，不允许改删历史行。
GRANT SELECT, INSERT ON supplier_return TO qingdan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON supplier_return FROM qingdan_app;

GRANT SELECT, INSERT ON supplier_return_line TO qingdan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON supplier_return_line FROM qingdan_app;

GRANT SELECT, INSERT ON supplier_return_line_batch TO qingdan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON supplier_return_line_batch FROM qingdan_app;

ALTER TABLE supplier_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_return FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_return;
CREATE POLICY tenant_isolation ON supplier_return
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE supplier_return_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_return_line FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_return_line;
CREATE POLICY tenant_isolation ON supplier_return_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE supplier_return_line_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_return_line_batch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_return_line_batch;
CREATE POLICY tenant_isolation ON supplier_return_line_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
