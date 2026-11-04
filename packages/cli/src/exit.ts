import { CLI_EXIT, ERROR_CODES, cliExitFor, type ErrorCode } from '@qingdan/contracts';

/**
 * HTTP 状态 → CLI 退出码（与 ERROR_CODES.cliExit 同口径，D54 缺口 2）。
 * 404 / 428 并入 4；429 与 5xx 并入 1；网络错误（无状态）与未知异常 → 1。
 */
const STATUS_EXIT: Readonly<Record<number, number>> = {
  401: CLI_EXIT.FORBIDDEN,
  403: CLI_EXIT.FORBIDDEN,
  404: CLI_EXIT.VALIDATION,
  409: CLI_EXIT.CONFLICT,
  422: CLI_EXIT.VALIDATION,
  428: CLI_EXIT.VALIDATION,
  429: CLI_EXIT.OTHER,
  500: CLI_EXIT.OTHER,
  501: CLI_EXIT.OTHER,
};

/** 纯映射：错误码优先（注册表是权威），其次 HTTP 状态，最后兜底 1。 */
export function exitCodeForFailure(status?: number, code?: string): number {
  if (code !== undefined && code in ERROR_CODES) return cliExitFor(code as ErrorCode);
  if (status !== undefined && STATUS_EXIT[status] !== undefined) return STATUS_EXIT[status];
  return CLI_EXIT.OTHER;
}
