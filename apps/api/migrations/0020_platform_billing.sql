-- 0020_platform_billing.sql
-- 公司级订阅计费字段（一期只读端点 + 平台端口）。
--
-- 契约 CompanySubscriptionSchema 以公司为粒度返回 plan / expiresAt / status：
--   * plan      套餐名，值域未定（平台运营手动配置）→ text，不建枚举；
--   * expires_at 到期日；NULL = 永久（D1/D12：到期只提示续费，不中断功能）；
--   * status    复用 company.status（启用 / 停用）。
--
-- 纯前向追加：已有公司回填默认套餐「基础版」，到期日为 NULL（永久）。

ALTER TABLE company
  ADD COLUMN plan text NOT NULL DEFAULT '基础版',
  ADD COLUMN expires_at date;
