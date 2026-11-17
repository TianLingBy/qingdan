-- 20261117223000_masterdata_autocreate.sql
-- 主数据「静默建档 + 去重审核」第 1 块：来源标记、去重态、公司来源、客户财务列、去重队列（D98 / #302）。
--
-- 口径：
--   * 纯前向追加、单文件：只 ADD COLUMN / CREATE TABLE / CREATE INDEX，不改历史迁移、不删列、不改存量数据行；
--     每个 ADD COLUMN 都带 IF NOT EXISTS，重跑本文件不会因为列已存在而炸；
--   * 迁移 runner 对每个文件单独开事务（src/platform/db/migrate.ts），本文件不写 BEGIN / COMMIT，避免嵌套事务；
--   * 不装 pg_trgm：相似度算法在应用层做（后续块），本块只摊平表结构，不让迁移依赖需要 CREATE EXTENSION 的库权限；
--   * 存量数据全部落在「没做过比对」的状态（origin='manual'、dedupe_state='none'），不标 pending——
--     存量档案从未参与相似度比对，标成 pending 会一次性堆出几千条假待办，把审核台淹掉。

-- ---------------------------------------------------------------------------
-- 1. 主数据来源：谁在哪张单里带出来的（审核台按来源筛选，也用于「静默建档」溯源）
-- ---------------------------------------------------------------------------

ALTER TABLE customer  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','order','import'));
ALTER TABLE supplier  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','order','import'));
ALTER TABLE processor ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','order','import'));
ALTER TABLE product   ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','order','import'));

-- ---------------------------------------------------------------------------
-- 2. 去重态：三值固定。默认 'none' 且不回填——存量档案没做过相似度比对，标成 pending 会堆出几千条假待办
-- ---------------------------------------------------------------------------

ALTER TABLE customer  ADD COLUMN IF NOT EXISTS dedupe_state text NOT NULL DEFAULT 'none' CHECK (dedupe_state IN ('none','pending','merged'));
ALTER TABLE supplier  ADD COLUMN IF NOT EXISTS dedupe_state text NOT NULL DEFAULT 'none' CHECK (dedupe_state IN ('none','pending','merged'));
ALTER TABLE processor ADD COLUMN IF NOT EXISTS dedupe_state text NOT NULL DEFAULT 'none' CHECK (dedupe_state IN ('none','pending','merged'));
ALTER TABLE product   ADD COLUMN IF NOT EXISTS dedupe_state text NOT NULL DEFAULT 'none' CHECK (dedupe_state IN ('none','pending','merged'));

-- ---------------------------------------------------------------------------
-- 3. 公司来源：N 单只能选子公司不能建，靠这列区分「本体的公司」和「被带出来的对手方档案」
-- ---------------------------------------------------------------------------

ALTER TABLE company ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'self' CHECK (source IN ('self','subsidiary','customer','supplier','processor'));

-- ---------------------------------------------------------------------------
-- 4. 客户财务字段（公司四来源分治：客户档案与公司档案共用一份财务口径）
--    只加列不加 CHECK：税号 / 账号的格式校验放应用层，改规则时不用再写迁移
-- ---------------------------------------------------------------------------

ALTER TABLE customer ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS tax_no text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS bank_account text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS invoice_title text;

-- ---------------------------------------------------------------------------
-- 5. 去重队列：一行 = 一对「疑似同一条档案」，待人工判定
-- ---------------------------------------------------------------------------

CREATE TABLE masterdata_dedupe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 去重按公司隔离：同一个「张三批发部」在两个子公司是两条互不相干的档案。
  company_id uuid NOT NULL REFERENCES company (id),
  kind text NOT NULL CHECK (kind IN ('customer','supplier','processor','product')),
  -- left_id 是「已有档案」，right_id 是「新带出来的」。
  left_id uuid NOT NULL,
  right_id uuid NOT NULL,
  score numeric(4,3) NOT NULL,
  note text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','merged','kept')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES employee (id),
  CONSTRAINT masterdata_dedupe_pair_key UNIQUE (kind, left_id, right_id)
);

-- 审核台主查询：按租户 + 公司 + 类型筛待办，分数高的排前面。
CREATE INDEX masterdata_dedupe_queue_idx ON masterdata_dedupe (tenant_id, company_id, kind, state, score DESC);
-- 反查：某条档案被哪些待办引用（合并后要把另一侧的对子一起收口）。
CREATE INDEX masterdata_dedupe_right_idx ON masterdata_dedupe (right_id);

-- ---------------------------------------------------------------------------
-- 6. 放宽权限动作 CHECK 到第 10 个动作 `merge`（D98）
--    契约 ACTIONS 已加 merge；不放宽这两处 CHECK，权限页勾选「合并主数据」会在写库时 400，
--    老板也就无法把这个能力收回。存量授权一律不回填，只放宽枚举。
-- ---------------------------------------------------------------------------

ALTER TABLE position_permission
  DROP CONSTRAINT IF EXISTS position_permission_action_check;

ALTER TABLE position_permission
  ADD CONSTRAINT position_permission_action_check
  CHECK (action IN ('read', 'create', 'update', 'approve', 'ship', 'delete', 'merge', 'view_price', 'view_handler', 'export'));

ALTER TABLE employee_permission_override
  DROP CONSTRAINT IF EXISTS employee_permission_override_action_check;

ALTER TABLE employee_permission_override
  ADD CONSTRAINT employee_permission_override_action_check
  CHECK (action IN ('read', 'create', 'update', 'approve', 'ship', 'delete', 'merge', 'view_price', 'view_handler', 'export'));
