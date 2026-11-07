-- 0002_platform_m1.sql
-- M1-A 认证数据库地基（D59 ①②）。
--
-- 目标：
--   * 审计只读视图（基表仍只授 INSERT，D51「不可改删」的物理保证不变）；
--   * 登录 / 凭证解析在拿到租户上下文之前的跨租户查找，用 SECURITY DEFINER 函数收口，
--     不放宽 session / api_token / employee 的 RLS，也不给应用角色跨租户 SELECT。
--
-- 约定（D59）：
--   * 一律 `SET search_path = pg_catalog, public`，函数内表全部 schema 限定；
--   * `REVOKE ALL FROM PUBLIC` 后只 `GRANT EXECUTE TO qingdan_app`；
--   * 迁移执行角色必须是 superuser 或带 BYPASSRLS 的平台角色，否则 SECURITY DEFINER
--     仍会受 FORCE ROW LEVEL SECURITY 约束（表 owner 也被 FORCE RLS 管）。

-- ---------------------------------------------------------------------------
-- 1. 审计查询只读视图（D59①）
--    基表 audit_log 仍只有 INSERT 权限；UPDATE / DELETE / SELECT 都不授。
--
--    注意：不能用 `security_invoker = true` —— 那会让查询以调用者权限执行，
--    qingdan_app 仍需要 audit_log 的 SELECT 权限，与「基表不授 SELECT」相矛盾。
--    这里用视图属主权限执行，并把租户条件**显式**写进视图定义：即使迁移角色是
--    superuser / BYPASSRLS（视图属主因此绕过 RLS），也不会跨租户泄漏；
--    `app.tenant_id` 未设置时 nullif → NULL，比较为 NULL，fail-closed 返回 0 行。
-- ---------------------------------------------------------------------------

CREATE VIEW audit_log_view AS
  SELECT *
  FROM audit_log
  WHERE tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;

GRANT SELECT ON audit_log_view TO qingdan_app;

-- ---------------------------------------------------------------------------
-- 2. 登录查找（D59②）：登录时尚无租户上下文，employee 的 RLS 会挡住查找。
--    只返回登录判定所需列，不返回手机号/租赁等敏感扩展字段。
-- ---------------------------------------------------------------------------

CREATE FUNCTION auth_find_login(p_phone text)
RETURNS TABLE (
  tenant_id uuid,
  employee_id uuid,
  employee_name text,
  employee_status text,
  tenant_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.tenant_id, e.id, e.name, e.status, t.status
  FROM public.employee e
  JOIN public.tenant t ON t.id = e.tenant_id
  WHERE e.phone = p_phone;
$$;

REVOKE ALL ON FUNCTION auth_find_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_login(text) TO qingdan_app;

-- ---------------------------------------------------------------------------
-- 3. 会话解析（D59② / D59⑦）：服务端只按 sha256(token) 精确查找。
-- ---------------------------------------------------------------------------

CREATE FUNCTION auth_resolve_session(p_token_hash text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  employee_id uuid,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.tenant_id, s.employee_id, s.expires_at, s.revoked_at
  FROM public.session s
  WHERE s.token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION auth_resolve_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_session(text) TO qingdan_app;

-- ---------------------------------------------------------------------------
-- 4. API Token 解析（D59② / D52.1）：status / 过期 / IP 白名单由应用层判定，
--    函数只负责跨 RLS 取回凭证行。
-- ---------------------------------------------------------------------------

CREATE FUNCTION auth_resolve_api_token(p_token_hash text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  employee_id uuid,
  scope jsonb,
  status text,
  expires_at timestamptz,
  ip_allowlist text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.tenant_id, t.employee_id, t.scope, t.status, t.expires_at, t.ip_allowlist
  FROM public.api_token t
  WHERE t.token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION auth_resolve_api_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_api_token(text) TO qingdan_app;

-- ---------------------------------------------------------------------------
-- 5. 无租户上下文的审计追加（M1-B，D51 / D59③）
--
-- 失败登录（尤其未知手机号）拿不到 tenant_id，而 audit_log 对 qingdan_app 是
-- FORCE RLS + `tenant_id = app.tenant_id`。直接 INSERT 会被 WITH CHECK 拒绝，日志随之丢失。
--
-- 收口方式与上面三个函数一致：SECURITY DEFINER + 固定 search_path + 只授 EXECUTE 给
-- qingdan_app；函数内**强制 tenant_id IS NULL**，有租户的日志不得走这里（仍走 outbox 两段式），
-- 避免它被当成绕过 RLS 的通用写入口。
-- ---------------------------------------------------------------------------

CREATE FUNCTION audit_append_unscoped(
  p_id uuid,
  p_occurred_at timestamptz,
  p_tenant_id uuid,
  p_company_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_credential_id text,
  p_source text,
  p_action text,
  p_object_type text,
  p_object_id text,
  p_changes jsonb,
  p_result text,
  p_error_code text,
  p_request_id text,
  p_ip text,
  p_user_agent text,
  p_reason text,
  p_business_txn_id text,
  p_dry_run boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_tenant_id IS NOT NULL THEN
    RAISE EXCEPTION 'audit_append_unscoped 只接受 tenant_id IS NULL 的日志行';
  END IF;

  INSERT INTO public.audit_log (
    id, occurred_at, tenant_id, company_id, actor_type, actor_id, credential_id,
    source, action, object_type, object_id, changes, result, error_code, request_id,
    ip, user_agent, reason, business_txn_id, dry_run
  ) VALUES (
    p_id, p_occurred_at, p_tenant_id, p_company_id, p_actor_type, p_actor_id, p_credential_id,
    p_source, p_action, p_object_type, p_object_id, p_changes, p_result, p_error_code, p_request_id,
    p_ip, p_user_agent, p_reason, p_business_txn_id, p_dry_run
  );
END;
$$;

REVOKE ALL ON FUNCTION audit_append_unscoped(
  uuid, timestamptz, uuid, uuid, text, text, text, text, text, text, text, jsonb,
  text, text, text, text, text, text, text, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_append_unscoped(
  uuid, timestamptz, uuid, uuid, text, text, text, text, text, text, text, jsonb,
  text, text, text, text, text, text, text, boolean
) TO qingdan_app;

-- ---------------------------------------------------------------------------
-- 6. M1-C 乐观锁版本列（D54 技术项：ETag 用强串 `"<version>"`）
--
--    纯前向追加：已有行回填默认值 1。
--    * api_token.version：撤销时读取 If-Match，成功后 +1；
--    * employee.version：M1-E 的员工权限覆盖写入复用同一套 If-Match 口径。
-- ---------------------------------------------------------------------------

ALTER TABLE api_token ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE employee ADD COLUMN version integer NOT NULL DEFAULT 1;
