import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SmsConfig } from '../config.js';
import { createTencentSmsSender, SmsNotConfiguredError, unconfiguredSmsSender } from './tencent.js';

/**
 * 腾讯云短信 provider 的结构性测试：用假 fetch 截获请求，确认
 * TC3-HMAC-SHA256 签名头、请求体字段、错误映射都对。
 * 真实短信（真实密钥 + 真实手机号）不在自动化测试覆盖范围，见 PR 说明。
 */

const CONFIG: SmsConfig = {
  secretId: 'AKIDtestSecretId',
  secretKey: 'testSecretKey',
  sdkAppId: '1400000001',
  signName: '轻单',
  templateId: '2000001',
  region: 'ap-guangzhou',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('腾讯云短信 provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('发送登录验证码：TC3 签名头、请求体与模板参数都正确', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Response: { SendStatusSet: [{ Code: 'Ok' }] } }));
    vi.stubGlobal('fetch', fetchMock);

    const sender = createTencentSmsSender(CONFIG);
    await sender.sendLoginCode({ phone: '10000000001', code: '123456', expiresMinutes: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sms.tencentcloudapi.com');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-TC-Action']).toBe('SendSms');
    expect(headers['X-TC-Version']).toBe('2021-01-11');
    expect(headers['X-TC-Region']).toBe('ap-guangzhou');
    // 签名头格式：TC3-HMAC-SHA256 Credential=<secretId>/<date>/sms/tc3_request, ...
    expect(headers.Authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=AKIDtestSecretId\/\d{4}-\d{2}-\d{2}\/sms\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/,
    );

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.PhoneNumberSet).toEqual(['+8610000000001']);
    expect(body.SmsSdkAppId).toBe('1400000001');
    expect(body.SignName).toBe('轻单');
    expect(body.TemplateId).toBe('2000001');
    expect(body.TemplateParamSet).toEqual(['123456', '5']);
  });

  it('腾讯云业务错误映射成带错误码的异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ Response: { Error: { Code: 'AuthFailure', Message: '签名错误' } } })),
    );

    await expect(
      createTencentSmsSender(CONFIG).sendLoginCode({ phone: '10000000001', code: '123456', expiresMinutes: 5 }),
    ).rejects.toThrow('腾讯云短信 AuthFailure：签名错误');
  });

  it('SendStatusSet 非 Ok 视为发送失败', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ Response: { SendStatusSet: [{ Code: 'LimitExceeded.PhoneNumberDailyLimit', Message: '超限' }] } }),
      ),
    );

    await expect(
      createTencentSmsSender(CONFIG).sendLoginCode({ phone: '10000000001', code: '123456', expiresMinutes: 5 }),
    ).rejects.toThrow('腾讯云短信发送失败：LimitExceeded.PhoneNumberDailyLimit:超限');
  });

  it('HTTP 非 2xx 直接抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));

    await expect(
      createTencentSmsSender(CONFIG).sendLoginCode({ phone: '10000000001', code: '123456', expiresMinutes: 5 }),
    ).rejects.toThrow('腾讯云短信 HTTP 502');
  });

  it('未配置的发送器明确抛 SmsNotConfiguredError', async () => {
    await expect(
      unconfiguredSmsSender.sendLoginCode({ phone: '10000000001', code: '123456', expiresMinutes: 5 }),
    ).rejects.toBeInstanceOf(SmsNotConfiguredError);
  });
});
