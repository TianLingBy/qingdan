-- 20261118060000_masterdata_contacts.sql
-- #306 客户 / 供应商 / 加工厂多对接人 + 单据对接人引用（D92 末尾补句）。
--
-- 用途：
--   1) 三张同构的对接人子表 customer_contact / supplier_contact / processor_contact；
--   2) sales_order.customer_contact_id / purchase_order.supplier_contact_id /
--      processing_order.processor_contact_id 三个可空引用（记「这次是谁来下单」）；
--   3) 把存量档案的 contact_name / contact_phone 回填成 is_primary 的对接人。
--
-- 口径：
--   * 对接人是档案从属数据，不单独立域（D92 补句）：权限沿用 customer / supplier /
--     processor 三个域既有的 read / create / update / delete，不新增动作、不新增域；
--   * phone 校验与 0001 的 employee.phone 同口径 `^1[0-9]{10}$`，可空 —— 加工厂档案
--     本来就没有 contact_phone 列（0007），回填出来的加工厂对接人 phone 为 NULL；
--   * 每档案最多一个主对接人：部分唯一索引 `(tenant_id, company_id, <实体>_id)
--     WHERE is_primary`；撞索引 → 接口层翻成 409 STATE_CONFLICT；
--   * 单据引用 ON DELETE RESTRICT；接口层的「删除对接人」是软停用（status = '停用'），
--     不是物理删，历史单仍能读到引用与姓名；
--   * D103：PostgreSQL **不会**为外键自动建索引。三个引用列既要被 ON DELETE RESTRICT
--     检查、又要被单据列表 join，所以各自补 (tenant_id, company_id, <contact_id>) 索引；
--   * 迁移执行角色必须是 superuser 或带 BYPASSRLS 的平台角色（0002 顶部约定），
--     因此本条里的回填 SELECT 能读到已 FORCE RLS 的 customer / supplier / processor；
--   * 老字段 contact_name / contact_phone 保留不删，由写接口在主对接人变更时同步维护，
--     兼容旧读端；
--   * 回填幂等：`ON CONFLICT DO NOTHING` + (company_id, <实体>_id, name) 唯一约束，
--     重复执行不会多出对接人。
--
-- 历史迁移一律不改：本文件是纯前向追加，回滚靠后续迁移。

-- ---------------------------------------------------------------------------
-- 1. 对接人子表（三张同构）
-- ---------------------------------------------------------------------------

