-- 0024_tenant_billing_drop.sql
-- 删除 tenant 表上的历史计费字段：计费口径统一到 company 级（见 0020_platform_billing.sql）。
--
-- 编号说明：本文件原为 0021_tenant_billing_drop.sql，与 0021_company_position_version.sql 重号；
--   2026-11-10 负责人裁定改为 0024（温汇敏在 #156 复核提出），补齐「一文件一号」。
--   迁移 runner 按文件名升序 + `schema_migrations` 账本执行（见 src/platform/db/migrate.ts）：
--   改名后**已跑过旧文件名的库会把它当新文件再跑一次**，所以下面的语句必须幂等
--   （`DROP COLUMN IF EXISTS`），再跑一次不会报错，也不会改数据。
--
-- 依据：
--   * 负责人 2026-11-08 拍板（#131 评论「按 A 删掉」）：一期只做公司级订阅，
--     tenant 级 plan / expires_at 是从未被读写的死字段；
--   * 实测：全仓 `apps/**` 与 `packages/**` 的 TypeScript 对 tenant.plan / tenant.expires_at
--     零引用（`tenant.*plan|tenant.expires|from tenant` 全无命中），也没有 INSERT INTO tenant；
--   * 项目尚未上线、无真实数据，删列零风险；
--   * D47：历史迁移（0001-0020）一律不改，本文件是纯前向追加。
--
-- 回滚：需再加一条迁移把字段加回；plan 原为 NOT NULL，回滚时必须先给默认值，
--       因此回滚不是简单逆操作（这也是当初选择删除、而不是留着的原因之一）。

ALTER TABLE tenant DROP COLUMN IF EXISTS plan;
ALTER TABLE tenant DROP COLUMN IF EXISTS expires_at;
