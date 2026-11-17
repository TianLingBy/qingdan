-- 0028_login_code.sql
-- 登录短信验证码（D59③，接腾讯云短信的前置表）。
--
-- 为什么单独建表、不塞进 session：
--   * 验证码是「登录前」的一次性凭证，与会话生命周期无关；
--   * 登录时还没有租户上下文（手机号甚至可能不存在），任何带 tenant_id 的表都写不进去。
--
-- 隔离口径：
--   * 本表没有 tenant_id，不开 RLS——没有可判定的租户维度，登录前也不存在 app.tenant_id；
--   * 只存验证码的不可逆哈希，不落明文；明文只在发送那一刻存在于内存与短信通道；
--   * 应用角色只给 SELECT / INSERT / UPDATE（消费与失败计数靠 UPDATE），不给 DELETE；
--     过期行清理由后续运维任务用平台角色做，不在本迁移里偷偷收拾。
--
-- 迁移前向 only，不改历史文件。

CREATE TABLE login_code (
  id uuid PRIMARY KEY,
  -- 登录手机号原样存（与 employee.phone 同口径），不做规范化。
  phone text NOT NULL CHECK (length(btrim(phone)) > 0),
  purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login')),
  -- sha256(phone:code:pepper)，不可逆；比对在应用层用 timingSafeEqual。
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  -- 输错次数：达到上限（应用层 5 次）后该验证码作废，登录仍统一回 401。
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  request_ip text,
  request_id text
);

-- 取「该手机号最近一条」与 60 秒频控都走这个索引。
CREATE INDEX login_code_phone_created_idx ON login_code (phone, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON login_code TO qingdan_app;
