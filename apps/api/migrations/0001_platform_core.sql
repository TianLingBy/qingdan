-- 0001_platform_core.sql
-- 轻单 platform 内核表（M0 骨架）。
-- 口径真源：docs/platform-domain-model.md §1（逻辑字段）、docs/decisions.md D55（物理约定）。
-- 约定：
--   * 主键 uuid（应用侧 UUIDv7，PG 侧不设默认值）；
--   * 金额 numeric(18,6)（本批表暂不落金额列，业务单据表由各模块迁移建）；
--   * 时间点 timestamptz（UTC 存储）；编码一律 text + 正则 CHECK（禁止整数，前导零会丢）；
--   * 所有带 tenant_id 的表加 tenant_id 冗余列，供 D55 的 RLS 兜底 + 复合索引；
--   * 业务状态枚举保留中文原值（D54 §9-6）；权限域/动作沿用契约英文键。

-- ---------------------------------------------------------------------------
-- 1. 租户 / 公司 / 员工
-- ---------------------------------------------------------------------------

-- 金额精度（D55②）：存储 numeric(18,6)，聚合与毛利计算全程用未舍入值，展示/契约边界才四舍五入到 2 位。
-- platform 这 13 张内核表本身没有金额列（业务金额属各模块单据表），用 domain 把口径固化下来给后续迁移复用。
CREATE DOMAIN amount AS numeric(18, 6);

CREATE TABLE tenant (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- 套餐由运营后台手动配置，值域未定（platform-domain-model §1.1 ⬜）→ 不建枚举。
  plan text NOT NULL,
  -- 到期只提示续费、功能不中断（D1/D12）；「永久」是否允许未定 → 允许 NULL。
  expires_at date,
  status text NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- 公司码定长 4 位、租户内从 0001 顺序递增（D16）。存 text 以保留前导零。
  code text NOT NULL CHECK (code ~ '^[0-9]{4}$'),
  level integer NOT NULL DEFAULT 1 CHECK (level >= 1),
  status text NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_tenant_code_key UNIQUE (tenant_id, code)
);
CREATE INDEX company_tenant_idx ON company (tenant_id);

