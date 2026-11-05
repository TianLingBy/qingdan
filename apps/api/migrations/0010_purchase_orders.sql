-- 0010_purchase_orders.sql
-- 采购单 A（单头 + 商品明细 + 费用明细）。
--
-- 依据：
--   packages/contracts/src/purchase-orders.ts（PurchaseOrder / PurchaseOrderLine /
--   PurchaseOrderFee）、《接口契约第一批》§3.1 / §5.1 / §5.2 / §10。
--
-- 口径：
--   * D5：A 单只落成本明细；入库时按「(货款+运费+杂费) ÷ 入库数量」生成批次并锁价，
--     本批不实现入库，故这里不建批次关联列；
--   * D15：tenant_id + company_id 行级隔离，RLS 沿用 0001 的 `app.tenant_id` 模式；
--   * D16：单号由服务端取号，格式 `A-<公司码4>-<日期8>-<流水4>`，租户内唯一；
--   * D21：取消不物理删除，只置状态；有下游（库存流水）时不可取消；
--   * D39：费用金额允许为负（供应商返利 / 对方承担运费 / 退运费冲减）；
--     负数必须备注，由契约 schema 与 CHECK 双重兜底；
--   * D47：单据与明细不做物理删除，错账走冲正单据；
--   * D54：金额与数量一律 numeric(18,6)（复用 0001 的 `amount` domain），
--     不用浮点；明细金额 `amount = qty × unit_price` 由 SQL 计算后落库；
--   * 三条表全部 ENABLE/FORCE RLS，应用角色只在租户上下文内可见。
--
-- 历史迁移（0001-0009）一律不改：本文件是纯前向追加，回滚靠后续迁移。

-- ---------------------------------------------------------------------------
-- 1. 采购单单头
-- ---------------------------------------------------------------------------

CREATE TABLE purchase_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 公司隔离（D15）：采购单归属单一公司，跨公司不可见。
  company_id uuid NOT NULL REFERENCES company (id),
  -- 单号（D16）：服务端取号，租户内唯一。
  order_no text NOT NULL CHECK (length(btrim(order_no)) > 0),
  -- 供应商（D15）：必须与单头同公司；被引用后禁止物理删除。
  supplier_id uuid NOT NULL REFERENCES supplier (id) ON DELETE RESTRICT,
  -- 经手人。
  handler_id uuid NOT NULL REFERENCES employee (id) ON DELETE RESTRICT,
  -- 状态复用单据框架三态（§10，D54 §9-6 保留中文原值）。
  status text NOT NULL DEFAULT '进行中'
    CHECK (status IN ('进行中', '已完成', '已取消')),
  -- 货款 = 商品明细金额合计（非负，SQL 聚合维护）。
  goods_amount amount NOT NULL DEFAULT 0 CHECK (goods_amount >= 0),
  -- 费用合计：可为负（D39）。
  fee_amount amount NOT NULL DEFAULT 0,
  -- 单据总金额 = 货款 + 费用合计（D5 成本分子）。
  total_amount amount NOT NULL DEFAULT 0,
  -- 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_tenant_order_no_key UNIQUE (tenant_id, order_no)
);

-- 列表 / 详情按「租户 + 公司 + 供应商 / 状态」定位。
CREATE INDEX purchase_order_tenant_company_supplier_idx
  ON purchase_order (tenant_id, company_id, supplier_id);
CREATE INDEX purchase_order_tenant_company_status_idx
  ON purchase_order (tenant_id, company_id, status);

-- ---------------------------------------------------------------------------
-- 2. 商品明细（A 单不引用批次；入库时才生成批次，D5）
-- ---------------------------------------------------------------------------

CREATE TABLE purchase_order_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_id uuid NOT NULL REFERENCES purchase_order (id) ON DELETE RESTRICT,
  -- 行号：保持请求里的顺序，详情按此行稳定回放。
  line_no integer NOT NULL CHECK (line_no >= 1),
  product_id uuid NOT NULL REFERENCES product (id) ON DELETE RESTRICT,
  qty amount NOT NULL CHECK (qty >= 0),
  unit_price amount NOT NULL CHECK (unit_price >= 0),
  -- 金额由服务端按 qty × unit_price 计算（D54），不接受客户端浮点。
  amount amount NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_line_order_line_no_key UNIQUE (order_id, line_no)
);

CREATE INDEX purchase_order_line_tenant_order_idx
  ON purchase_order_line (tenant_id, order_id);

-- ---------------------------------------------------------------------------
-- 3. 费用明细（D39：金额可负，负数必须备注）
-- ---------------------------------------------------------------------------

CREATE TABLE purchase_order_fee (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_id uuid NOT NULL REFERENCES purchase_order (id) ON DELETE RESTRICT,
  line_no integer NOT NULL CHECK (line_no >= 1),
  fee_name text NOT NULL CHECK (length(btrim(fee_name)) > 0),
  qty amount NOT NULL CHECK (qty >= 0),
  unit_price amount NOT NULL CHECK (unit_price >= 0),
  -- 运费 / 杂费 / 加工费，可为负（供应商返利、对方承担运费、退运费冲减）。
  amount amount NOT NULL,
  -- D39：负数费用必须备注，数据库层兜底（契约 schema 已用 refine 先拦）。
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_fee_order_line_no_key UNIQUE (order_id, line_no),
  CONSTRAINT purchase_order_fee_negative_requires_remark
    CHECK (amount >= 0 OR (remark IS NOT NULL AND length(btrim(remark)) > 0))
);

CREATE INDEX purchase_order_fee_tenant_order_idx
  ON purchase_order_fee (tenant_id, order_id);

-- ---------------------------------------------------------------------------
-- 4. updated_at 自动维护（与 0004-0009 同款；明细只随单头整体替换，不建触发器）
-- ---------------------------------------------------------------------------

CREATE FUNCTION purchase_order_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_order_touch_updated_at
BEFORE UPDATE ON purchase_order
FOR EACH ROW
EXECUTE FUNCTION purchase_order_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. 应用角色授权 + RLS 兜底（D15 / D55①）
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order TO qingdan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_line TO qingdan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_fee TO qingdan_app;

ALTER TABLE purchase_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON purchase_order;
CREATE POLICY tenant_isolation ON purchase_order
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE purchase_order_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_line FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON purchase_order_line;
CREATE POLICY tenant_isolation ON purchase_order_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE purchase_order_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_fee FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON purchase_order_fee;
CREATE POLICY tenant_isolation ON purchase_order_fee
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
