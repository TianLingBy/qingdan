-- 20261117181000_d94_transit_states.sql
-- D94：A/B/E 三类单据补「在途」中间态（第 1 块：只动表结构，不含用例与前端）。
--
-- 依据：docs/decisions.md D94（2026-11-17 负责人口径）。
--
-- 口径：
--   * 纯前向追加：只放宽 CHECK、只 ADD COLUMN，不改历史迁移、不删列、不改已有数据；
--   * 新列全部可空、无默认值、不 backfill：存量单据 / 批次保持原样，
--     「在途」是可选路径（D94 ⑤ 在途可跳过，进行中可直接完成）；
--   * 不碰 tenant_id 与 RLS —— 三张单据表与批次表的行级隔离已在建表迁移里，别在这里重复；
--   * 迁移 runner 对每个文件单独开事务（src/platform/db/migrate.ts），
--     本文件不写 BEGIN / COMMIT，避免嵌套事务。
--
-- 落地四处：
--   1. 三张单据的 status CHECK 放宽：A/B 增「在途」，E 增「已发货」；
--   2. purchase_order_line 加行级去向 transit_to / processor_id（D94 ①）；
--   3. processing_order 加单头在途 transit_stage / transit_to（D94 ②）；
--   4. inventory_batch 加 held_by_processor_id，记「直发加工厂的货压在谁那儿」（D94 ①）。

-- 1. 单据状态 CHECK 放宽。
--    建表时是列级匿名 CHECK，PG 自动命名为 <表>_<列>_check，
--    这里按同一名字 DROP 再 ADD，保证约束名不漂移。
ALTER TABLE sales_order DROP CONSTRAINT IF EXISTS sales_order_status_check;
ALTER TABLE sales_order ADD CONSTRAINT sales_order_status_check
  CHECK (status IN ('进行中', '已发货', '已完成', '已取消'));

ALTER TABLE purchase_order DROP CONSTRAINT IF EXISTS purchase_order_status_check;
ALTER TABLE purchase_order ADD CONSTRAINT purchase_order_status_check
  CHECK (status IN ('进行中', '在途', '已完成', '已取消'));

ALTER TABLE processing_order DROP CONSTRAINT IF EXISTS processing_order_status_check;
ALTER TABLE processing_order ADD CONSTRAINT processing_order_status_check
  CHECK (status IN ('进行中', '在途', '已完成', '已取消'));

-- 2. A 单按明细行记去向：回仓库（warehouse）或直发加工厂（processor，必须带 processor_id）。
--    两列都可空：老路径（不发货直接完成）的行保持 NULL，实现侧按「回仓库」处理。
ALTER TABLE purchase_order_line ADD COLUMN transit_to text;
ALTER TABLE purchase_order_line ADD COLUMN processor_id uuid REFERENCES processor (id);
ALTER TABLE purchase_order_line ADD CONSTRAINT purchase_order_line_transit_to_check
  CHECK (transit_to IS NULL OR transit_to IN ('warehouse', 'processor'));

-- 3. B 单按单头记在途：分两段（materials 料在去加工厂路上 / finished 成品在路上）+ 去向。
--    取值范围用 CHECK 兜底，避免实现侧写进别的字符串之后统计口径对不上。
ALTER TABLE processing_order ADD COLUMN transit_stage text;
ALTER TABLE processing_order ADD COLUMN transit_to text;
ALTER TABLE processing_order ADD CONSTRAINT processing_order_transit_stage_check
  CHECK (transit_stage IS NULL OR transit_stage IN ('materials', 'finished'));
ALTER TABLE processing_order ADD CONSTRAINT processing_order_transit_to_check
  CHECK (transit_to IS NULL OR transit_to IN ('warehouse', 'customer'));

-- 4. 批次记「货在加工厂」：直发加工厂产生的批次挂加工厂 id，库存页据此查「多少料压在外面」。
ALTER TABLE inventory_batch ADD COLUMN held_by_processor_id uuid REFERENCES processor (id);

-- 5. 权限回填：采购单 / 加工单的「完成」从 update 改成 approve（D94 ④，照 D86 的口径）。
--
--    为什么必须回填：改之前「能改单就能完成入库」，改之后要 `purchase.approve` /
--    `processing.approve`。若不补授，存量环境里所有岗位都会突然点不动「完成」按钮。
--
--    只给 owner / manager 两个默认岗位预设补（它们是预设，不是运行时角色判定），
--    自定义岗位保持未授予 —— 谁原来靠 update 完成单，需要管理员在权限页显式授 approve。
--    这样既不让升级后功能断掉，也不把审批权撒给所有人。
INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
SELECT p.tenant_id, p.id, d.domain, 'approve', true
FROM position p
CROSS JOIN (VALUES ('purchase'), ('processing')) AS d(domain)
WHERE p.preset_key IN ('owner', 'manager')
ON CONFLICT (position_id, domain, action) DO NOTHING;
