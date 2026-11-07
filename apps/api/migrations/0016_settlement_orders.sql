-- 0016_settlement_orders.sql
-- C 结算单。
--
-- 依据：
--   packages/contracts/src/settlement-orders.ts
--   D15 / D19 / D26 / D36 / D51 / D52 / D54 / D69。
--
-- 口径：
--   * D19：C 单只有「待确认 / 已结算」两态；一张来源 E/N 单只允许一张 C 单，
--     一期不支持部分结算或多次结算。草稿生成通道尚未接入，本表先完整承接契约字段。
--   * D26：净毛利 = 毛利 - 本单相关损失。相关损失在确认结算时复制到
--     related_loss_amount_snapshot；读取已结算单时优先使用该快照。
--   * D36：commission_rate_snapshot 是结算单自身的历史快照，不随后续配置变化。
--   * D69：确认结算后，后续损耗变动不得改变已结算单的 relatedLossAmount / netProfit；
--     本表用独立快照列冻结本单相关损失。
--   * D54：所有金额使用 amount 域 numeric(18,6)，接口读出时 trim_scale 为 decimal 字符串。
--   * D15：tenant_id + company_id 行级隔离，并 ENABLE / FORCE RLS。
--   * 结算后不可冲正或删除；应用角色只授 SELECT / INSERT / UPDATE，不授 DELETE。
--
-- TODO(D19)：E / N 单完成态自动生成 C 单草稿需由跨模块公开用例通道接入。
-- 当前没有该通道，本模块不直读 E / N 表，也不暴露 create 端点。
--
-- 历史迁移（0001-0015）一律不改：本文件是纯前向追加。

CREATE TABLE settlement_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  order_no text NOT NULL CHECK (length(btrim(order_no)) > 0),
  source_doc_type text NOT NULL CHECK (source_doc_type IN ('E', 'N')),
  source_doc_id uuid NOT NULL,
  status text NOT NULL DEFAULT '待确认'
    CHECK (status IN ('待确认', '已结算')),
  total_sale_amount amount NOT NULL CHECK (total_sale_amount >= 0),
  total_cost_amount amount NOT NULL CHECK (total_cost_amount >= 0),
  gross_profit amount NOT NULL,
  gross_margin_rate amount NOT NULL,
  related_loss_amount amount NOT NULL DEFAULT 0 CHECK (related_loss_amount >= 0),
  related_loss_amount_snapshot amount CHECK (
    related_loss_amount_snapshot IS NULL
    OR related_loss_amount_snapshot >= 0
  ),
  net_profit amount NOT NULL,
  commission_rate_snapshot amount NOT NULL CHECK (commission_rate_snapshot >= 0),
  commission_amount amount NOT NULL CHECK (commission_amount >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_order_tenant_order_no_key
    UNIQUE (tenant_id, order_no),
  CONSTRAINT settlement_order_source_key
    UNIQUE (tenant_id, source_doc_type, source_doc_id),
  CONSTRAINT settlement_order_gross_profit_formula_check
    CHECK (gross_profit = total_sale_amount - total_cost_amount),
  CONSTRAINT settlement_order_net_profit_formula_check
    CHECK (
      net_profit = gross_profit - COALESCE(
        related_loss_amount_snapshot,
        related_loss_amount
      )
    ),
  CONSTRAINT settlement_order_settled_snapshot_check
    CHECK (
      (status = '待确认' AND related_loss_amount_snapshot IS NULL)
      OR
      (status = '已结算' AND related_loss_amount_snapshot IS NOT NULL)
    )
);

CREATE INDEX settlement_order_tenant_company_id_idx
  ON settlement_order (tenant_id, company_id, id DESC);
CREATE INDEX settlement_order_tenant_company_status_idx
  ON settlement_order (tenant_id, company_id, status, id DESC);
CREATE INDEX settlement_order_tenant_company_source_type_idx
  ON settlement_order (tenant_id, company_id, source_doc_type, id DESC);
CREATE INDEX settlement_order_tenant_company_order_no_idx
  ON settlement_order (tenant_id, company_id, order_no);

CREATE FUNCTION settlement_order_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER settlement_order_touch_updated_at
BEFORE UPDATE ON settlement_order
FOR EACH ROW
EXECUTE FUNCTION settlement_order_touch_updated_at();

-- 结算后不可物理删除（D2③ / D19）；UPDATE 仅用于一次确认结算。
GRANT SELECT, INSERT, UPDATE ON settlement_order TO qingdan_app;
REVOKE DELETE, TRUNCATE ON settlement_order FROM qingdan_app;

ALTER TABLE settlement_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_order FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON settlement_order;
CREATE POLICY tenant_isolation ON settlement_order
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
