import { AppError } from '@qingdan/contracts';
import { verify as cryptoVerify } from 'node:crypto';
import type { AlipayMerchantConfig } from './merchant-config.js';

/**
 * 支付宝异步通知验签（#101）。
 *
 * 待签名串：除 `sign` / `sign_type` 外的业务参数按**键名**字典序，
 * 以 `k=v` 用 `&` 拼接；值保持回调表单原文，不做 URL encode。
 * 签名算法固定 RSA2（SHA256WithRSA），公钥来自商户配置的 `alipayPublicKeyPem`。
 *
 * 验签失败统一 401（回调匿名可达）；底层异常信息不透出。
 */

export type AlipayCallbackForm = Readonly<Record<string, string | undefined>>;

export interface AlipayCallbackInput {
  readonly form: AlipayCallbackForm;
  readonly config: AlipayMerchantConfig;
}

export interface AlipayCallbackResult {
  readonly outTradeNo: string;
  /** 支付宝交易号。 */
  readonly tradeNo: string;
  /** 订单金额，元，字符串原样（如 `12.34`）。 */
  readonly totalAmount: string;
  readonly tradeStatus: string;
}

const SIGNATURE_ERROR = '支付宝回调验签失败';

export function buildAlipaySignContent(form: AlipayCallbackForm): string {
  return Object.entries(form)
    .filter(([key, value]) => key !== 'sign' && key !== 'sign_type' && value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function requireField(form: AlipayCallbackForm, field: string): string {
  const value = form[field];
  if (typeof value !== 'string' || value === '') {
    throw new AppError('VALIDATION_FAILED', `支付宝回调缺少字段：${field}`, { field });
  }
  return value;
}

export function verifyAlipayCallback({
  form,
  config,
}: AlipayCallbackInput): AlipayCallbackResult {
  const sign = form.sign;
  if (typeof sign !== 'string' || sign === '') {
    throw new AppError('UNAUTHENTICATED', SIGNATURE_ERROR);
  }

  const content = buildAlipaySignContent(form);
  let verified: boolean;
  try {
    verified = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(content, 'utf8'),
      config.alipayPublicKeyPem,
      Buffer.from(sign, 'base64'),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new AppError('UNAUTHENTICATED', SIGNATURE_ERROR);
  }

  return {
    outTradeNo: requireField(form, 'out_trade_no'),
    tradeNo: requireField(form, 'trade_no'),
    totalAmount: requireField(form, 'total_amount'),
    tradeStatus: requireField(form, 'trade_status'),
  };
}
