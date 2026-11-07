-- 0004_masterdata_product.sql
-- masterdata 商品表（D5 / D15 / D49 / D54）。
--
-- 用途：
--   商品资料模块的第一张业务表，字段与 packages/contracts/src/products.ts 的
--   ProductSchema 一一对应（id / tenant_id / company_id / product_no / name / aliases /
--   specification / unit / status / default_sale_price / version / created_at / updated_at）。
--
-- 口径：
--   * D49：product_no 是自由文本、可空、不唯一，**不建唯一索引、不建编号检索索引**；
--     商品定位用 uuid / 名称 / 别名（名称索引见下方 product_tenant_company_name_idx）；
--   * D15：tenant_id + company_id 行级隔离，RLS 沿用 0001 的 `app.tenant_id` 模式；
--   * D5：商品不挂成本字段——成本在批次上，本表出现成本列即违纪；
--   * D54：金额用 numeric(18,6)，这里直接复用 0001 的 `amount` domain。
--
-- 历史迁移（0001 / 0002 / 0003）一律不改：本文件是纯前向追加，回滚靠后续迁移。

-- ---------------------------------------------------------------------------
-- 1. 商品表
-- ---------------------------------------------------------------------------

CREATE TABLE product (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 公司隔离（D15）：商品归属单一公司，不允许跨公司可见。
  company_id uuid NOT NULL REFERENCES company (id),
  -- 编号（D49）：自由文本、可空，不做唯一校验，也不建检索索引。
  product_no text,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- 别名用于检索（D49），默认空数组。
  aliases text[] NOT NULL DEFAULT '{}',
  specification text,
  unit text NOT NULL CHECK (length(btrim(unit)) > 0),
  -- 状态保留中文原值（D54 §9-6）；停用商品不进单据选对象弹窗。
  status text NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  -- 默认售价（D54 numeric(18,6)，经 `amount` domain）；无成本字段（D5）。
  default_sale_price amount,
  -- 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 业务查询只需按「租户 + 公司 + 名称」定位；不按 product_no 建索引（D49）。
CREATE INDEX product_tenant_company_name_idx ON product (tenant_id, company_id, name);

-- ---------------------------------------------------------------------------
-- 2. updated_at 自动维护
--    迁移目录此前没有触发器；这里用最小标准写法补上本表的自动维护，
--    应用侧显式写 updated_at 也会被覆盖为 now()，避免时钟/路径不一致。
-- ---------------------------------------------------------------------------

CREATE FUNCTION product_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_touch_updated_at
BEFORE UPDATE ON product
FOR EACH ROW
EXECUTE FUNCTION product_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. 应用角色授权 + RLS 兜底（D15 / D55①）
--    模式与 0001 的内核表一致：FORCE RLS + tenant_isolation 策略，
--    current_setting('app.tenant_id') 未设置时比较为 NULL，fail-closed 返回 0 行。
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON product TO qingdan_app;

ALTER TABLE product ENABLE ROW LEVEL SECURITY;
ALTER TABLE product FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON product;
CREATE POLICY tenant_isolation ON product
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
