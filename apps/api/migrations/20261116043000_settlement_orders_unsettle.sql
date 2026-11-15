-- 20261116043000_settlement_orders_unsettle.sql
-- 结算单可撤销（D88 / #288）：撤销后回到「待确认」，清空结算期快照列。
--
-- 背景：
--   * 原始设计（D19）把 C 单做成「一期一单只能结算一次」，确认即不可逆（D2③）。
--     确认错了只能改报表外的人工台账，错数照样进期间利润（D43 按 settled_at 聚合）。
--   * #288 增加反向动作 `POST /api/v1/settlement-orders/{id}/unsettle`
--     （operationId `settlement.order.unsettle`），把整单退回「待确认」。
--
-- 口径（D88）：
--   * 撤销与确认同用 `settlement.approve` + `settlement.view_price`，AI 禁止且必须给原因；
--   * 撤销必须留原因，原因进审计；快照原值必须留在审计里（撤销不等于没发生过）；
--   * 撤销在**同一条 UPDATE** 里同时把 status 改回「待确认」、settled_at 置 NULL
--     （0026 的 CHECK 要求两列同时变），并清空 related_loss_amount / net_profit /
--     commission_rate_snapshot / commission_amount —— 这张单不再计入已结算期间聚合，
--     也不再计入提成；
--   * 清空后再次确认时，确认 SQL 按当时提成比例重新快照（D77 ③ 不变）。
--
-- 为什么 0016 的 NOT NULL 必须放开：
--   0016 把 related_loss_amount / net_profit / commission_rate_snapshot /
--   commission_amount 定义成 NOT NULL（草稿也有值）。「清空快照」要求这几列为 NULL，
--   0016 的 CHECK 对 NULL 是放行的（`NULL >= 0`、`NULL = ...` 都是 unknown，不算失败），
--   只差 NOT NULL 这一道。历史迁移 0001-0033 一律不改：本文件是纯前向追加。
--
-- 注意：`related_loss_amount_snapshot` 本来就是 nullable（0016），无需调整；
-- 0026 的 settled_at 双态 CHECK 不变，撤销靠同一条 UPDATE 同时改 status 与 settled_at。

ALTER TABLE settlement_order
  ALTER COLUMN related_loss_amount DROP NOT NULL,
  ALTER COLUMN net_profit DROP NOT NULL,
  ALTER COLUMN commission_rate_snapshot DROP NOT NULL,
  ALTER COLUMN commission_amount DROP NOT NULL;

COMMENT ON COLUMN settlement_order.related_loss_amount IS
  '本单相关损失（D35）；「已结算」时为确认时快照源的当前值，「待确认」且经撤销后为 NULL（D88）';
COMMENT ON COLUMN settlement_order.net_profit IS
  '净毛利 = 毛利 − 本单相关损失（D33）；经撤销后为 NULL，下次确认时重算（D88）';
COMMENT ON COLUMN settlement_order.commission_rate_snapshot IS
  '提成比例快照（D36）；撤销后为 NULL，下次确认时按当时配置重快照（D88）';
COMMENT ON COLUMN settlement_order.commission_amount IS
  '提成金额（D5④）；撤销后为 NULL，下次确认时重算（D88）';
