-- 20261118010000_payment_requests.sql
-- 在线支付「发起侧」（#101）：客户扫码收款 → 待支付单 → 到账后由回调 / mock 确认入账。
--
-- 依据：
--   packages/contracts/src/payments.ts（PaymentRequestSchema / payment.request.* 路由）
--   apps/api/migrations/0019_payment_transactions.sql（入账凭据）
--   apps/api/migrations/0014_sales_receipts_returns.sql（收款只追加行）
--   D15 / D51 / D54 / D101。
--
-- 口径：
--   * 本表是**发起侧**的意图记录：客户点了「收款」才有一行，表示「这张单等着收这么多钱」；
--     真正的入账凭据仍是 `payment_transaction` + `sales_receipt`（D34 只追加），本表只回填指针。
--   * `provider_order_no` 是给支付平台看的商户订单号（微信 `out_trade_no`），
--     也是回调幂等的键：`(tenant_id, provider_order_no)` 唯一。
--   * `amount` 用 numeric(14,2)：线上支付以「分」为最小单位，不是 D54 的 numeric(18,6)；
--     应收余额只要有 3 位以上小数就不可能被一次线上支付收平，此时会在金额校验处被拒（见 callback）。
--   * 不建 `version` 列：本表没有人工编辑路径，状态只由「回调 / mock 确认」单向推进，
--     也不需要 If-Match（客户扫码不携带本系统版本号）。
--   * 授权含 UPDATE 是有意的：入账后要回填 status / paid_at / transaction_id；
--     行本身不删也不改金额 —— 由 repo 层只发这三列的 UPDATE 来保证，DB 层不拦
--     （加触发器去禁改金额只会让「回填」这条唯一正路也变复杂，收益抵不过维护成本）。
--
-- 历史迁移（0001-0019 等）一律不改：本文件是纯前向追加。

CREATE TABLE payment_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  sales_order_id uuid NOT NULL REFERENCES sales_order (id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('wechat', 'alipay')),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  -- 商户订单号：支付平台原样回传，因此同时是回调幂等键的一部分。
  provider_order_no text NOT NULL CHECK (length(btrim(provider_order_no)) > 0),
  qr_content text,
  -- mock 模式下是本地假支付页的相对路径（前端拼 origin）；live 模式是平台返回的收银台地址。
  pay_url text,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  transaction_id uuid REFERENCES payment_transaction (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_request_tenant_provider_order_no_key
    UNIQUE (tenant_id, provider_order_no),
  -- 已支付必须有支付时间与入账凭据；未支付不许先填这两列（半截状态比没有状态更难查）。
  CONSTRAINT payment_request_paid_check CHECK (
    (status = 'paid' AND paid_at IS NOT NULL AND transaction_id IS NOT NULL)
    OR (status <> 'paid' AND paid_at IS NULL AND transaction_id IS NULL)
  )
);

-- 对账 / 单据详情：按「哪张单发起过几次收款」倒序取。
CREATE INDEX payment_request_order_idx
  ON payment_request (tenant_id, sales_order_id, created_at DESC);

-- 「这张单有没有还没过期的待支付单」只看 pending，部分索引把已支付的排除在扫描之外。
CREATE INDEX payment_request_pending_idx
  ON payment_request (tenant_id, status, expires_at)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON payment_request TO qingdan_app;
REVOKE DELETE, TRUNCATE ON payment_request FROM qingdan_app;

ALTER TABLE payment_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_request FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment_request;
CREATE POLICY tenant_isolation ON payment_request
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
