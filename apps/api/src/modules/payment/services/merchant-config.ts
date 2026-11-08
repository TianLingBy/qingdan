import { AppError } from '@qingdan/contracts';
import type { PaymentChannel } from '@qingdan/contracts';
import { z } from 'zod';

/**
 * 支付商户配置读取（#101，商户模式 A）。
 *
 * 配置整体放在一个环境变量里，按公司 + 渠道取用：
 * `QINGDAN_PAYMENT_CONFIG={"<companyId>":{"wechat":{...},"alipay":{...}}}`
 *
 * 约束：
 * - 缺配置 / 字段不全一律 `VALIDATION_FAILED`，错误信息只列**字段名**，
 *   绝不回显密钥内容，也不写日志；
 * - 密钥只在调用方进程内使用（验签 / 解密），不进入审计与响应。
 */

export interface WechatMerchantConfig {
  readonly mchId: string;
  readonly apiV3Key: string;
  readonly platformPublicKeyPem: string;
  readonly appId: string;
}

export interface AlipayMerchantConfig {
  readonly appId: string;
  readonly alipayPublicKeyPem: string;
  readonly privateKeyPem: string;
}

/** 字段非空即可；不做 trim，避免改动 PEM / 密钥原文。 */
const nonEmptyString = z.string().refine((value) => value.trim() !== '', '不能为空');

const WechatConfigSchema = z.object({
  mchId: nonEmptyString,
  apiV3Key: nonEmptyString,
  platformPublicKeyPem: nonEmptyString,
  appId: nonEmptyString,
});

const AlipayConfigSchema = z.object({
  appId: nonEmptyString,
  alipayPublicKeyPem: nonEmptyString,
  privateKeyPem: nonEmptyString,
});

const CONFIG_ENV = 'QINGDAN_PAYMENT_CONFIG';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEnvConfig(): Record<string, unknown> {
  const raw = process.env[CONFIG_ENV];
  if (raw === undefined || raw.trim() === '') {
    throw new AppError('VALIDATION_FAILED', `缺少支付商户配置：环境变量 ${CONFIG_ENV} 未设置`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 静态文案：JSON 原文可能含密钥，不能带进错误信息。
    throw new AppError('VALIDATION_FAILED', `环境变量 ${CONFIG_ENV} 不是合法 JSON`);
  }

  if (!isRecord(parsed)) {
    throw new AppError('VALIDATION_FAILED', `环境变量 ${CONFIG_ENV} 必须是 JSON 对象`);
  }
  return parsed;
}

export function readMerchantConfig(companyId: string, channel: 'wechat'): WechatMerchantConfig;
export function readMerchantConfig(companyId: string, channel: 'alipay'): AlipayMerchantConfig;
export function readMerchantConfig(
  companyId: string,
  channel: PaymentChannel,
): WechatMerchantConfig | AlipayMerchantConfig;
export function readMerchantConfig(
  companyId: string,
  channel: PaymentChannel,
): WechatMerchantConfig | AlipayMerchantConfig {
  if (channel !== 'wechat' && channel !== 'alipay') {
    throw new AppError('VALIDATION_FAILED', `未知支付渠道：${String(channel)}`);
  }

  const companies = readEnvConfig();
  const company = companies[companyId];
  if (!isRecord(company)) {
    throw new AppError('VALIDATION_FAILED', `公司 ${companyId} 未配置 ${channel} 支付商户信息`, {
      companyId,
      channel,
    });
  }

  const section = company[channel];
  if (!isRecord(section)) {
    throw new AppError('VALIDATION_FAILED', `公司 ${companyId} 未配置 ${channel} 支付商户信息`, {
      companyId,
      channel,
    });
  }

  const parsed =
    channel === 'wechat'
      ? WechatConfigSchema.safeParse(section)
      : AlipayConfigSchema.safeParse(section);
  if (!parsed.success) {
    // 只取字段路径；zod 的 issue 不会携带输入值，这里也不拼接 section 原文。
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
    throw new AppError(
      'VALIDATION_FAILED',
      `${channel} 支付商户配置缺少或非法字段：${fields.join('、')}`,
      { companyId, channel, fields },
    );
  }

  return parsed.data;
}
