import { createHash, createHmac } from 'node:crypto';
import type { SmsConfig } from '../config.js';

/**
 * 短信发送端口（D59③）。
 *
 * 为什么要一个接口：用例层只关心「把验证码发出去」，测试要能注入假发送器，
 * 生产接腾讯云。配置缺失时用 `unconfiguredSmsSender` 明确抛错，绝不静默吞掉。
 */

export interface SendLoginCodeInput {
  readonly phone: string;
  readonly code: string;
  readonly expiresMinutes: number;
}

export interface SmsSender {
  sendLoginCode(input: SendLoginCodeInput): Promise<void>;
}

/** 配置缺失：生产环境发码时抛出，由路由层映射成明确的 501。 */
export class SmsNotConfiguredError extends Error {
  constructor() {
    super(
      '短信服务未配置：请提供 TENCENT_SMS_SECRET_ID / SECRET_KEY / SDK_APP_ID / SIGN_NAME / TEMPLATE_ID',
    );
    this.name = 'SmsNotConfiguredError';
  }
}

export const unconfiguredSmsSender: SmsSender = {
  async sendLoginCode() {
    throw new SmsNotConfiguredError();
  },
};

const ENDPOINT = 'sms.tencentcloudapi.com';
const SERVICE = 'sms';
const API_VERSION = '2021-01-11';
const ACTION = 'SendSms';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

interface TencentResponse {
  Response?: {
    Error?: { Code?: string; Message?: string };
    SendStatusSet?: ReadonlyArray<{ Code?: string; Message?: string }>;
  };
}

/**
 * 腾讯云短信 TC3-HMAC-SHA256 签名调用（不引入 SDK，Node 内置 fetch 足够）。
 * 文档：https://cloud.tencent.com/document/api/382/52072
 */
export function createTencentSmsSender(config: SmsConfig): SmsSender {
  async function call(params: Record<string, unknown>): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const payload = JSON.stringify(params);
    const hashedPayload = sha256Hex(payload);
    const canonicalHeaders =
      'content-type:application/json; charset=utf-8\n' +
      `host:${ENDPOINT}\n` +
      `x-tc-action:${ACTION.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = [
      'POST',
      '/',
      '',
      canonicalHeaders,
      signedHeaders,
      hashedPayload,
    ].join('\n');
    const credentialScope = `${date}/${SERVICE}/tc3_request`;
    const stringToSign = [
      'TC3-HMAC-SHA256',
      String(timestamp),
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const secretDate = hmac(`TC3${config.secretKey}`, date);
    const secretService = hmac(secretDate, SERVICE);
    const secretSigning = hmac(secretService, 'tc3_request');
    const signature = createHmac('sha256', secretSigning)
      .update(stringToSign, 'utf8')
      .digest('hex');
    const authorization =
      `TC3-HMAC-SHA256 Credential=${config.secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetch(`https://${ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-TC-Action': ACTION,
        'X-TC-Version': API_VERSION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': config.region,
        Authorization: authorization,
      },
      body: payload,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`腾讯云短信 HTTP ${response.status}：${text.slice(0, 300)}`);
    }
    let body: TencentResponse;
    try {
      body = JSON.parse(text) as TencentResponse;
    } catch {
      throw new Error(`腾讯云短信返回非 JSON：${text.slice(0, 300)}`);
    }
    const error = body.Response?.Error;
    if (error) {
      throw new Error(`腾讯云短信 ${error.Code ?? 'UNKNOWN'}：${error.Message ?? '未知错误'}`);
    }
    const failed = (body.Response?.SendStatusSet ?? []).filter((item) => item.Code !== 'Ok');
    if (failed.length > 0) {
      const detail = failed
        .map((item) => `${item.Code ?? 'UNKNOWN'}:${item.Message ?? ''}`)
        .join('; ');
      throw new Error(`腾讯云短信发送失败：${detail}`);
    }
  }

  return {
    async sendLoginCode(input: SendLoginCodeInput): Promise<void> {
      await call({
        PhoneNumberSet: [`+86${input.phone}`],
        SmsSdkAppId: config.sdkAppId,
        SignName: config.signName,
        TemplateId: config.templateId,
        // 模板占位符顺序：{1} 验证码、{2} 有效期分钟数，需与后台模板一致。
        TemplateParamSet: [input.code, String(input.expiresMinutes)],
      });
    },
  };
}
