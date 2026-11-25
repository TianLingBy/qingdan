import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '../../components/icons/Icon';
import { DEFAULT_ROUTE_PATH } from '../../router/routes';
import {
  authApi,
  authKeys,
  describeLoginError,
  PHONE_PATTERN,
  validateLoginForm,
  type LoginErrorView,
  type LoginField,
  type LoginFieldErrors,
  type LoginInput,
} from './auth-api';

/**
 * 登录页（IA 第 1 页 / #4），按 **v3.0** 实现（#435）。
 *
 * 口径（负责人 2026-11-24 拍板）：
 *   - 视觉基线 `design/v3.0/index.html` 的 `PG` 登录页：左品牌 6 : 右表单 4，
 *     样式全部来自 `app-v30.css` 的 `.lg-*`（#443 已合，不改底座、不新造类）。
 *   - 表单三态走 `data-state="idle|loading|error"`：提交中禁用 + 转圈，
 *     错误时 `.lg-alert` 出现（常驻 CSS 已就绪），输入框按 `err` 类标红。
 *   - **入企降级**：后端 `/auth/*` 只有 `code|login|logout|me`，没有邀请码/注册端点，
 *     所以「未加入任何企业」只做空态（`data-state="empty"`），加入企业由管理员在员工页建号。
 *   - 会话是 HttpOnly Cookie，登录后靠 `GET /auth/me` 确认再决定去向。
 *   - 错误按统一错误体的 `code` 分支展示，绝不提示「手机号是否存在」（服务端 401 不区分）。
 *
 * 拆成三层便于测试：`LoginBrandShell`（纯版式）→ `LoginForm`（表单状态机）→ `LoginPage`（接线）。
 */

/** 输入框的 `err` 类由 CSS 接管（`.lg-field input.err`），这里只决定要不要加。 */
function fieldClass(invalid: boolean): string | undefined {
  return invalid ? 'err' : undefined;
}

/** 登录失败提示：文案 + 请求编号（排查审计日志用）。 */
export function LoginErrorAlert({ error }: { error: LoginErrorView }) {
  return (
    <div className="lg-alert" role="alert">
      <Icon name="shield" size={16} />
      <span>
        {error.message}
        {error.requestId && <span className="mono"> · 请求编号 {error.requestId}</span>}
      </span>
    </div>
  );
}

/** 版式壳：左侧品牌区（≤ 900px 隐藏，见 app-v30.css §5）+ 右侧表单区。 */
export function LoginBrandShell({ children }: { children: ReactNode }) {
  return (
    <div className="lg-wrap">
      <aside className="lg-brand">
        <div className="lg-mark">轻</div>
        <h1 className="lg-slogan">
          每一笔内部交易
          <br />都<em>算得清</em>成本
        </h1>
        <p className="lg-sub">
          <span>采购 加工 销售 调拨 结算</span>
          <span>一套账本 口径统一 权限分明 数据透明</span>
        </p>
        <div className="lg-foot">QINGDAN · INTERNAL LEDGER</div>
      </aside>

      <main className="lg-formpane">{children}</main>
    </div>
  );
}

/**
 * 未加入任何企业（入企降级后的唯一形态）。
 *
 * 后端没有邀请码/注册端点，登录成功但 `me.companyIds` 为空时停在这里；
 * 空态用 `data-state="empty"` + `.st-block .st-empty`（app-v013 的四态机制，不新造）。
 */
