import { AppError } from '@qingdan/contracts';
import { createDecipheriv, verify as cryptoVerify } from 'node:crypto';
import type { WechatMerchantConfig } from './merchant-config.js';

/**
 * 微信支付回调验签 + 解密（#101）。
 *
 * 流程（微信支付 API v3）：
 * 1. 用 `Wechatpay-Timestamp\nWechatpay-Nonce\nrawBody\n` 对 `Wechatpay-Signature`
 *    做 RSA-SHA256 验签，公钥来自商户配置的 `platformPublicKeyPem`；
 * 2. 验签通过后用 `apiV3Key` 对 `resource` 做 AES-256-GCM 解密
 *    （密文尾部 16 字节为 GCM auth tag）。
 *
 * 任何验签 / 解密失败都返回 401：回调匿名可达，不能把「签名不对」当成参数错误，
 * 也不把底层异常信息（可能含报文片段）透给调用方。
 */

export type CallbackHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export interface WechatCallbackInput {
  readonly headers: CallbackHeaders;
  readonly rawBody: string;
  readonly config: WechatMerchantConfig;
}

export interface WechatCallbackResult {
  readonly outTradeNo: string;
  /** 微信支付交易号。 */
  readonly transactionId: string;
  /** 金额，单位「分」；调用方转 decimal 字符串时除以 100 并保留两位。 */
  readonly amountTotalFen: number;
  readonly successTime: string | null;
  readonly tradeState: string;
}

const SIGNATURE_ERROR = '微信回调验签失败';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 头名大小写不敏感；重复头取第一个。 */
function header(headers: CallbackHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === 'string') return value;
    return value?.[0];
  }
  return undefined;
}

interface EncryptedResource {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly associatedData: string;
}

function parseResource(rawBody: string): EncryptedResource {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new AppError('UNAUTHENTICATED', SIGNATURE_ERROR);
  }

  const resource = isRecord(body) ? body.resource : undefined;
  if (!isRecord(resource)) {
    throw new AppError('UNAUTHENTICATED', SIGNATURE_ERROR);
  }

  const { ciphertext, nonce, associated_data: associatedData } = resource;
  if (
    typeof ciphertext !== 'string' ||
    typeof nonce !== 'string' ||
    typeof associatedData !== 'string'
  ) {
    throw new AppError('UNAUTHENTICATED', SIGNATURE_ERROR);
  }
  return { ciphertext, nonce, associatedData };
}

function decryptResource(resource: EncryptedResource, apiV3Key: string): unknown {
  let plaintext: string;
  try {
    const data = Buffer.from(resource.ciphertext, 'base64');
    if (data.length <= 16) throw new Error('ciphertext too short');

    const tag = data.subarray(data.length - 16);
    const encrypted = data.subarray(0, data.length - 16);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(apiV3Key, 'utf8'),
      Buffer.from(resource.nonce, 'utf8'),
    );
    decipher.setAAD(Buffer.from(resource.associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    // 不拼接底层异常：避免把密文 / 密钥长度等细节带进响应。
    throw new AppError('UNAUTHENTICATED', '微信回调解密失败');
  }

  try {
    return JSON.parse(plaintext);
  } catch {
    throw new AppError('UNAUTHENTICATED', '微信回调解密失败');
  }
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value === '') {
    throw new AppError('VALIDATION_FAILED', `微信回调缺少字段：${field}`, { field });
  }
  return value;
}

export function verifyWechatCallback({
  headers,
  rawBody,
  config,
}: WechatCallbackInput): WechatCallbackResult {
  const timestamp = header(headers, 'Wechatpay-Timestamp');
  const nonce = header(headers, 'Wechatpay-Nonce');
  const signature = header(headers, 'Wechatpay-Signature');
  const serial = header(headers, 'Wechatpay-Serial');
  if (!timestamp || !nonce || !signature || !serial) {
    throw new AppError('UNAUTHENTICATED', SIGNATURE_ERROR);
  }

  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  let verified = false;
  try {
    verified = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(message, 'utf8'),
      config.platformPublicKeyPem,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new AppError('UNAUTHENTICATED', SIGNATURE_ERROR);
  }

  const resource = parseResource(rawBody);
  const payload = decryptResource(resource, config.apiV3Key);
  if (!isRecord(payload)) {
    throw new AppError('VALIDATION_FAILED', '微信回调解密内容不是 JSON 对象');
  }

  const outTradeNo = requireString(payload, 'out_trade_no');
  const transactionId = requireString(payload, 'transaction_id');
  const tradeState = requireString(payload, 'trade_state');

  const amount = payload.amount;
  const amountTotalFen = isRecord(amount) ? amount.total : undefined;
  if (
    typeof amountTotalFen !== 'number' ||
    !Number.isSafeInteger(amountTotalFen) ||
    amountTotalFen < 0
  ) {
    throw new AppError('VALIDATION_FAILED', '微信回调金额非法（amount.total）', {
      field: 'amount.total',
    });
  }

  const successTime = typeof payload.success_time === 'string' ? payload.success_time : null;

  return { outTradeNo, transactionId, amountTotalFen, successTime, tradeState };
}
