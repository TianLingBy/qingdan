import { AppError } from '@qingdan/contracts';
import { createCipheriv, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAlipaySignContent, verifyAlipayCallback } from './alipay-signature.js';
import {
  readMerchantConfig,
  type AlipayMerchantConfig,
  type WechatMerchantConfig,
} from './merchant-config.js';
import { verifyWechatCallback } from './wechat-signature.js';

/**
 * 支付回调验签 / 解密纯函数（#101）。
 *
 * 密钥全部现场生成，测试内自签自验，不依赖网络、数据库或真实商户证书。
 */

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const WECHAT_API_V3_KEY = '0123456789abcdef0123456789abcdef';
const WECHAT_RESOURCE_NONCE = 'resourceNonce';
const WECHAT_ASSOCIATED_DATA = 'transaction';

const wechatConfig: WechatMerchantConfig = {
  mchId: '1900000001',
  apiV3Key: WECHAT_API_V3_KEY,
  platformPublicKeyPem: PUBLIC_KEY_PEM,
  appId: 'wx1234567890',
};

const alipayConfig: AlipayMerchantConfig = {
  appId: '2021000000000001',
  alipayPublicKeyPem: PUBLIC_KEY_PEM,
  privateKeyPem: PRIVATE_KEY_PEM,
};

const WECHAT_PAYLOAD = {
  mchid: '1900000001',
  appid: 'wx1234567890',
  out_trade_no: 'E-0001-20261108-0001',
  transaction_id: '4200000000202611080000000001',
  trade_state: 'SUCCESS',
  trade_state_desc: '支付成功',
  success_time: '2026-11-08T10:00:00+08:00',
  amount: { total: 1234, payer_total: 1234, currency: 'CNY', payer_currency: 'CNY' },
  payer: { openid: 'o-test' },
};

function encryptWechatPayload(payload: unknown, apiV3Key = WECHAT_API_V3_KEY): string {
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key, 'utf8'),
    Buffer.from(WECHAT_RESOURCE_NONCE, 'utf8'),
  );
  cipher.setAAD(Buffer.from(WECHAT_ASSOCIATED_DATA, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  // 微信 API v3：base64(密文 + 16 字节 GCM auth tag)。
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
}

function buildWechatBody(payload: unknown = WECHAT_PAYLOAD, apiV3Key?: string): string {
  return JSON.stringify({
    id: 'evt-0001',
    create_time: '2026-11-08T10:00:01+08:00',
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext: encryptWechatPayload(payload, apiV3Key),
      associated_data: WECHAT_ASSOCIATED_DATA,
      nonce: WECHAT_RESOURCE_NONCE,
      original_type: 'transaction',
    },
  });
}

function wechatHeaders(
  rawBody: string,
  timestamp = '1762567200',
  nonce = 'header-nonce-1',
): Record<string, string> {
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(message, 'utf8'), PRIVATE_KEY_PEM).toString(
    'base64',
  );
  return {
    'Wechatpay-Timestamp': timestamp,
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': signature,
    'Wechatpay-Serial': 'SERIAL-0001',
  };
}

function catchError(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出 AppError，但函数正常返回');
}

function expectAppError(work: () => unknown, code: AppError['code']): AppError {
  const error = catchError(work);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('verifyWechatCallback', () => {
  it('合法签名通过（签名头大小写不敏感）', () => {
    const rawBody = buildWechatBody();
    const headers = Object.fromEntries(
      Object.entries(wechatHeaders(rawBody)).map(([key, value]) => [key.toLowerCase(), value]),
    );

    expect(() => verifyWechatCallback({ headers, rawBody, config: wechatConfig })).not.toThrow();
  });

  it('解密后返回正确业务字段，金额单位为分', () => {
    const rawBody = buildWechatBody();

    const result = verifyWechatCallback({
      headers: wechatHeaders(rawBody),
      rawBody,
      config: wechatConfig,
    });

    expect(result).toEqual({
      outTradeNo: 'E-0001-20261108-0001',
      transactionId: '4200000000202611080000000001',
      amountTotalFen: 1234,
      successTime: '2026-11-08T10:00:00+08:00',
      tradeState: 'SUCCESS',
    });
  });

  it('篡改 body 后验签失败（401）', () => {
    const rawBody = buildWechatBody();
    const headers = wechatHeaders(rawBody);

    expectAppError(
      () => verifyWechatCallback({ headers, rawBody: `${rawBody} `, config: wechatConfig }),
      'UNAUTHENTICATED',
    );
  });

  it('签名合法但 apiV3Key 不对时解密失败（401）', () => {
    const rawBody = buildWechatBody();
    const headers = wechatHeaders(rawBody);
    const wrongConfig: WechatMerchantConfig = { ...wechatConfig, apiV3Key: 'f'.repeat(32) };

    expectAppError(
      () => verifyWechatCallback({ headers, rawBody, config: wrongConfig }),
      'UNAUTHENTICATED',
    );
  });
});

function alipayForm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    app_id: '2021000000000001',
    out_trade_no: 'E-0001-20261108-0001',
    trade_no: '2026110822001440000000000001',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '12.34',
    notify_time: '2026-11-08 10:00:00',
    ...overrides,
  };
}

