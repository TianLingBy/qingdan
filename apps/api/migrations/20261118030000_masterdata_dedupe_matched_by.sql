-- ---------------------------------------------------------------------------
-- 去重审核台：`masterdata_dedupe` 补 `matched_by` 独立列 + 审核台查询索引
-- （#302 块 C 后半段 / D102）。
--
-- 依据：审核台要按「命中依据」展示与筛选（name_only / name_phone / alias）。
-- 块 A 建表（20261117223000_masterdata_autocreate.sql）没有这一列，块 C 前半段只好
-- 把它编码进自由文本 `note`（`<matched_by>` 或 `<matched_by>|<人工备注>`，见 D100）。
-- 编码进自由文本的代价：
--   1. 想按命中依据筛选只能 `note LIKE 'name_phone%'`——前缀匹配走不了普通 btree 索引，
--      等于全表扫描；而且 `note` 是自由文本，人工备注里出现同样的词就会被误判；
--   2. 每个读方都要在应用层再 `split('|')` 一次，谁忘了谁就把前缀当备注显示出来。
-- 因此补列，并把老数据的前缀摘走：`note` 从此只放人工备注（目前只有商品的「同名不同规格」）。
--
-- 口径：
--   * 三条 UPDATE 都是幂等的——摘过的行 `split_part(note,'|',1)` 不再命中枚举、
--     `position('|' IN note)` 变成 0，重跑本文件不会二次截断；
--   * 「非空 note 必带前缀」这条前提只对本次迁移之前的数据成立（那时 note 只由
--     queue.ts 的编码器写），之后 `note` 只剩人工备注，不再承载前缀；
--   * `ADD COLUMN` / `CREATE INDEX` 都带 `IF NOT EXISTS`，重跑不炸（与 0024 同款）。
--
-- 回滚：DROP INDEX IF EXISTS masterdata_dedupe_console_idx;
--       ALTER TABLE masterdata_dedupe DROP COLUMN IF EXISTS matched_by;
-- 回滚会丢掉命中依据（老前缀已从 note 摘走、无法还原），需要留证时先备份该表。
-- ---------------------------------------------------------------------------

ALTER TABLE masterdata_dedupe
  ADD COLUMN IF NOT EXISTS matched_by text NOT NULL DEFAULT 'name_only'
    CHECK (matched_by IN ('name_only', 'name_phone', 'alias'));

-- 老数据：note 形如 'name_phone' 或 'name_phone|同名不同规格'，前缀就是命中依据。
UPDATE masterdata_dedupe
   SET matched_by = split_part(note, '|', 1)
 WHERE note IS NOT NULL
   AND split_part(note, '|', 1) IN ('name_only', 'name_phone', 'alias');

UPDATE masterdata_dedupe
   SET note = NULLIF(substr(note, position('|' IN note) + 1), '')
 WHERE note IS NOT NULL
   AND position('|' IN note) > 0;

-- 摘完之后 note 里不该再有前缀残留：只有前缀、没有备注的行清成 NULL。
UPDATE masterdata_dedupe
   SET note = NULL
 WHERE note IN ('name_only', 'name_phone', 'alias');

-- 审核台主查询：按公司 + 类型 + 状态取候选，按分数倒序排队。
-- `masterdata_dedupe_queue_idx` 已覆盖前四列，但没带 created_at，分数相等时顺序不稳定；
-- 缺了这条索引，审核台的排序会退化成 Sort（见 schema-guard.ts 的登记注释）。
CREATE INDEX IF NOT EXISTS masterdata_dedupe_console_idx
  ON masterdata_dedupe (tenant_id, company_id, kind, state, score DESC, created_at DESC);
