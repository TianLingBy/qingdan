-- 设置中心第 2 块（Issue #298）：换手机号暂存列 + 公司扩展资料的格式约束。
--
-- 三条共同口径：
--   ① 纯前向、单文件；`migrate.ts` 每个文件自成一个事务，这里不写 BEGIN / COMMIT；
--   ② 新列一律可空、不 backfill：存量公司从来没有填过地址 / 电话 / 税号 / LOGO，
--      给默认值（''、'000000000000000'）等于替客户编造资料，事后没人分得清
--      哪些是真填的、哪些是迁移凑的。NULL 的语义就是「尚未填写」，前端显示为空。
--   ③ 列用 IF NOT EXISTS：`20261117090000_settings_center_fields.sql` 已经建过公司四列，
--      这里再写一遍是为了让「新库顺序跑完全部迁移」与「老库只补跑这一条」得到同一结果——
--      脚本自身的正确性不依赖前一条迁移是否也建过这些列。

ALTER TABLE company
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS tax_no text,
  ADD COLUMN IF NOT EXISTS logo_url text;

-- 税号格式与契约 `TaxNoSchema` 同口径（15–20 位大写字母数字）。
-- 只约束「填了的值必须合法」：全空仍然放行，因为绝大多数存量公司根本没这项信息。
ALTER TABLE company
  ADD CONSTRAINT company_tax_no_check CHECK (tax_no IS NULL OR tax_no ~ '^[0-9A-Z]{15,20}$');

-- 换手机号：待生效的新号放**单独一列**，而不是直接改 `employee.phone`。
-- 为什么不能直接改：手机号就是登录账号。直接改等于「验证码发出去的那一刻账号已经换了」，
-- 一旦新号收不到码（号码填错、手机丢了），这个人再也登不进来，连自己撤销都做不到。
-- 拆成三列后：双确认完成前旧号照常可用；中途放弃只要把三列清空即可原地作废，
-- 不产生任何历史副作用，也不需要额外的「申请记录表」。
ALTER TABLE employee
  ADD COLUMN IF NOT EXISTS pending_phone text,
  ADD COLUMN IF NOT EXISTS pending_phone_code_hash text,
  ADD COLUMN IF NOT EXISTS pending_phone_expires_at timestamptz;

-- 与 `employee_phone_check` 同口径：填了新号就必须是合法号段，否则确认阶段会写坏登录账号。
ALTER TABLE employee
  ADD CONSTRAINT employee_pending_phone_check
  CHECK (pending_phone IS NULL OR pending_phone ~ '^1[0-9]{10}$');

-- 频控复用 `login_code`（它就是「验证码发送流水」表）：换号验证码与登录验证码走
-- 完全相同的两条策略（同号 60 秒一条、24 小时最多 10 条），因此只把 purpose 枚举
-- 放宽一格，而不是为「换号」另造一张只用来计数的表——两张表各写一套限流必然漂移。
-- 注意：`consumeLoginCode` 只认 purpose='login'，换号码不会被登录流程消费。
ALTER TABLE login_code DROP CONSTRAINT IF EXISTS login_code_purpose_check;
ALTER TABLE login_code
  ADD CONSTRAINT login_code_purpose_check CHECK (purpose IN ('login', 'phone_change'));
