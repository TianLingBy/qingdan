/**
 * 登录表单纯逻辑（无 React，供 vitest 直接断言）。
 *
 * 校验阈值与契约 `LoginInput`（`packages/contracts/src/routes.ts`）对齐：
 *   phone 6-32 位、code 1-16 位。客户端只做格式提示，真源是服务端
 *   `VALIDATION_FAILED`；登录失败文案统一走服务端 message（防枚举，
 *   未知手机号与非在职同一文案，D14）。
 */

import { ApiError } from '../api/client';

export interface LoginFieldErrors {
  phone: string | null;
  code: string | null;
}

export function validateLoginInput(input: { phone: string; code: string }): LoginFieldErrors {
  const phone = input.phone.trim();
  const code = input.code.trim();
  return {
    phone:
      phone.length === 0
        ? '请输入手机号'
        : phone.length < 6 || phone.length > 32
          ? '手机号格式不正确（6-32 位）'
          : null,
    code:
      code.length === 0
        ? '请输入验证码'
        : code.length > 16
          ? '验证码格式不正确（不超过 16 位）'
          : null,
  };
}

const FALLBACK_LOGIN_ERROR = '登录失败，请稍后重试';

/**
 * 登录失败的展示文案。服务端返回统一错误体时以 message 为主（防枚举文案由服务端定），
 * 客户端只对可预知的错误码给更口语化的提示；网络层失败用客户端自己的 message。
 */
export function loginErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return FALLBACK_LOGIN_ERROR;
  }
  switch (error.code) {
    case 'VALIDATION_FAILED':
      return '手机号或验证码格式不正确';
    case 'RATE_LIMITED':
      return '尝试过于频繁，请稍后再试';
    case 'NOT_IMPLEMENTED':
      return '登录服务尚未开通（当前环境未配置登录通道）';
    default:
      return error.message.length > 0 ? error.message : FALLBACK_LOGIN_ERROR;
  }
}
