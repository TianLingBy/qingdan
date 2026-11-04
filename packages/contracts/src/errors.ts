import { z } from 'zod';

/**
 * 错误码封闭枚举（D54 缺口 2 由 Lead 冻结）。
 * - `status`：HTTP 状态码；
 * - `cliExit`：CLI 退出码（0 成功 / 2 用法 / 3 无权限 / 4 校验或不行前置 / 5 冲突 / 1 其它）。
 * 404 与 428 并入 CLI 退出码 4；429 / 5xx / 网络错误统一 1。
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: { status: 401, cliExit: 3, message: '未认证' },
  FORBIDDEN: { status: 403, cliExit: 3, message: '无权限' },
  AI_ACTION_FORBIDDEN: { status: 403, cliExit: 3, message: 'AI 不得直接执行该动作，需人类审批' },
  NOT_FOUND: { status: 404, cliExit: 4, message: '资源不存在' },
  VALIDATION_FAILED: { status: 422, cliExit: 4, message: '参数校验失败' },
  VERSION_CONFLICT: { status: 409, cliExit: 5, message: '版本冲突，请重新读取后重试' },
  IDEMPOTENCY_CONFLICT: { status: 409, cliExit: 5, message: '同一 Idempotency-Key 携带了不同的请求体' },
  PRECONDITION_REQUIRED: { status: 428, cliExit: 4, message: '缺少 If-Match 前置条件' },
  RATE_LIMITED: { status: 429, cliExit: 1, message: '请求过于频繁' },
  INTERNAL_ERROR: { status: 500, cliExit: 1, message: '服务内部错误' },
  /** 骨架占位：一期端点先在注册表登记，handler 可先返 501（D54 缺口 10）。 */
  NOT_IMPLEMENTED: { status: 501, cliExit: 1, message: '该接口尚未实现' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_KEYS = Object.keys(ERROR_CODES) as ErrorCode[];

export const CLI_EXIT = {
  SUCCESS: 0,
  OTHER: 1,
  USAGE: 2,
  FORBIDDEN: 3,
  VALIDATION: 4,
  CONFLICT: 5,
} as const;

export type CliExit = (typeof CLI_EXIT)[keyof typeof CLI_EXIT];

export function cliExitFor(code: ErrorCode): CliExit {
  return ERROR_CODES[code].cliExit;
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code].status;
}

/** 统一错误体（契约第三批 §3）。字段级错误放 details.issues[]。 */
export const ApiErrorBodySchema = z.object({
  code: z.enum(ERROR_CODE_KEYS as [ErrorCode, ...ErrorCode[]]),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? ERROR_CODES[code].message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return httpStatusFor(this.code);
  }

  toBody(requestId: string): ApiErrorBody {
    const body: ApiErrorBody = { code: this.code, message: this.message, requestId };
    if (this.details) body.details = this.details;
    return body;
  }
}
