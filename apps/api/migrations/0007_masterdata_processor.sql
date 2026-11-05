-- 0007_masterdata_processor.sql
-- masterdata 加工厂 + 加工厂报价记录（D15 / D49 / D51 / D64 / D54）。
--
-- 用途：
--   加工厂资料模块的两张业务表，字段与 packages/contracts/src/processors.ts 的
--   ProcessorSchema / ProcessorQuoteSchema 一一对应。
--
-- 口径：
--   * D49：processor_no 是自由文本、可空、不唯一，**不建唯一索引、不建编号检索索引**；
--     加工厂定位用 uuid / 名称 / 联系人；
--   * D15：tenant_id + company_id 行级隔离，RLS 沿用 0001 的 `app.tenant_id` 模式；
--   * D64① / ④：加工厂主表**只存基础资料，不允许有价格列**；历史加工价 / 比价记录
--     全部落在独立子表 processor_quote，一次报价一行，只增不改；
--   * D64②：quote_date 为 date；unit_price 为 decimal 字符串，DB 用 numeric(18,6)；
--   * D64③：比价 = 按「工序 + 日期区间」跨加工厂查同一工序单价并排序，
--     子表索引按 (tenant_id, company_id, process_name, quote_date) 建。
--
-- 历史迁移（0001-0006）一律不改：本文件是纯前向追加，回滚靠后续迁移。

-- ---------------------------------------------------------------------------
-- 1. 加工厂主表（只存基础资料，D64① / ④）
-- ---------------------------------------------------------------------------

CREATE TABLE processor (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 公司隔离（D15）：加工厂归属单一公司，不允许跨公司可见。
  company_id uuid NOT NULL REFERENCES company (id),
  -- 编号（D49）：自由文本、可空，不做唯一校验，也不建检索索引。
  processor_no text,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  contact_name text,
  -- 状态保留中文原值（D54 §9-6）；停用加工厂不进单据选加工厂弹窗。
  status text NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  -- 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 业务查询只需按「租户 + 公司 + 名称」定位；不按 processor_no 建索引（D49）。
CREATE INDEX processor_tenant_company_name_idx ON processor (tenant_id, company_id, name);

-- ---------------------------------------------------------------------------
-- 2. 加工厂报价记录子表（D64② / ④：只增不改）
-- ---------------------------------------------------------------------------

CREATE TABLE processor_quote (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 公司隔离（D15）：报价记录跟随加工厂归属公司。
  company_id uuid NOT NULL REFERENCES company (id),
  -- 指向加工厂；加工厂被引用后禁止物理删除（停用走 status 软删除）。
  processor_id uuid NOT NULL REFERENCES processor (id) ON DELETE RESTRICT,
  -- 报价日期：只存日期，不带时区（D64②）。
  quote_date date NOT NULL,
  -- 工序名：自由文本，长度上限由契约 / 应用层校验（D64②：≤64）。
  process_name text NOT NULL CHECK (length(btrim(process_name)) > 0),
  -- 单价：decimal 字符串落 numeric(18,6)（D54）；契约层已拒绝负数与超精度。
  unit_price numeric(18, 6) NOT NULL CHECK (unit_price >= 0),
  -- 备注：需要留痕时写这里（D64③）；长度上限由契约层收口。
  remark text,
  -- 实体仍带版本以保持契约形状一致；业务上不存在 update / delete。
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 比价查询（D64③）：按租户 + 公司 + 工序 + 日期区间定位。
CREATE INDEX processor_quote_tenant_company_process_date_idx
  ON processor_quote (tenant_id, company_id, process_name, quote_date);

-- ---------------------------------------------------------------------------
-- 3. updated_at 自动维护（与 0005 / 0006 同款）
-- ---------------------------------------------------------------------------

CREATE FUNCTION processor_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER processor_touch_updated_at
BEFORE UPDATE ON processor
FOR EACH ROW
EXECUTE FUNCTION processor_touch_updated_at();

CREATE FUNCTION processor_quote_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER processor_quote_touch_updated_at
BEFORE UPDATE ON processor_quote
FOR EACH ROW
EXECUTE FUNCTION processor_quote_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. 应用角色授权 + RLS 兜底（D15 / D55①）
--    模式与 0001 的内核表 / 0004 的商品表 / 0005 的客户表 / 0006 的供应商表一致：
--    FORCE RLS + tenant_isolation 策略，current_setting('app.tenant_id') 未设置时
--    比较为 NULL，fail-closed 返回 0 行。
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON processor TO qingdan_app;

ALTER TABLE processor ENABLE ROW LEVEL SECURITY;
ALTER TABLE processor FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON processor;
CREATE POLICY tenant_isolation ON processor
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON processor_quote TO qingdan_app;

ALTER TABLE processor_quote ENABLE ROW LEVEL SECURITY;
ALTER TABLE processor_quote FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON processor_quote;
CREATE POLICY tenant_isolation ON processor_quote
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
