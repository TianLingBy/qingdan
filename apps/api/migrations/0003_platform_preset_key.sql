-- 0003_platform_preset_key.sql
-- 岗位「预设键」（PR #2 审查：经理/财务边界不能靠岗位名 LIKE 判定）。
--
-- 背景：员工个人权限覆盖（D50）的写侧边界此前按 `position.name LIKE '%经理%' / '%财务%'`
-- 判定，岗位改名即可绕过。preset_key 是出厂预设岗位的稳定标识，与展示名解耦；
-- 自定义岗位为 NULL。
--
-- 兼容策略：
--   * 本迁移只加列 / CHECK / 索引，**不回填**（避免按名称猜测把自定义岗位误标成预设）；
--   * 新建库由 seed 写入 preset_key；旧库未重跑 seed 时 preset_key 为 NULL，
--     业务侧对 NULL 保留名称兜底（见 apps/api/src/modules/platform/usecases/permission-overrides.ts）。
--
-- 允许值：老板 / 经理 / 财务 / 销售 / 采购 / 质检 / 拣货 / 仓管 八类出厂模板。

ALTER TABLE position ADD COLUMN preset_key text;

ALTER TABLE position
  ADD CONSTRAINT position_preset_key_check
  CHECK (
    preset_key IS NULL
    OR preset_key IN ('owner', 'manager', 'finance', 'sales', 'purchase', 'quality', 'picking', 'warehouse')
  );

CREATE INDEX position_tenant_preset_key_idx ON position (tenant_id, preset_key);
