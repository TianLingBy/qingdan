-- 0019_payment_transactions.sql
-- 在线支付回调入账（#101，商户模式 A：客户扫码 + 到账回调）。
--
-- 依据：
--   packages/contracts/src/payments.ts
--   D15 / D51 / D54。
--
-- 口径：
--   * 回调可能重复投递：`(company_id, channel, out_trade_no)` 唯一键就是幂等闸门；
--     repo 用 INSERT ... ON CONFLICT DO NOTHING，冲突即视为重复回调，不重复入账。
--   * 同一商户单号在不同支付渠道下互不冲突（channel 参与唯一键）。
--   * transaction_id 为第三方交易号，回调早期可能尚未携带 → 允许 NULL。
--   * receipt_id 指向本次回调生成的收款单；先插入交易行、后回填，允许 NULL。
--   * D54：金额使用 amount 域 numeric(18,6)。
--   * D15：tenant_id + company_id 行级隔离，并 ENABLE / FORCE RLS。
--   * 回调记录是入账凭据，只追加 / 回填，不物理删除；
--     应用角色只授 SELECT / INSERT / UPDATE，不授 DELETE。
--
-- 历史迁移（0001-0018）一律不改：本文件是纯前向追加。

CREATE TABLE payment_transaction (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  channel text NOT NULL CHECK (channel IN ('wechat', 'alipay')),
  out_trade_no text NOT NULL CHECK (length(btrim(out_trade_no)) > 0),
  transaction_id text,
  amount amount NOT NULL,
  status text NOT NULL CHECK (length(btrim(status)) > 0),
  receipt_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 幂等闸门：同一公司 + 渠道 + 商户订单号只允许一行。
  CONSTRAINT payment_transaction_company_channel_out_trade_no_key
    UNIQUE (company_id, channel, out_trade_no)
);

CREATE INDEX payment_transaction_tenant_company_id_idx
  ON payment_transaction (tenant_id, company_id, id DESC);

CREATE FUNCTION payment_transaction_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_transaction_touch_updated_at
BEFORE UPDATE ON payment_transaction
FOR EACH ROW
EXECUTE FUNCTION payment_transaction_touch_updated_at();

-- 回调记录不物理删除；UPDATE 仅用于回填 receipt_id。
GRANT SELECT, INSERT, UPDATE ON payment_transaction TO qingdan_app;
REVOKE DELETE, TRUNCATE ON payment_transaction FROM qingdan_app;

ALTER TABLE payment_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transaction FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment_transaction;
CREATE POLICY tenant_isolation ON payment_transaction
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
