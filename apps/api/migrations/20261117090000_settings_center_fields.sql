-- 20261117090000_settings_center_fields.sql
-- 设置中心：公司扩展资料四列（Issue #298 / D93）。
--
-- 依据：docs/design-settings-center.md §4.1（B2 公司扩展资料）。
--
-- 口径：
--   * 纯前向追加：只 ADD COLUMN，不改历史迁移、不删列；
--   * 四列全部可空、无默认值、不 backfill：存量公司保持 NULL，由设置中心按需填写；
--   * 迁移 runner 对每个文件单独开事务（src/platform/db/migrate.ts），
--     本文件不写 BEGIN / COMMIT，避免嵌套事务。
--
-- 本块只加 company 四列；employee 的换号暂存列与 /employees/me 系列在后续块补，
-- 不放进同一个迁移，避免一块改动过大。

ALTER TABLE company ADD COLUMN address text;
ALTER TABLE company ADD COLUMN contact_phone text;
ALTER TABLE company ADD COLUMN tax_no text;
ALTER TABLE company ADD COLUMN logo_url text;
