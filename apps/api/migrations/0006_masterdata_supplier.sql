-- 0006_masterdata_supplier.sql
-- masterdata 供应商表（D15 / D49 / D51 / D52① / D54）。
--
-- 用途：
--   供应商资料模块的第一张业务表，字段与 packages/contracts/src/suppliers.ts 的
--   SupplierSchema 一一对应（id / tenant_id / company_id / supplier_no / name /
--   contact_name / contact_phone / supplied_materials / status / version /
--   created_at / updated_at）。
--
-- 口径：
--   * D49：supplier_no 是自由文本、可空、不唯一，**不建唯一索引、不建编号检索索引**；
--     供应商定位用 uuid / 名称 / 联系人；
--   * D15：tenant_id + company_id 行级隔离，RLS 沿用 0001 的 `app.tenant_id` 模式；
--   * supplied_materials：text[] 非空、默认空数组；最多 20 项、每项 1-64 字**由应用层
--     契约校验**（本表只兜 NOT NULL / 默认值，不重复实现长度规则）；
--   * 供应商**没有金额字段**（货款、返利在单据与结算上）。
--
-- 历史迁移（0001 / 0002 / 0003 / 0004 / 0005）一律不改：本文件是纯前向追加，回滚靠后续迁移。

-- ---------------------------------------------------------------------------
-- 1. 供应商表
-- ---------------------------------------------------------------------------

CREATE TABLE supplier (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 公司隔离（D15）：供应商归属单一公司，不允许跨公司可见。
  company_id uuid NOT NULL REFERENCES company (id),
  -- 编号（D49）：自由文本、可空，不做唯一校验，也不建检索索引。
  supplier_no text,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  contact_name text,
  contact_phone text,
  -- 供货物料：自由文本清单；上限与长度由契约 / 应用层校验（见文件头口径）。
  supplied_materials text[] NOT NULL DEFAULT '{}',
  -- 状态保留中文原值（D54 §9-6）；停用供应商不进单据选供应商弹窗。
  status text NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  -- 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 业务查询只需按「租户 + 公司 + 名称」定位；不按 supplier_no 建索引（D49）。
CREATE INDEX supplier_tenant_company_name_idx ON supplier (tenant_id, company_id, name);

-- ---------------------------------------------------------------------------
-- 2. updated_at 自动维护（与 0005 同款）
-- ---------------------------------------------------------------------------

CREATE FUNCTION supplier_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_touch_updated_at
BEFORE UPDATE ON supplier
FOR EACH ROW
EXECUTE FUNCTION supplier_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. 应用角色授权 + RLS 兜底（D15 / D55①）
--    模式与 0001 的内核表 / 0004 的商品表 / 0005 的客户表一致：
--    FORCE RLS + tenant_isolation 策略，current_setting('app.tenant_id') 未设置时
--    比较为 NULL，fail-closed 返回 0 行。
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier TO qingdan_app;

ALTER TABLE supplier ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supplier;
CREATE POLICY tenant_isolation ON supplier
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
