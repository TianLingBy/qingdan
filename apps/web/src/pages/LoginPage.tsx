/**
 * 页 1：登录（原型 `docs/prototype-v0.md` §2）。
 *
 * 一期口径（D54④）：账号由后台/初始化脚本创建，本页只做「手机号 + 验证码」登录；
 * 企业注册 / 入企三合一（邀请码 / 手机号白名单 / 老板预建）推迟到上线前，不放表单占位。
 * 开发与内测环境验证码为固定值或后台直发（文案里不做硬编码提示，避免误导）。
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ApiError } from '../api/client';
import { login, type LoginInput } from '../api/auth';
import { DEFAULT_ROUTE_PATH } from '../router/routes';
import { clearSessionCache } from '../session/session';
import { useQueryClient } from '@tanstack/react-query';
import { loginErrorText, validateLoginInput } from './login-form';

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ phone: string | null; code: string | null }>({
    phone: null,
    code: null,
  });
  const [submitError, setSubmitError] = useState<{ text: string; requestId: string | null } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const input: LoginInput = { phone: phone.trim(), code: code.trim() };
    const errors = validateLoginInput(input);
    setFieldErrors(errors);
    setSubmitError(null);
    if (errors.phone || errors.code) {
      return;
    }
    setSubmitting(true);
    try {
      await login(input);
      // 登录前门禁可能缓存了 401 错误态；清掉让门禁重新拉 /auth/me。
      clearSessionCache(queryClient);
      await navigate({ to: DEFAULT_ROUTE_PATH });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'REQUEST_ABORTED') {
        return; // 组件卸载/取消，不打扰
      }
      setSubmitError({
        text: loginErrorText(error),
        requestId: error instanceof ApiError ? error.requestId : null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-3xl font-semibold tracking-tight text-slate-900">轻单</div>
          <p className="mt-1 text-sm text-slate-500">集团内部交易与成本归集</p>
        </div>

        <form
          noValidate
          onSubmit={handleSubmit}
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <h1 className="text-lg font-semibold text-slate-900">登录</h1>
          <p className="mt-1 text-xs text-slate-500">使用管理员分配的手机号登录</p>

          <div className="mt-5 space-y-4">
            <div>
              <label htmlFor="login-phone" className="block text-sm font-medium text-slate-700">
                手机号
              </label>
              <input
                id="login-phone"
                name="phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                required
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                aria-invalid={fieldErrors.phone ? true : undefined}
                aria-describedby={fieldErrors.phone ? 'login-phone-error' : undefined}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 aria-invalid:border-red-400"
                placeholder="请输入手机号"
              />
              {fieldErrors.phone ? (
                <p id="login-phone-error" className="mt-1 text-xs text-red-600">
                  {fieldErrors.phone}
                </p>
              ) : null}
            </div>

            <div>
              <label htmlFor="login-code" className="block text-sm font-medium text-slate-700">
                验证码
              </label>
              <input
                id="login-code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-invalid={fieldErrors.code ? true : undefined}
                aria-describedby={fieldErrors.code ? 'login-code-error' : undefined}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 aria-invalid:border-red-400"
                placeholder="请输入验证码"
              />
              {fieldErrors.code ? (
                <p id="login-code-error" className="mt-1 text-xs text-red-600">
                  {fieldErrors.code}
                </p>
              ) : null}
            </div>
          </div>

          {submitError ? (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              <p>{submitError.text}</p>
              {submitError.requestId ? (
                <p className="mt-0.5 font-mono text-xs text-red-400">
                  追踪号 {submitError.requestId}
                </p>
              ) : null}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? '登录中…' : '登 录'}
          </button>

          <p className="mt-4 text-xs leading-5 text-slate-400">
            企业注册与入企邀请码暂未开放，账号由管理员统一创建。
          </p>
        </form>
      </div>
    </div>
  );
}
