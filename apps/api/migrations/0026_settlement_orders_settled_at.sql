-- 0026_settlement_orders_settled_at.sql
-- 结算确认时间单独成列（优化任务书阶段二）。
--
-- 背景（要解决的问题）：
--   * 0016 的 settlement_order_touch_updated_at 触发器在**任何** UPDATE 时刷新 updated_at，
--     所以 updated_at ≠ 结算确认时间。利润报表按 updated_at 推断期间归属时，只要这张单
--     之后再被别的逻辑写一次（损耗重算、版本推进、运维订正），历史单据就会挪进另一个
--     报表期间，报表口径直接错账。
--   * 结算确认在本仓只有一条生产写入路径：apps/api/src/modules/settlement/repo.ts 的
--     confirmSettlementOrder（待确认 → 已结算，与快照同一条原子 UPDATE）；该用例必写一条
--     audit_log（action='settlement.order.confirm'，result='success'，occurred_at=确认时刻）。
--
-- 口径：
--   * settled_at 只在「确认结算」那一次写入，之后不再变；
--   * 「待确认」必须为 NULL；「已结算」必须有值（fail closed，不给历史数据留含糊态）；
--   * 历史回填只认 audit_log 的确认事件（确定性证据），**不用 updated_at 猜**。
--
-- 历史迁移 0001-0025 一律不改：本文件是纯前向追加。

ALTER TABLE settlement_order ADD COLUMN settled_at timestamptz;

-- 回填：一次确认 = 一行 success 审计；同一 object_id 取最早一条（正常唯一，重复只可能是重放）。
UPDATE settlement_order s
   SET settled_at = a.occurred_at
  FROM (
    SELECT object_id, min(occurred_at) AS occurred_at
      FROM audit_log
     WHERE action = 'settlement.order.confirm'
       AND result = 'success'
       AND object_id IS NOT NULL
     GROUP BY object_id
  ) a
 WHERE s.status = '已结算'
   AND s.settled_at IS NULL
   AND a.object_id = s.id::text;

-- 回填后仍有「已结算」缺值 = 存在没有审计证据的历史行（脏数据 / 手工改库）。
-- 这类行回填不出来，也不拿 updated_at 冒充（那正是本迁移要修的错口径）：
-- 直接失败并把待人工处理的清单给出来，由人工核对来源单据后补值或作废。
DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing
    FROM settlement_order
   WHERE status = '已结算' AND settled_at IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION
      'settled_at 回填失败：% 张「已结算」C 单在 audit_log 中没有 settlement.order.confirm 成功记录。'
      ' 待人工核对清单：SELECT id, order_no, created_at FROM settlement_order '
      'WHERE status = ''已结算'' AND settled_at IS NULL;'
      ' 处理方式只有两种：核出来源单据后手工补 settled_at，或确认该批数据可作废；'
      ' 禁止用 updated_at 回填。', missing;
  END IF;
END;
$$;

ALTER TABLE settlement_order
  ADD CONSTRAINT settlement_order_settled_at_check CHECK (
    (status = '待确认' AND settled_at IS NULL)
    OR
    (status = '已结算' AND settled_at IS NOT NULL)
  );

-- 期间聚合是 [start, end) 半开区间的范围扫描，只关心已结算行：
-- 部分索引比全表 (tenant_id, company_id, settled_at) 更小，命中范围扫描即可。
CREATE INDEX settlement_order_tenant_company_settled_at_idx
  ON settlement_order (tenant_id, company_id, settled_at)
  WHERE status = '已结算';
