-- 0021_company_position_version.sql
-- 公司 / 岗位补乐观锁版本与更新时间列（Issue #121，2026-11-08）。
--
-- 背景：company / position 的 7 个端点补实现（platform.company.* / platform.position.*），
-- 契约实体（companies.ts / positions.ts）要求响应带 `version`（强 ETag If-Match，D60③ 同款）
-- 与 `updatedAt`；员工表已在 0002_platform_m1.sql 加过同款 `version` 列，本迁移对齐。
--
-- - `version`：乐观锁，update / delete（停用）时 +1，用 `WHERE version = $n` 兜并发；
-- - `updated_at`：写操作在 UPDATE 里手工维护（与 number_sequence 同口径，不建触发器）；
--   存量行回填为迁移执行时刻，可接受（此前无任何更新入口，行从未被改过）。

ALTER TABLE company ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE company ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE position ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE position ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