function signedAlipayForm(overrides: Record<string, string> = {}): Record<string, string> {
  const form = alipayForm(overrides);
  const signature = cryptoSign(
    'RSA-SHA256',
    Buffer.from(buildAlipaySignContent(form), 'utf8'),
    PRIVATE_KEY_PEM,
  ).toString('base64');
  return { ...form, sign_type: 'RSA2', sign: signature };
}

describe('verifyAlipayCallback', () => {
  it('合法签名通过并返回业务字段', () => {
    const form = signedAlipayForm();

    const result = verifyAlipayCallback({ form, config: alipayConfig });

    expect(result).toEqual({
      outTradeNo: 'E-0001-20261108-0001',
      tradeNo: '2026110822001440000000000001',
      totalAmount: '12.34',
      tradeStatus: 'TRADE_SUCCESS',
    });
  });

  it('篡改金额后验签失败（401）', () => {
    const form = { ...signedAlipayForm(), total_amount: '99.99' };

    expectAppError(() => verifyAlipayCallback({ form, config: alipayConfig }), 'UNAUTHENTICATED');
  });
});

describe('readMerchantConfig', () => {
  const SECRET_V3_KEY = 'SECRET-API-V3-KEY-DO-NOT-LEAK';
  const SECRET_PRIVATE_PEM = 'SECRET-PRIVATE-KEY-DO-NOT-LEAK';
  let originalConfig: string | undefined;

  beforeEach(() => {
    originalConfig = process.env.QINGDAN_PAYMENT_CONFIG;
    process.env.QINGDAN_PAYMENT_CONFIG = JSON.stringify({
      companyA: {
        wechat: {
          mchId: '1900000001',
          apiV3Key: SECRET_V3_KEY,
          platformPublicKeyPem: 'PUBLIC-PEM',
          appId: 'wx1234567890',
        },
        alipay: {
          appId: '2021000000000001',
          alipayPublicKeyPem: 'ALIPAY-PUBLIC-PEM',
          privateKeyPem: SECRET_PRIVATE_PEM,
        },
      },
      companyB: {
        wechat: { mchId: '1900000002' },
      },
    });
  });

  afterEach(() => {
    if (originalConfig === undefined) delete process.env.QINGDAN_PAYMENT_CONFIG;
    else process.env.QINGDAN_PAYMENT_CONFIG = originalConfig;
  });

  it('缺失公司配置时报错，且错误信息不回显任何密钥', () => {
    const error = expectAppError(
      () => readMerchantConfig('company-missing', 'wechat'),
      'VALIDATION_FAILED',
    );

    expect(error.message).toContain('company-missing');
    expect(error.message).not.toContain(SECRET_V3_KEY);
    expect(error.message).not.toContain(SECRET_PRIVATE_PEM);
  });

  it('字段不全时指出缺哪些字段，且不回显已有配置值', () => {
    const error = expectAppError(() => readMerchantConfig('companyB', 'wechat'), 'VALIDATION_FAILED');

    expect(error.message).toContain('apiV3Key');
    expect(error.message).toContain('platformPublicKeyPem');
    expect(error.message).toContain('appId');
    expect(error.message).not.toContain('1900000002');
  });

  it('配置完整时返回对应渠道的字段', () => {
    expect(readMerchantConfig('companyA', 'wechat')).toEqual({
      mchId: '1900000001',
      apiV3Key: SECRET_V3_KEY,
      platformPublicKeyPem: 'PUBLIC-PEM',
      appId: 'wx1234567890',
    });
    expect(readMerchantConfig('companyA', 'alipay')).toEqual({
      appId: '2021000000000001',
      alipayPublicKeyPem: 'ALIPAY-PUBLIC-PEM',
      privateKeyPem: SECRET_PRIVATE_PEM,
    });
  });
});
