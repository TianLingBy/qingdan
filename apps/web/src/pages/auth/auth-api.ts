import type { ScopeMatrix } from '@qingdan/contracts';
import type { ApiClient } from '../../api/client';
import { ApiError, apiClient } from '../../api/client';

/**
 * 认证域接口（/api/v1/auth/*），唯一真源见 `apps/api/src/modules/platform/routes.ts`。
 *
 * 会话形态（D59⑦）：登录成功由服务端下发 `qingdan_session` HttpOnly Cookie，
 * 前端**读不到也不需要读**；请求带 `credentials: 'include'` 即可（见 `api/client.ts`）。
 */

export interface MeResponse {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly companyIds: string[];
  /** 功能域 × 动作；前端只做显隐，判定一律以后端为准（D4/D15/D27）。 */
  readonly scope: ScopeMatrix;
}

export interface LoginInput {
  readonly phone: string;
  readonly code: string;
}

export interface LoginResult {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
}

export function createAuthApi(client: ApiClient = apiClient) {
  return {
    login: (input: LoginInput) => client.post<LoginResult>('/auth/login', input),
    me: () => client.get<MeResponse>('/auth/me'),
    /** 幂等：重复登出也成功（服务端 204）。 */
    logout: () => client.post<void>('/auth/logout'),
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
export const authApi = createAuthApi();

export const authKeys = {
  me: ['auth', 'me'] as const,
};

/* ------------------------------ 表单校验 ------------------------------ */

/** 一期手机号口径：11 位数字（服务端只校验长度 6–32，前端按业务口径更严）。 */
export const PHONE_PATTERN = /^\d{11}$/;
/** 验证码：非生产固定 6 位（`LOGIN_DEV_CODE` 默认 000000），兼容 4–6 位输入。 */
export const CODE_PATTERN = /^\d{4,6}$/;

export type LoginField = 'phone' | 'code';

export interface LoginFieldErrors {
  readonly phone?: string;
  readonly code?: string;
}

/** 纯前端校验：只挡明显错误，真正的判定交给服务端（422 / 401）。 */
export function validateLoginForm(input: LoginInput): LoginFieldErrors {
  const errors: { phone?: string; code?: string } = {};
  if (input.phone.length === 0) {
    errors.phone = '请输入手机号';
  } else if (!PHONE_PATTERN.test(input.phone)) {
    errors.phone = '手机号需为 11 位数字';
  }
  if (input.code.length === 0) {
    errors.code = '请输入验证码';
  } else if (!CODE_PATTERN.test(input.code)) {
    errors.code = '验证码需为 4–6 位数字';
  }
  return errors;
}

/* ------------------------------ 错误展示 ------------------------------ */

export interface LoginErrorView {
  /** 给人看的提示，不含任何「手机号是否存在」的信号。 */
  readonly message: string;
  /** 需要标红的输入框；null 表示整表提示（如网络错误、验证码错）。 */
  readonly field: LoginField | null;
  /** 便于按审计日志排查；界面上一并展示。 */
  readonly requestId: string | null;
}

const FALLBACK_ERROR: LoginErrorView = {
  message: '登录失败，请稍后重试',
  field: null,
  requestId: null,
};

function readField(details: unknown): LoginField | null {
  if (typeof details !== 'object' || details === null) return null;
  const record = details as Record<string, unknown>;
  const direct = record.field;
  if (direct === 'phone' || direct === 'code') return direct;
  // 服务端另一种形态：details.issues[].path
  const issues = record.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      if (typeof issue === 'object' && issue !== null) {
        const path = (issue as Record<string, unknown>).path;
        if (path === 'phone' || path === 'code') return path;
      }
    }
  }
  return null;
}

/**
 * 把任意错误翻译成人能看懂的提示（验收标准逐条对应）：
 *   - 401 UNAUTHENTICATED：手机号不存在 / 非在职 / 租户停用 / 验证码错 —— 服务端不区分，前端也不能区分；
 *   - 422 VALIDATION_FAILED：按 details 指到具体输入框；
 *   - 501 NOT_IMPLEMENTED：production 未接短信服务商的兜底文案，不白屏、不无限转圈。
 */
export function describeLoginError(error: unknown): LoginErrorView {
  if (!(error instanceof ApiError)) {
    if (error instanceof Error && error.message.length > 0) {
      return { message: error.message, field: null, requestId: null };
    }
    return FALLBACK_ERROR;
  }

  const requestId = error.requestId;

  if (error.code === 'UNAUTHENTICATED' || error.status === 401) {
    return { message: '手机号或验证码不正确，请重新输入', field: null, requestId };
  }

  if (error.code === 'VALIDATION_FAILED' || error.status === 422) {
    const field = readField(error.details);
    if (field === 'phone') {
      return { message: '手机号格式不正确（11 位数字）', field, requestId };
    }
    if (field === 'code') {
      return { message: '验证码格式不正确（4–6 位数字）', field, requestId };
    }
    return { message: '提交内容不合法，请检查后重试', field: null, requestId };
  }

  if (error.code === 'NOT_IMPLEMENTED' || error.status === 501) {
    return {
      message: '当前环境未开通短信服务，验证码登录暂不可用，请联系管理员或改用测试环境',
      field: null,
      requestId,
    };
  }

  if (error.code === 'TIMEOUT') {
    return { message: '请求超时，请重试', field: null, requestId };
  }

  if (error.code === 'NETWORK_ERROR') {
    return { message: '网络异常，请检查网络后重试', field: null, requestId };
  }

  if (error.code === 'REQUEST_ABORTED') {
    return { message: '请求已取消', field: null, requestId };
  }

  return { message: error.message.length > 0 ? error.message : FALLBACK_ERROR.message, field: null, requestId };
}
