-- 0014_sales_receipts_returns.sql
-- E 单收款记录 + R 客户退货（单头 + 商品明细 + 明细批次关联）。
--
-- 依据：
--   packages/contracts/src/sales-receipts.ts
--   packages/contracts/src/customer-returns.ts
--   D15 / D16 / D22 / D24 / D34 / D40 / D47 / D51 / D54。
--
-- 口径：
--   * D15：四张表均带 tenant_id + company_id，并启用 FORCE RLS；
--   * D16：R 单号由服务端生成，格式 `R-<公司码4>-<日期8>-<流水4>`，租户内唯一；
--   * D24 / D34：收款与退款共用 sales_receipt；退款只追加负数行，余额由 SQL SUM 聚合；
--   * D40：仅退款可有商品明细或为空；退款不得写成 E 单费用行；
--   * D47：R 单只追加，不物理删除；应用角色只授 SELECT / INSERT；
--   * D54：数量与金额沿用 amount 域 numeric(18,6)，明细金额由 SQL 计算。
--
-- 历史迁移（0001-0013）一律不改：本文件是纯前向追加。

-- ---------------------------------------------------------------------------
-- 1. R 客户退货单头
-- ---------------------------------------------------------------------------

CREATE TABLE customer_return (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  return_no text NOT NULL CHECK (length(btrim(return_no)) > 0),
  original_sales_order_id uuid NOT NULL
    REFERENCES sales_order (id) ON DELETE RESTRICT,
  -- settlement 模块尚未落表，暂不建外键；有值时由后续结算模块接管完整性。
  original_settlement_order_id uuid,
  return_type text NOT NULL CHECK (return_type IN ('退货退款', '仅退款')),
  only_refund_kind text CHECK (only_refund_kind IN ('纠收款', '减成交额')),
  refund_mode text NOT NULL CHECK (refund_mode IN ('原路退款', '冲抵应收')),
  status text NOT NULL DEFAULT '进行中'
    CHECK (status IN ('进行中', '已完成', '已取消')),
  -- 应退金额为正数；实际退款由 sales_receipt 的负数行表达（D40）。
  refund_amount amount NOT NULL CHECK (refund_amount > 0),
  remark text CHECK (remark IS NULL OR length(remark) <= 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_return_tenant_return_no_key UNIQUE (tenant_id, return_no),
  CONSTRAINT customer_return_refund_kind_pair_check CHECK (
    (return_type = '仅退款' AND only_refund_kind IN ('纠收款', '减成交额'))
    OR (return_type = '退货退款' AND only_refund_kind IS NULL)
  )
);

CREATE INDEX customer_return_tenant_company_order_idx
  ON customer_return (tenant_id, company_id, original_sales_order_id);
CREATE INDEX customer_return_tenant_company_status_idx
  ON customer_return (tenant_id, company_id, status);

-- ---------------------------------------------------------------------------
-- 2. R 单商品明细
-- ---------------------------------------------------------------------------

CREATE TABLE customer_return_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  return_id uuid NOT NULL REFERENCES customer_return (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  product_id uuid NOT NULL REFERENCES product (id) ON DELETE RESTRICT,
  qty amount NOT NULL CHECK (qty >= 0),
  unit_price amount NOT NULL CHECK (unit_price >= 0),
  -- 服务端以 qty × unit_price 计算，不信任客户端传入的 amount。
  amount amount NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_return_line_return_line_no_key UNIQUE (return_id, line_no)
);

CREATE INDEX customer_return_line_tenant_return_idx
  ON customer_return_line (tenant_id, return_id);

-- ---------------------------------------------------------------------------
-- 3. R 单明细引用的批次（一行可引多个本公司批次，D22）
-- ---------------------------------------------------------------------------

CREATE TABLE customer_return_line_batch (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  return_id uuid NOT NULL REFERENCES customer_return (id) ON DELETE RESTRICT,
  return_line_id uuid NOT NULL
    REFERENCES customer_return_line (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  batch_id uuid NOT NULL REFERENCES inventory_batch (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_return_line_batch_line_no_key UNIQUE (return_line_id, line_no)
);

CREATE INDEX customer_return_line_batch_tenant_return_idx
  ON customer_return_line_batch (tenant_id, return_id);
CREATE INDEX customer_return_line_batch_tenant_batch_idx
  ON customer_return_line_batch (tenant_id, batch_id);

-- ---------------------------------------------------------------------------
-- 4. E 单收款记录（收款 / 退款同一块，退款为负数行）
-- ---------------------------------------------------------------------------

CREATE TABLE sales_receipt (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  sales_order_id uuid NOT NULL REFERENCES sales_order (id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('收款', '退款')),
  amount amount NOT NULL CHECK (amount <> 0),
  method text NOT NULL
    CHECK (method IN ('在线支付回调', '线下转账', '原路退款', '冲抵应收')),
  occurred_at timestamptz NOT NULL,
  -- 契约 §11-2 尚未拍板是否强制关联 R 单，因此保留选填且暂不建外键。
  reversal_doc_id uuid,
  remark text CHECK (remark IS NULL OR length(remark) <= 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_receipt_direction_amount_check CHECK (
    (direction = '收款' AND amount > 0)
    OR (direction = '退款' AND amount < 0)
  )
);

CREATE INDEX sales_receipt_tenant_company_order_idx
  ON sales_receipt (tenant_id, company_id, sales_order_id);
CREATE INDEX sales_receipt_tenant_order_time_idx
  ON sales_receipt (tenant_id, sales_order_id, occurred_at, id);

-- ---------------------------------------------------------------------------
-- 5. 应用角色授权 + RLS 兜底（D15 / D47 / D55）
-- ---------------------------------------------------------------------------

-- R 单与收款记录均只追加；错账靠后续负数/冲正记录，不允许改删历史行。
GRANT SELECT, INSERT ON customer_return TO qingdan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON customer_return FROM qingdan_app;

GRANT SELECT, INSERT ON customer_return_line TO qingdan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON customer_return_line FROM qingdan_app;

GRANT SELECT, INSERT ON customer_return_line_batch TO qingdan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON customer_return_line_batch FROM qingdan_app;

GRANT SELECT, INSERT ON sales_receipt TO qingdan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sales_receipt FROM qingdan_app;

ALTER TABLE customer_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_return FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customer_return;
CREATE POLICY tenant_isolation ON customer_return
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE customer_return_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_return_line FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customer_return_line;
CREATE POLICY tenant_isolation ON customer_return_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE customer_return_line_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_return_line_batch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customer_return_line_batch;
CREATE POLICY tenant_isolation ON customer_return_line_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE sales_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_receipt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sales_receipt;
CREATE POLICY tenant_isolation ON sales_receipt
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
