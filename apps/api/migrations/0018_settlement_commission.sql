-- 0018_settlement_commission.sql
-- 提成比例配置 + C 单提成归属人（D5④ / D36 / D77）。
--
-- 依据：
--   packages/contracts/src/commission-rates.ts
--   packages/contracts/src/settlement-orders.ts
--   D5④ / D36 / D51 / D54 / D70 / D77
--
-- 口径：
--   * D77 ①：配置表归 settlement 域，一期**只支持按人**配置；按岗（D5④ 的另一半）
--     需 platform 岗位解析端口，未落地前不在本批猜实现。
--   * D77 ②：C 单新增 commission_owner_id（来源单负责人），由来源模块在生成草稿时传入；
--     settlement 不直读 E / N 表（D70 ②）。
--   * D77 ③：确认结算时按 owner 在**本公司** `effective_from <= 结算日` 的最新比例快照；
--     无配置比例记 0；commissionAmount = max(0, grossProfit) × rate（负毛利记 0，D5④）。
--   * D77 ④：已结算单靠 commission_rate_snapshot 冻结，改配置不影响历史单（D36）。
--   * D54：比例与金额统一 amount 域 numeric(18,6)；比例取值 [0, 1]。
--   * D51：配置写操作记审计（应用层）。
--   * D15：两张表都带 tenant_id + company_id 并 ENABLE / FORCE RLS。
--
-- 历史迁移（0001-0017）一律不改：本文件是纯前向追加。

CREATE TABLE commission_rate (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  employee_id uuid NOT NULL REFERENCES employee (id) ON DELETE RESTRICT,
  rate amount NOT NULL CHECK (rate >= 0 AND rate <= 1),
  effective_from date NOT NULL,
  created_by uuid NOT NULL REFERENCES employee (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 同一员工在同一公司同一生效日只允许一条配置（重复插入走 409，不静默覆盖）
  CONSTRAINT commission_rate_tenant_company_employee_effective_key
    UNIQUE (tenant_id, company_id, employee_id, effective_from)
);

CREATE INDEX commission_rate_tenant_company_employee_idx
  ON commission_rate (tenant_id, company_id, employee_id, effective_from DESC);

CREATE FUNCTION commission_rate_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER commission_rate_touch_updated_at
BEFORE UPDATE ON commission_rate
FOR EACH ROW
EXECUTE FUNCTION commission_rate_touch_updated_at();

-- 配置行可删（历史单据已靠 commission_rate_snapshot 冻结，D77 ④）。
GRANT SELECT, INSERT, UPDATE, DELETE ON commission_rate TO qingdan_app;

ALTER TABLE commission_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_rate FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commission_rate;
CREATE POLICY tenant_isolation ON commission_rate
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- C 单提成归属人：nullable，历史草稿（D72 落地时）没有该值，确认时比例为 0。
ALTER TABLE settlement_order
  ADD COLUMN commission_owner_id uuid REFERENCES employee (id) ON DELETE RESTRICT;

COMMENT ON COLUMN settlement_order.commission_owner_id IS
  '提成归属人（来源单负责人，D77 ②）；确认结算时据此解析比例并写入 commission_rate_snapshot';