CREATE TABLE employee (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 工号 6 位、全租户唯一、跨公司调动不变（D48）。
  employee_no text NOT NULL CHECK (employee_no ~ '^[0-9]{6}$'),
  -- 手机号 = 一期唯一登录账号，全平台唯一（D13/D14）；不存真实号码，seed 用占位号。
  phone text NOT NULL CHECK (phone ~ '^1[0-9]{10}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  status text NOT NULL DEFAULT '在职' CHECK (status IN ('在职', '停用')),
  -- 老板 = 租户级（D1/D15）。表达方式在 domain-model §1.3 仍标 ⬜，
  -- 这里按「员工布尔 + 权限引擎短路」落地，属 M0 实现选择，需 Lead 复核。
  is_owner boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES employee (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT employee_tenant_no_key UNIQUE (tenant_id, employee_no),
  CONSTRAINT employee_phone_key UNIQUE (phone)
);
CREATE INDEX employee_tenant_idx ON employee (tenant_id);

-- ---------------------------------------------------------------------------
-- 2. 岗位与授权（D4 / D15 / D50）
-- ---------------------------------------------------------------------------

CREATE TABLE position (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  kind text NOT NULL DEFAULT '自定义' CHECK (kind IN ('预设', '自定义')),
  is_system boolean NOT NULL DEFAULT false,
  -- 岗位模板作用域未定（domain-model §1.4 ⬜）→ 允许 NULL，不预设语义。
  scope text CHECK (scope IN ('租户级', '公司级')),
  status text NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT position_tenant_name_key UNIQUE (tenant_id, name)
);
CREATE INDEX position_tenant_idx ON position (tenant_id);

CREATE TABLE position_permission (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  position_id uuid NOT NULL REFERENCES position (id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (
    domain IN (
      'purchase', 'processing', 'sales', 'internal_trade', 'settlement', 'commission',
      'customer_return', 'supplier_return', 'stocktake', 'product', 'customer', 'supplier',
      'processor', 'inventory_qty', 'inventory_flow', 'stocktake_page', 'employee',
      'permission', 'company', 'profit_report', 'audit', 'api_integration'
    )
  ),
  action text NOT NULL CHECK (
    action IN ('read', 'create', 'update', 'approve', 'ship', 'delete', 'view_price', 'export')
  ),
  -- 显式存「授予 / 未授予」，不靠行缺失表达（D4）。
  granted boolean NOT NULL,
  PRIMARY KEY (position_id, domain, action)
);
CREATE INDEX position_permission_tenant_idx ON position_permission (tenant_id);

-- 一张表同时承载「一人多岗」与「公司隔离」（D4/D15）。
CREATE TABLE employee_company_position (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  employee_id uuid NOT NULL REFERENCES employee (id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES company (id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES position (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, company_id, position_id)
);
CREATE INDEX ecp_tenant_idx ON employee_company_position (tenant_id);
CREATE INDEX ecp_company_idx ON employee_company_position (company_id);

-- 个人级覆盖（D50）：granted=true 加、false 减，优先于岗位并集；不能跨公司扩大可见范围。
CREATE TABLE employee_permission_override (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  employee_id uuid NOT NULL REFERENCES employee (id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (
    domain IN (
      'purchase', 'processing', 'sales', 'internal_trade', 'settlement', 'commission',
      'customer_return', 'supplier_return', 'stocktake', 'product', 'customer', 'supplier',
      'processor', 'inventory_qty', 'inventory_flow', 'stocktake_page', 'employee',
      'permission', 'company', 'profit_report', 'audit', 'api_integration'
    )
  ),
  action text NOT NULL CHECK (
    action IN ('read', 'create', 'update', 'approve', 'ship', 'delete', 'view_price', 'export')
  ),
  granted boolean NOT NULL,
  operator_id uuid NOT NULL REFERENCES employee (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, domain, action)
);
CREATE INDEX epo_tenant_idx ON employee_permission_override (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. 凭证（会话 / API Token）
-- ---------------------------------------------------------------------------

-- 会话字段契约未定（domain-model §1.11 ⬜），这里只落 D51 凭证 id 反查与失效所需的最小列。
CREATE TABLE session (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  employee_id uuid NOT NULL REFERENCES employee (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  ip text,
  user_agent text,
  CONSTRAINT session_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX session_tenant_employee_idx ON session (tenant_id, employee_id);

CREATE TABLE api_token (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 必须绑定员工（含服务账号员工），不允许租户级凭证（D52②）。
  employee_id uuid NOT NULL REFERENCES employee (id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- 功能域 × 动作子集，数组形态（契约第三批 §2）。
  scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 明文只在创建时返回一次，服务端只存不可逆哈希。
  token_hash text NOT NULL,
  token_prefix text,
  expires_at timestamptz,
  ip_allowlist text[],
  last_used_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_by uuid NOT NULL REFERENCES employee (id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX api_token_tenant_idx ON api_token (tenant_id);
CREATE INDEX api_token_employee_idx ON api_token (tenant_id, employee_id);

-- ---------------------------------------------------------------------------
-- 4. 审计（D51 / D55⑤）：outbox + 只追加日志
-- ---------------------------------------------------------------------------

-- 事务内先写 outbox，业务提交后再搬到 audit_log（F1/F2 失败语义见 domain-model §4.1）。
-- 审计表不建外键：租户数据删除不得影响日志（D51「平台侧保留独立副本」）。
CREATE TABLE audit_outbox (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  tenant_id uuid,
  company_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('platform', 'employee', 'ai', 'system')),
  actor_id text NOT NULL,
  credential_id text,
  source text NOT NULL CHECK (source IN ('web', 'cli', 'api', 'mcp', 'job')),
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  changes jsonb,
  result text NOT NULL CHECK (result IN ('success', 'fail')),
  error_code text,
  request_id text NOT NULL,
  ip text,
  user_agent text,
  reason text,
  business_txn_id text,
  dry_run boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_outbox_created_idx ON audit_outbox (created_at);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  tenant_id uuid,
  company_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('platform', 'employee', 'ai', 'system')),
  actor_id text NOT NULL,
  credential_id text,
  source text NOT NULL CHECK (source IN ('web', 'cli', 'api', 'mcp', 'job')),
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  changes jsonb,
  result text NOT NULL CHECK (result IN ('success', 'fail')),
  error_code text,
  request_id text NOT NULL,
  ip text,
  user_agent text,
  reason text,
  business_txn_id text,
  dry_run boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_tenant_action_idx ON audit_log (tenant_id, action);
CREATE INDEX audit_log_tenant_actor_idx ON audit_log (tenant_id, actor_id);
CREATE INDEX audit_log_request_idx ON audit_log (request_id);

-- ---------------------------------------------------------------------------
-- 5. 幂等键与取号（D16 / D48 / domain-model §3）
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_key (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_key_tenant_key UNIQUE (tenant_id, key)
);
CREATE INDEX idempotency_key_expires_idx ON idempotency_key (expires_at);

-- 计数键 = (租户, 作用域串)；单据作用域串含类型 + yyyyMM（跨月天然重置，不清表）。
CREATE TABLE number_sequence (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  scope_key text NOT NULL,
  last_value integer NOT NULL CHECK (last_value >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_key)
);

-- ---------------------------------------------------------------------------
-- 6. 应用角色 + RLS 兜底（D55① / D57③）
--    测试与生产都必须用「非 superuser、无 BYPASSRLS」的专用角色，否则 RLS 形同虚设。
-- ---------------------------------------------------------------------------

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qingdan_app') THEN
    CREATE ROLE qingdan_app NOLOGIN;
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO qingdan_app;

-- tenant 表是隔离根：应用角色只读（新增/停用租户属平台级操作，由平台角色执行，M1 落地）。
GRANT SELECT ON tenant TO qingdan_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  company,
  employee,
  position,
  position_permission,
  employee_company_position,
  employee_permission_override,
  session,
  api_token,
  audit_outbox,
  idempotency_key,
  number_sequence
TO qingdan_app;

-- 操作日志只追加：应用角色仅 INSERT，显式回收 UPDATE / DELETE / TRUNCATE（D51）。
-- （审计查询端点落地时需另开只读授权，属待裁决项，不在本次骨架里偷偷放宽。）
GRANT INSERT ON audit_log TO qingdan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM qingdan_app;

-- 带 tenant_id 的核心表统一开 RLS：读/写都必须匹配 current_setting('app.tenant_id')。
-- tenant 表是隔离根、本身没有 tenant_id 列，不在此列（访问它属平台级操作）。
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company',
    'employee',
    'position',
    'position_permission',
    'employee_company_position',
    'employee_permission_override',
    'session',
    'api_token',
    'audit_outbox',
    'idempotency_key',
    'number_sequence'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      $policy$CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$policy$,
      t
    );
  END LOOP;
END
$rls$;

-- audit_log：应用角色只能写/读「本租户」行。
-- 平台级日志（tenant_id 为空）不向应用角色放行——否则一旦授了 SELECT 就变成跨租户读；
-- 平台日志由平台角色写入，属 M1 待办（见 docs/module-platform.md 待裁决第 1 条）。
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
