import { describe, expect, it } from 'vitest';
import { AppError, CLI_EXIT, ERROR_CODES, ERROR_CODE_KEYS, cliExitFor, httpStatusFor } from './errors.js';
import { ApiErrorBodySchema } from './errors.js';
import { etagOf, parseIfMatch, MoneySchema, Money2Schema } from './envelope.js';

describe('错误码封闭枚举（D54 缺口 2）', () => {
  it('11 个错误码齐全且都有 HTTP 状态与 CLI 退出码', () => {
    expect(ERROR_CODE_KEYS).toHaveLength(11);
    for (const code of ERROR_CODE_KEYS) {
      expect(ERROR_CODES[code].status).toBeGreaterThanOrEqual(400);
      expect([1, 3, 4, 5]).toContain(ERROR_CODES[code].cliExit);
    }
  });

  it('关键映射符合 D54：422 校验 / 409 冲突 / 428 前置 / 429 限流', () => {
    expect(httpStatusFor('VALIDATION_FAILED')).toBe(422);
    expect(httpStatusFor('VERSION_CONFLICT')).toBe(409);
    expect(httpStatusFor('IDEMPOTENCY_CONFLICT')).toBe(409);
    expect(httpStatusFor('PRECONDITION_REQUIRED')).toBe(428);
    expect(httpStatusFor('RATE_LIMITED')).toBe(429);
    expect(cliExitFor('NOT_FOUND')).toBe(CLI_EXIT.VALIDATION);
    expect(cliExitFor('PRECONDITION_REQUIRED')).toBe(CLI_EXIT.VALIDATION);
    expect(cliExitFor('FORBIDDEN')).toBe(CLI_EXIT.FORBIDDEN);
    expect(cliExitFor('VERSION_CONFLICT')).toBe(CLI_EXIT.CONFLICT);
  });

  it('AppError 生成统一错误体', () => {
    const err = new AppError('NOT_FOUND', '没找到');
    expect(err.status).toBe(404);
    const body = err.toBody('req-1');
    expect(ApiErrorBodySchema.parse(body)).toEqual({ code: 'NOT_FOUND', message: '没找到', requestId: 'req-1' });
  });
});

describe('乐观锁与金额（D54 缺口 5 / D55）', () => {
  it('ETag 是强串，If-Match 解析出整数版本', () => {
    expect(etagOf(3)).toBe('"3"');
    expect(parseIfMatch('"3"')).toBe(3);
    expect(parseIfMatch('3')).toBe(3);
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch('abc')).toBeNull();
  });

  it('金额只能是 decimal 字符串（拒绝 number）', () => {
    expect(MoneySchema.safeParse('1234.567890').success).toBe(true);
    expect(MoneySchema.safeParse('-0.5').success).toBe(true);
    expect(MoneySchema.safeParse(1234).success).toBe(false);
    expect(MoneySchema.safeParse('1.1234567').success).toBe(false);
    expect(Money2Schema.safeParse('12.34').success).toBe(true);
    expect(Money2Schema.safeParse('12.345').success).toBe(false);
  });
});
