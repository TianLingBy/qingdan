/**
 * 登录表单纯逻辑测试（对应 `login-form.ts`）。
 *
 * 校验阈值与契约 `LoginInput`（phone 6-32、code 1-16）对齐；
 * 错误文案分支覆盖统一错误体各可预知错误码。
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { loginErrorText, validateLoginInput } from './login-form';

describe('validateLoginInput', () => {
  it('合法输入（手机号 11 位 + 验证码）无错误', () => {
    const errors = validateLoginInput({ phone: '10000000001', code: '1234' });
    expect(errors).toEqual({ phone: null, code: null });
  });

  it('首尾空白会被 trim 后再校验', () => {
    const errors = validateLoginInput({ phone: ' 10000000001 ', code: ' 1234 ' });
    expect(errors).toEqual({ phone: null, code: null });
  });

  it('空手机号提示「请输入手机号」', () => {
    expect(validateLoginInput({ phone: '   ', code: '1234' }).phone).toBe('请输入手机号');
  });

  it('手机号过短（<6 位）报格式错误', () => {
    expect(validateLoginInput({ phone: '12345', code: '1234' }).phone).toBe(
      '手机号格式不正确（6-32 位）',
    );
  });

  it('手机号过长（>32 位）报格式错误', () => {
    expect(validateLoginInput({ phone: '1'.repeat(33), code: '1234' }).phone).toBe(
      '手机号格式不正确（6-32 位）',
    );
  });

  it('边界值 6 位与 32 位手机号均合法', () => {
    expect(validateLoginInput({ phone: '1'.repeat(6), code: '1' }).phone).toBeNull();
    expect(validateLoginInput({ phone: '1'.repeat(32), code: '1' }).phone).toBeNull();
  });

  it('空验证码提示「请输入验证码」', () => {
    expect(validateLoginInput({ phone: '10000000001', code: '' }).code).toBe('请输入验证码');
  });

  it('验证码超长（>16 位）报格式错误；16 位合法', () => {
    expect(validateLoginInput({ phone: '10000000001', code: '1'.repeat(17) }).code).toBe(
      '验证码格式不正确（不超过 16 位）',
    );
    expect(validateLoginInput({ phone: '10000000001', code: '1'.repeat(16) }).code).toBeNull();
  });
});

describe('loginErrorText', () => {
  it('非 ApiError（网络层之外）回落到统一兜底文案', () => {
    expect(loginErrorText(new Error('boom'))).toBe('登录失败，请稍后重试');
    expect(loginErrorText(undefined)).toBe('登录失败，请稍后重试');
  });

  it('VALIDATION_FAILED 给口语化提示', () => {
    expect(
      loginErrorText(new ApiError({ code: 'VALIDATION_FAILED', message: 'x', status: 400 })),
    ).toBe('手机号或验证码格式不正确');
  });

  it('RATE_LIMITED 提示稍后再试', () => {
    expect(
      loginErrorText(new ApiError({ code: 'RATE_LIMITED', message: 'x', status: 429 })),
    ).toBe('尝试过于频繁，请稍后再试');
  });

  it('NOT_IMPLEMENTED（production 登录通道未配）提示未开通', () => {
    expect(
      loginErrorText(new ApiError({ code: 'NOT_IMPLEMENTED', message: 'x', status: 501 })),
    ).toBe('登录服务尚未开通（当前环境未配置登录通道）');
  });

  it('其它错误码（如 UNAUTHENTICATED 401 防枚举文案）以服务端 message 为主', () => {
    const error = new ApiError({
      code: 'UNAUTHENTICATED',
      message: '手机号或验证码不正确',
      status: 401,
    });
    expect(loginErrorText(error)).toBe('手机号或验证码不正确');
  });

  it('服务端 message 为空时回落兜底文案', () => {
    expect(
      loginErrorText(new ApiError({ code: 'INTERNAL', message: '', status: 500 })),
    ).toBe('登录失败，请稍后重试');
  });
});