export function LoginNoCompany({ onBack }: { onBack?: () => void }) {
  return (
    <div className="ent-wrap">
      <aside className="ent-brand">
        <div className="lg-mark">轻</div>
        <h1 className="lg-slogan">
          这个手机号
          <br />还<em>没有公司</em>
        </h1>
        <p className="lg-sub">
          <span>加入企业由管理员在员工页建号</span>
          <span>建号后，用同一手机号登录即可进入公司账本</span>
        </p>
        <div className="lg-foot">QINGDAN · NO COMPANY YET</div>
      </aside>

      <main className="ent-pane">
        <div className="ent-card" data-state="empty">
          <div className="st-block st-empty">
            <div className="st-ico">
              <Icon name="shield" size={96} />
            </div>
            <div className="st-title">还没有加入任何企业</div>
            <p className="st-desc">
              当前手机号还没有加入任何企业，请联系管理员开通；开通后用同一手机号重新登录即可。
            </p>
            <div className="st-actions">
              <button type="button" className="btn btn-primary" onClick={onBack}>
                返回登录
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export interface LoginFormProps {
  /** 提交登录；抛错时由表单翻译成人话。成功 resolve 视为登录成功。 */
  readonly onLogin: (input: LoginInput) => Promise<void>;
  /** 发送验证码；不传则不渲染「获取验证码」按钮（SSR / 旧用法保持兼容）。 */
  readonly onSendCode?: (phone: string) => Promise<void>;
  /** 登录成功、提示已显示之后的回调（由外层负责跳转）。 */
  readonly onSucceeded?: () => void;
}

export function LoginForm({ onLogin, onSendCode, onSucceeded }: LoginFormProps) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [formError, setFormError] = useState<LoginErrorView | null>(null);
  const [pending, setPending] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sendNotice, setSendNotice] = useState<string | null>(null);

  const busy = pending || succeeded;
  /** v3.0 三态：提交中 loading、有错 error、其余 idle（样式见 `.lg-form[data-state=…]`）。 */
  const formState = busy ? 'loading' : formError ? 'error' : 'idle';

  // 倒计时每秒减一；到 0 自动停。
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((current) => current - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const clearFieldError = (field: LoginField) => {
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  };

  /** 前端校验失败也走统一的错误条，不另造字段级提示样式（底座里没有这一类）。 */
  const showFieldErrors = (errors: LoginFieldErrors) => {
    setFieldErrors(errors);
    const message = errors.phone ?? errors.code;
    setFormError(message ? { message, field: errors.phone ? 'phone' : 'code', requestId: null } : null);
  };

  const handleSendCode = async () => {
    if (!onSendCode || sendingCode || cooldown > 0 || busy) return;
    const value = phone.trim();
    if (!PHONE_PATTERN.test(value)) {
      showFieldErrors({ phone: '手机号需为 11 位数字' });
      return;
    }
    setSendingCode(true);
    setFormError(null);
    setSendNotice(null);
    try {
      await onSendCode(value);
      setSendNotice('验证码已发送，请查看短信');
      setCooldown(60);
    } catch (error) {
      setFormError(describeLoginError(error));
      // 失败也给一个短冷却，避免连点把频控额度耗尽。
      setCooldown(10);
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const input: LoginInput = { phone: phone.trim(), code: code.trim() };
    const errors = validateLoginForm(input);
    setFormError(null);
    if (errors.phone || errors.code) {
      showFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    setPending(true);
    try {
      await onLogin(input);
      setSucceeded(true);
      onSucceeded?.();
    } catch (error) {
      setFormError(describeLoginError(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="lg-form" id="lgForm" data-state={formState} onSubmit={handleSubmit} noValidate>
      <h2>登录轻单</h2>
      <p className="lg-hint">手机号 + 验证码登录 · 账号由管理员统一创建</p>

      {formError && <LoginErrorAlert error={formError} />}

      <div className="lg-field">
        <label htmlFor="phone">手机号</label>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          maxLength={11}
          placeholder="11 位手机号"
          value={phone}
          disabled={busy}
          aria-invalid={Boolean(fieldErrors.phone)}
          className={fieldClass(Boolean(fieldErrors.phone))}
          onChange={(event) => {
            setPhone(event.target.value);
            clearFieldError('phone');
          }}
        />
      </div>

      <div className="lg-field">
        <label htmlFor="code">验证码</label>
        <div className="lg-code">
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6 位验证码"
            value={code}
            disabled={busy}
            aria-invalid={Boolean(fieldErrors.code)}
            className={fieldClass(Boolean(fieldErrors.code))}
            onChange={(event) => {
              setCode(event.target.value);
              clearFieldError('code');
            }}
          />
          {onSendCode && (
            <button
              type="button"
              onClick={() => void handleSendCode()}
              disabled={busy || sendingCode || cooldown > 0}
            >
              {cooldown > 0 ? `${cooldown}s 后重发` : sendingCode ? '发送中…' : '获取验证码'}
            </button>
          )}
        </div>
        {sendNotice && (
          <p className="lg-hint" role="status">
            {sendNotice}
          </p>
        )}
      </div>

      <button
        type="submit"
        className="lg-submit"
        disabled={busy}
        aria-busy={pending || undefined}
      >
        {pending ? (
          <>
            <Icon name="refresh" size={16} className="spin" />
            登录中…
          </>
        ) : (
          '登 录'
        )}
      </button>

      {succeeded && (
        <p className="lg-hint" role="status">
          登录成功，正在进入工作台…
        </p>
      )}

      <p className="lg-hint">
        企业注册与入企暂未开放（一期），账号由管理员统一创建。
        <br />
        测试环境演示账号 10000000001，验证码 000000。
      </p>
    </form>
  );
}

/** 页面接线：登录成功 → 写回 me 缓存 → 已绑公司进工作台；未绑公司停在空态。 */
export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [noCompany, setNoCompany] = useState(false);

  const handleLogin = async (input: LoginInput) => {
    // Cookie 落地后再取 /auth/me，一次拿全 companyIds / scope / entries。
    await authApi.login(input);
    const me = await authApi.me();
    queryClient.setQueryData(authKeys.me, me);
    // 入企降级（#435）：没绑任何公司 → 停在空态，不跳工作台（工作台对空公司没有意义）。
    if (me.companyIds.length === 0) setNoCompany(true);
  };

  const handleSendCode = async (phone: string) => {
    await authApi.sendCode(phone);
  };

  const handleSucceeded = () => {
    // 留一拍让「登录成功」被看见，再进工作台；无公司时由 noCompany 分支接管画面。
    window.setTimeout(() => {
      setNoCompany((current) => {
        if (!current) void navigate({ to: DEFAULT_ROUTE_PATH });
        return current;
      });
    }, 500);
  };

  const handleBackToLogin = () => {
    // 清掉会话与缓存，回到干净登录态（不整页刷新）。
    void authApi.logout().catch(() => undefined);
    queryClient.removeQueries({ queryKey: authKeys.me });
    setNoCompany(false);
  };

  if (noCompany) return <LoginNoCompany onBack={handleBackToLogin} />;

  return (
    <LoginBrandShell>
      <LoginForm onLogin={handleLogin} onSendCode={handleSendCode} onSucceeded={handleSucceeded} />
    </LoginBrandShell>
  );
}