CREATE TABLE customer_contact (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  -- 归属档案；档案被引用后禁止物理删除（与单据引用同一口径）。
  customer_id uuid NOT NULL REFERENCES customer (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- 与 0001 employee.phone 同口径；对接人电话可空（还没问到号码也要能建档）。
  phone text CHECK (phone IS NULL OR phone ~ '^1[0-9]{10}$'),
  -- 职务 / 称呼（「采购主管」「老板娘」这类自由文本）。
  title text,
  is_primary boolean NOT NULL DEFAULT false,
  -- 停用 = 软删除：不再出现在开单选择里，但历史单仍可读。
  status text NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_contact_company_customer_name_key
    UNIQUE (company_id, customer_id, name)
);

CREATE INDEX customer_contact_tenant_customer_idx
  ON customer_contact (tenant_id, company_id, customer_id);

-- 每档案最多一个主对接人。停用的主对接人仍占位：先停用再建新的，需先把旧的
-- is_primary 置 false（接口层在新建/提升主对接人时自动做这一步）。
CREATE UNIQUE INDEX customer_contact_primary_key
  ON customer_contact (tenant_id, company_id, customer_id)
  WHERE is_primary;

CREATE TABLE supplier_contact (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  supplier_id uuid NOT NULL REFERENCES supplier (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  phone text CHECK (phone IS NULL OR phone ~ '^1[0-9]{10}$'),
  title text,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_contact_company_supplier_name_key
    UNIQUE (company_id, supplier_id, name)
);

CREATE INDEX supplier_contact_tenant_supplier_idx
  ON supplier_contact (tenant_id, company_id, supplier_id);

CREATE UNIQUE INDEX supplier_contact_primary_key
  ON supplier_contact (tenant_id, company_id, supplier_id)
  WHERE is_primary;

CREATE TABLE processor_contact (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  processor_id uuid NOT NULL REFERENCES processor (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  phone text CHECK (phone IS NULL OR phone ~ '^1[0-9]{10}$'),
  title text,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processor_contact_company_processor_name_key
    UNIQUE (company_id, processor_id, name)
);

CREATE INDEX processor_contact_tenant_processor_idx
  ON processor_contact (tenant_id, company_id, processor_id);

CREATE UNIQUE INDEX processor_contact_primary_key
  ON processor_contact (tenant_id, company_id, processor_id)
  WHERE is_primary;

-- ---------------------------------------------------------------------------
-- 2. updated_at 自动维护（三张表共用一个函数，与 0005 同款写法）
-- ---------------------------------------------------------------------------

CREATE FUNCTION masterdata_contact_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_contact_touch_updated_at
BEFORE UPDATE ON customer_contact
FOR EACH ROW
EXECUTE FUNCTION masterdata_contact_touch_updated_at();

CREATE TRIGGER supplier_contact_touch_updated_at
BEFORE UPDATE ON supplier_contact
FOR EACH ROW
EXECUTE FUNCTION masterdata_contact_touch_updated_at();

CREATE TRIGGER processor_contact_touch_updated_at
BEFORE UPDATE ON processor_contact
FOR EACH ROW
EXECUTE FUNCTION masterdata_contact_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. 存量回填：老的单组 contact_name / contact_phone 变成主对接人
--    contact_name 为 NULL 或空白的不建对接人（不造名字为空的记录）；
--    幂等：ON CONFLICT DO NOTHING（唯一键 = company_id + <实体>_id + name）。
-- ---------------------------------------------------------------------------

INSERT INTO customer_contact
  (id, tenant_id, company_id, customer_id, name, phone, is_primary, status)
SELECT gen_random_uuid(),
       c.tenant_id,
       c.company_id,
       c.id,
       btrim(c.contact_name),
       nullif(btrim(c.contact_phone), ''),
       true,
       '启用'
  FROM customer c
 WHERE c.contact_name IS NOT NULL
   AND btrim(c.contact_name) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO supplier_contact
  (id, tenant_id, company_id, supplier_id, name, phone, is_primary, status)
SELECT gen_random_uuid(),
       s.tenant_id,
       s.company_id,
       s.id,
       btrim(s.contact_name),
       nullif(btrim(s.contact_phone), ''),
       true,
       '启用'
  FROM supplier s
 WHERE s.contact_name IS NOT NULL
   AND btrim(s.contact_name) <> ''
ON CONFLICT DO NOTHING;

-- 加工厂档案只有 contact_name，没有 contact_phone（0007），回填出来的对接人 phone 为 NULL。
INSERT INTO processor_contact
  (id, tenant_id, company_id, processor_id, name, phone, is_primary, status)
SELECT gen_random_uuid(),
       p.tenant_id,
       p.company_id,
       p.id,
       btrim(p.contact_name),
       NULL::text,
       true,
       '启用'
  FROM processor p
 WHERE p.contact_name IS NOT NULL
   AND btrim(p.contact_name) <> ''
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. 单据加对接人引用（可空 = 老单没有对接人）
--    D103：外键不会自动建索引，三列各自显式补 (tenant_id, company_id, <contact_id>)。
-- ---------------------------------------------------------------------------

ALTER TABLE sales_order
  ADD COLUMN customer_contact_id uuid REFERENCES customer_contact (id) ON DELETE RESTRICT;
CREATE INDEX sales_order_tenant_company_contact_idx
  ON sales_order (tenant_id, company_id, customer_contact_id);

ALTER TABLE purchase_order
  ADD COLUMN supplier_contact_id uuid REFERENCES supplier_contact (id) ON DELETE RESTRICT;
CREATE INDEX purchase_order_tenant_company_contact_idx
  ON purchase_order (tenant_id, company_id, supplier_contact_id);

ALTER TABLE processing_order
  ADD COLUMN processor_contact_id uuid REFERENCES processor_contact (id) ON DELETE RESTRICT;
CREATE INDEX processing_order_tenant_company_contact_idx
  ON processing_order (tenant_id, company_id, processor_contact_id);

-- ---------------------------------------------------------------------------
-- 5. 应用角色授权 + RLS 兜底（模式与 0005 / 0006 / 0007 一致）
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON
  customer_contact,
  supplier_contact,
  processor_contact
TO qingdan_app;

ALTER TABLE customer_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_contact FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customer_contact;
CREATE POLICY tenant_isolation ON customer_contact
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE supplier_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_contact FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier_contact;
CREATE POLICY tenant_isolation ON supplier_contact
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE processor_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE processor_contact FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON processor_contact;
CREATE POLICY tenant_isolation ON processor_contact
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
