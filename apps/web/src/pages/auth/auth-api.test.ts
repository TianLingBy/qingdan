import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from '../../api/client';
import {
  authKeys,
  createAuthApi,
  describeLoginError,
  validateLoginForm,
} from './auth-api';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('认证接口', () => {
  it('登录 POST /auth/login，返回 employeeId/tenantId/displayName', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createAuthApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), init: init ?? {} });
          return jsonResponse(
            { employeeId: 'e1', tenantId: 't1', displayName: '张明' },
            200,
          );
        },
      }),
    );

    const result = await api.login({ phone: '10000000001', code: '000000' });

    expect(result.displayName).toBe('张明');
    expect(calls[0]?.url).toBe('/api/v1/auth/login');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"phone":"10000000001","code":"000000"}');
    // 会话靠 HttpOnly Cookie（D59⑦）：必须带凭据，否则跨源部署会丢会话
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('/auth/me 与登出路径正确，登出 204 返回 undefined', async () => {
    const urls: string[] = [];
    const api = createAuthApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: async (input) => {
          urls.push(String(input));
          if (String(input).endsWith('/auth/logout')) {
            return new Response(null, { status: 204 });
          }
          return jsonResponse(
            { employeeId: 'e1', tenantId: 't1', displayName: '张明', companyIds: [], scope: [] },
            200,
          );
        },
      }),
    );

    await api.me();
    const out = await api.logout();

    expect(urls).toEqual(['/api/v1/auth/me', '/api/v1/auth/logout']);
    expect(out).toBeUndefined();
    expect(authKeys.me).toEqual(['auth', 'me']);
  });
});

describe('登录表单校验', () => {
  it('空值分别提示', () => {
    expect(validateLoginForm({ phone: '', code: '' })).toEqual({
      phone: '请输入手机号',
      code: '请输入验证码',
    });
  });

  it('手机号必须 11 位数字', () => {
    expect(validateLoginForm({ phone: '1000000000', code: '000000' }).phone).toBe(
      '手机号需为 11 位数字',
    );
    expect(validateLoginForm({ phone: '1000000000a', code: '000000' }).phone).toBe(
      '手机号需为 11 位数字',
    );
    expect(validateLoginForm({ phone: '10000000001', code: '000000' })).toEqual({});
  });

  it('验证码 4–6 位数字', () => {
    expect(validateLoginForm({ phone: '10000000001', code: '000' }).code).toBe(
      '验证码需为 4–6 位数字',
    );
    expect(validateLoginForm({ phone: '10000000001', code: '0000000' }).code).toBe(
      '验证码需为 4–6 位数字',
    );
    expect(validateLoginForm({ phone: '10000000001', code: '0000' })).toEqual({});
  });
});

describe('登录错误文案', () => {
  it('401 统一提示，不暴露手机号是否存在', () => {
    const view = describeLoginError(
      new ApiError({ code: 'UNAUTHENTICATED', message: '未登录', status: 401 }),
    );
    expect(view.message).toContain('手机号或验证码不正确');
    expect(view.message).not.toContain('不存在');
    expect(view.field).toBeNull();
  });

  it('422 按 details.field 指到具体输入框', () => {
    const phone = describeLoginError(
      new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'phone 不合法',
        status: 422,
        details: { field: 'phone' },
      }),
    );
    expect(phone.field).toBe('phone');
    expect(phone.message).toContain('11 位数字');

    const code = describeLoginError(
      new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'code 不合法',
        status: 422,
        details: { issues: [{ path: 'code', message: 'too short' }] },
      }),
    );
    expect(code.field).toBe('code');
  });

  it('501 给出短信未开通的兜底文案（production）', () => {
    const view = describeLoginError(
      new ApiError({ code: 'NOT_IMPLEMENTED', message: '登录尚未接入短信服务商', status: 501 }),
    );
    expect(view.message).toContain('未开通短信服务');
  });

  it('网络/超时/取消分别有话术，且保留 requestId 便于查审计', () => {
    const network = describeLoginError(
      new ApiError({ code: 'NETWORK_ERROR', message: '网络请求失败', status: 0, requestId: 'req-1' }),
    );
    expect(network.message).toContain('网络异常');
    expect(network.requestId).toBe('req-1');

    expect(
      describeLoginError(new ApiError({ code: 'TIMEOUT', message: '请求超时', status: 0 })).message,
    ).toContain('超时');
    expect(
      describeLoginError(new ApiError({ code: 'REQUEST_ABORTED', message: '已取消', status: 0 }))
        .message,
    ).toContain('取消');
  });

  it('非 ApiError 也有兜底文案', () => {
    expect(describeLoginError(new Error('boom')).message).toBe('boom');
    expect(describeLoginError(undefined).message).toBe('登录失败，请稍后重试');
  });
});
