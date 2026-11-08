import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { DEFAULT_ROUTE_PATH } from '../../router/routes';
import {
  authApi,
  authKeys,
  describeLoginError,
  validateLoginForm,
  type LoginErrorView,
  type LoginField,
  type LoginFieldErrors,
  type LoginInput,
} from './auth-api';

/**
 * 登录页（IA 第 1 页 / #4）。
 *
 * 口径：
 *   - 视觉基线 `design/轻单登录页.html`（黑白品牌区 + 右侧表单，窄屏只留表单）；
 *   - 会话是 HttpOnly Cookie，前端不做 token 管理，登录后靠 `GET /auth/me` 确认再进工作台；
 *   - 错误按统一错误体的 `code` 分支展示，绝不提示「手机号是否存在」（服务端 401 不区分原因）。
 *
 * 拆成三层便于测试：`LoginBrandShell`（纯版式）→ `LoginForm`（表单状态机）→ `LoginPage`（接线）。
 */

const FIELD_CLASS =
  'mt-1.5 h-11 w-full rounded-lg border px-3 text-sm text-neutral-900 outline-none transition ' +
  'placeholder:text-neutral-400 focus:border-neutral-900 focus:shadow-[0_0_0_3px_rgba(23,23,23,0.10)] ' +
  'disabled:bg-neutral-100';

function fieldClass(invalid: boolean): string {
  return `${FIELD_CLASS} ${invalid ? 'border-red-500' : 'border-neutral-300'}`;
}

/** 登录失败提示：文案 + 请求编号（排查审计日志用）。 */
export function LoginErrorAlert({ error }: { error: LoginErrorView }) {
  return (
    <div className="mt-5 rounded-lg bg-red-50 px-3 py-2.5" role="alert">
      <p className="text-sm text-red-700">{error.message}</p>
      {error.requestId && (
        <p className="mt-1 font-mono text-[11px] text-red-400">请求编号 {error.requestId}</p>
      )}
    </div>
  );
}

/** 版式壳：左侧品牌区（≤ 768px 隐藏）+ 右侧表单区。 */
export function LoginBrandShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-white">
      <aside className="hidden w-[42%] shrink-0 flex-col justify-between bg-neutral-950 p-11 text-neutral-100 md:flex">
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-semibold tracking-tight">轻单</span>
          <span className="text-xs uppercase tracking-[0.2em] text-neutral-400">QINGDAN</span>
        </div>

        <div>
          <h2 className="text-[30px] font-semibold leading-[1.4] tracking-tight">
            每一笔内部交易，
            <br />
            都算得清成本。
          </h2>
          <p className="mt-4 max-w-[34em] text-sm leading-7 text-neutral-400">
            采购、加工、销售、内部交易与结算，一套口径跑通；权限服务端判定，数据只给该看的人。
          </p>
        </div>

        <div className="border-t border-neutral-800 pt-4 text-xs text-neutral-400">
          集团内部交易与成本归集 · 内部系统
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[360px]">{children}</div>
      </main>
    </div>
  );
}

export interface LoginFormProps {
  /** 提交登录；抛错时由表单翻译成人话。成功 resolve 视为登录成功。 */
  readonly onLogin: (input: LoginInput) => Promise<void>;
  /** 登录成功、提示已显示之后的回调（由外层负责跳转）。 */
  readonly onSucceeded?: () => void;
}

export function LoginForm({ onLogin, onSucceeded }: LoginFormProps) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [formError, setFormError] = useState<LoginErrorView | null>(null);
  const [pending, setPending] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  const busy = pending || succeeded;

  const clearFieldError = (field: LoginField) => {
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const input: LoginInput = { phone: phone.trim(), code: code.trim() };
    const errors = validateLoginForm(input);
    setFieldErrors(errors);
    setFormError(null);
    if (errors.phone || errors.code) return;

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
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">登录</h1>
      <p className="mt-2 text-sm text-neutral-500">使用管理员分配的手机号登录</p>

      <form className="mt-8" onSubmit={handleSubmit} noValidate>
        <div>
          <label htmlFor="phone" className="block text-sm font-medium text-neutral-700">
            手机号
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            maxLength={11}
            placeholder="请输入手机号"
            value={phone}
            disabled={busy}
            aria-invalid={Boolean(fieldErrors.phone)}
            aria-describedby={fieldErrors.phone ? 'phone-error' : undefined}
            onChange={(event) => {
              setPhone(event.target.value);
              clearFieldError('phone');
            }}
            className={fieldClass(Boolean(fieldErrors.phone))}
          />
          {fieldErrors.phone && (
            <p id="phone-error" className="mt-1.5 text-xs text-red-600">
              {fieldErrors.phone}
            </p>
          )}
        </div>

        <div className="mt-5">
          <label htmlFor="code" className="block text-sm font-medium text-neutral-700">
            验证码
          </label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="请输入验证码"
            value={code}
            disabled={busy}
            aria-invalid={Boolean(fieldErrors.code)}
            aria-describedby={fieldErrors.code ? 'code-error' : undefined}
            onChange={(event) => {
              setCode(event.target.value);
              clearFieldError('code');
            }}
            className={fieldClass(Boolean(fieldErrors.code))}
          />
          {fieldErrors.code && (
            <p id="code-error" className="mt-1.5 text-xs text-red-600">
              {fieldErrors.code}
            </p>
          )}
        </div>

        {formError && <LoginErrorAlert error={formError} />}

        {succeeded && (
          <p
            className="mt-5 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700"
            role="status"
          >
            登录成功，正在进入工作台…
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 h-11 w-full rounded-lg bg-neutral-950 text-sm font-medium tracking-[0.1em] text-white transition hover:-translate-y-0.5 hover:bg-neutral-800 hover:shadow-[0_10px_20px_rgba(0,0,0,0.18)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-950 active:translate-y-0 disabled:translate-y-0 disabled:opacity-60 disabled:hover:shadow-none"
        >
          {pending ? '登录中…' : '登 录'}
        </button>
      </form>

      <p className="mt-7 border-t border-neutral-200 pt-4 text-xs leading-6 text-neutral-500">
        企业注册与入企暂未开放（一期），账号由管理员统一创建。
        <br />
        测试环境演示账号 10000000001，验证码 000000。
      </p>
    </>
  );
}

/** 页面接线：登录成功 → 写回 me 缓存 → 进工作台（#5）。 */
export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const handleLogin = async (input: LoginInput) => {
    // Cookie 落地后再取 /auth/me，一次拿全 companyIds / scope。
    await authApi.login(input);
    const me = await authApi.me();
    queryClient.setQueryData(authKeys.me, me);
  };

  const handleSucceeded = () => {
    // 留一拍让「登录成功」被看见，再进工作台。
    window.setTimeout(() => {
      void navigate({ to: DEFAULT_ROUTE_PATH });
    }, 500);
  };

  return (
    <LoginBrandShell>
      <LoginForm onLogin={handleLogin} onSucceeded={handleSucceeded} />
    </LoginBrandShell>
  );
}
