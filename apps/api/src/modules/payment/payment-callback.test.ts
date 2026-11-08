import type { PaymentCallbackResult, SalesOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { createCipheriv, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { buildAlipaySignContent } from './services/alipay-signature.js';

/**
 * 支付回调 HTTP 接线（#101）：匿名端点 → 验签 → 查单 → 金额校验 → 幂等入账。
 *
 * 口径：
 * - 回调不带本系统会话，直接 `app.inject` 打匿名端点；
 * - 微信要用**原始报文**验签（RSA-SHA256），resource 用 AES-256-GCM 加密；
 * - 收款记录经 sales 端口写入，payment 模块不直读 sales 表；
 * - 重复投递返回 duplicate:true，收款记录仍只有 1 条；
 * - 金额与应收余额不一致 → 422，且不写收款 / 回调记录。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';

const CUSTOMER_ID = '01900000-0000-7000-8000-000000008101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000008111';
const BATCH_ID = '01900000-0000-7000-8000-000000008121';

const WECHAT_MCH_ID = '1900000001';
const WECHAT_APP_ID = 'wx-demo-app';
/** AES-256 需要 32 字节 key。 */
const WECHAT_API_V3_KEY = '0123456789abcdef0123456789abcdef';
const WECHAT_NONCE = '0123456789ab';
const WECHAT_ASSOCIATED_DATA = 'transaction';

const ALIPAY_APP_ID = '2021000000000000';

const { publicKey: RSA_PUBLIC_KEY_PEM, privateKey: RSA_PRIVATE_KEY_PEM } = generateKeyPairSync(
  'rsa',
  {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  },
);

interface WechatCallbackRequest {
  readonly headers: Record<string, string>;
  readonly payload: string;
}

/** 构造一条可验签的微信回调：明文 → AES-256-GCM → JSON 报文 → RSA 签名。 */
function wechatCallback(
  outTradeNo: string,
  transactionId: string,
  amountTotalFen: number,
): WechatCallbackRequest {
  const plaintext = JSON.stringify({
    out_trade_no: outTradeNo,
    transaction_id: transactionId,
    trade_state: 'SUCCESS',
    amount: { total: amountTotalFen, currency: 'CNY' },
  });

  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(WECHAT_API_V3_KEY, 'utf8'),
    Buffer.from(WECHAT_NONCE, 'utf8'),
  );
  cipher.setAAD(Buffer.from(WECHAT_ASSOCIATED_DATA, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');

  const payload = JSON.stringify({
    id: 'evt-payment-callback',
    event_type: 'TRANSACTION.SUCCESS',
    resource: {
      ciphertext,
      nonce: WECHAT_NONCE,
      associated_data: WECHAT_ASSOCIATED_DATA,
    },
  });

  const timestamp = '1700000000';
  const headerNonce = 'callback-nonce-1';
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${timestamp}\n${headerNonce}\n${payload}\n`, 'utf8'),
    RSA_PRIVATE_KEY_PEM,
  ).toString('base64');

  return {
    headers: {
      'content-type': 'application/json',
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': headerNonce,
      'wechatpay-signature': signature,
      'wechatpay-serial': 'PUB_KEY_ID_DEMO',
    },
    payload,
  };
}

interface AlipayCallbackRequest {
  readonly headers: Record<string, string>;
  readonly payload: string;
}

/** 构造一条可验签的支付宝表单回调（RSA2）。 */
function alipayCallback(
  outTradeNo: string,
  tradeNo: string,
  totalAmount: string,
): AlipayCallbackRequest {
  const form: Record<string, string> = {
    app_id: ALIPAY_APP_ID,
    out_trade_no: outTradeNo,
    trade_no: tradeNo,
    total_amount: totalAmount,
    trade_status: 'TRADE_SUCCESS',
    sign_type: 'RSA2',
  };
  form.sign = sign(
    'RSA-SHA256',
    Buffer.from(buildAlipaySignContent(form), 'utf8'),
    RSA_PRIVATE_KEY_PEM,
  ).toString('base64');

  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  };
}

describe('支付回调（PGlite + seed）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let successOrder: SalesOrder;
  let mismatchOrder: SalesOrder;

  async function createCompletedOrder(
    unitPrice: string,
    requestId: string,
  ): Promise<SalesOrder> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'x-request-id': `${requestId}-create`,
      },
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId: CUSTOMER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds: [BATCH_ID],
            qty: '1',
            unitPrice,
            amount: '0',
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const order = created.json() as SalesOrder;

    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${order.id}/complete`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'x-request-id': `${requestId}-complete`,
        'if-match': `"${order.version}"`,
      },
    });
    expect(completed.statusCode).toBe(200);
    const result = completed.json() as SalesOrder;
    expect(result.status).toBe('已完成');
    return result;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, NULL, '支付回调测试客户', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '支付回调测试商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E-PAY-A', '10', '100', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
      ],
    );

    process.env.QINGDAN_PAYMENT_CONFIG = JSON.stringify({
      [DEMO_IDS.companyId]: {
        wechat: {
          mchId: WECHAT_MCH_ID,
          apiV3Key: WECHAT_API_V3_KEY,
          platformPublicKeyPem: RSA_PUBLIC_KEY_PEM,
          appId: WECHAT_APP_ID,
        },
        alipay: {
          appId: ALIPAY_APP_ID,
          alipayPublicKeyPem: RSA_PUBLIC_KEY_PEM,
          privateKeyPem: RSA_PRIVATE_KEY_PEM,
        },
      },
    });

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-payment-callback',
    });
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': 'req-payment-login' },
      payload: { phone: OWNER_PHONE, code: '000000' },
    });
    expect(login.statusCode).toBe(200);
    ownerCookie = String(login.headers['set-cookie']).split(';')[0]!;

    successOrder = await createCompletedOrder('250.4', 'req-payment-order-success');
    mismatchOrder = await createCompletedOrder('100', 'req-payment-order-mismatch');
  });

  afterAll(async () => {
    delete process.env.QINGDAN_PAYMENT_CONFIG;
    await app.close();
    await test.database.close();
  });

  async function postWechat(request: WechatCallbackRequest) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/payments/wechat/callback',
      headers: request.headers,
      payload: request.payload,
    });
  }

  it('① 合法微信回调 → 200，收款落库、payment_transaction 有行', async () => {
    const request = wechatCallback(successOrder.orderNo, 'WX-TXN-SUCCESS', 25040);
    const response = await postWechat(request);

    expect(response.statusCode).toBe(200);
    const body = response.json() as PaymentCallbackResult;
    expect(body).toMatchObject({ received: true, duplicate: false });
    expect(body.receiptId).toEqual(expect.any(String));

    const receipts = await test.database.query<{
      id: string;
      direction: string;
      amount: string;
      method: string;
    }>(
      `SELECT id, direction, trim_scale(amount) AS amount, method
         FROM sales_receipt
        WHERE sales_order_id = $1::uuid`,
      [successOrder.id],
    );
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]).toMatchObject({
      id: body.receiptId,
      direction: '收款',
      amount: '250.4',
      method: '在线支付回调',
    });

    const transactions = await test.database.query<{
      out_trade_no: string;
      transaction_id: string;
      amount: string;
      receipt_id: string;
    }>(
      `SELECT out_trade_no, transaction_id, trim_scale(amount) AS amount, receipt_id
         FROM payment_transaction
        WHERE company_id = $1::uuid AND channel = 'wechat' AND out_trade_no = $2`,
      [DEMO_IDS.companyId, successOrder.orderNo],
    );
    expect(transactions.rows).toHaveLength(1);
    expect(transactions.rows[0]).toMatchObject({
      transaction_id: 'WX-TXN-SUCCESS',
      amount: '250.4',
      receipt_id: body.receiptId,
    });
  });

  it('② 同一回调重复投递 → duplicate:true，收款记录仍只有 1 条', async () => {
    const request = wechatCallback(successOrder.orderNo, 'WX-TXN-SUCCESS', 25040);
    const response = await postWechat(request);

    expect(response.statusCode).toBe(200);
    const body = response.json() as PaymentCallbackResult;
    expect(body).toMatchObject({ received: true, duplicate: true });
    expect(body.receiptId).toEqual(expect.any(String));

    const receipts = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sales_receipt WHERE sales_order_id = $1::uuid`,
      [successOrder.id],
    );
    expect(receipts.rows[0]?.n).toBe(1);

    const transactions = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM payment_transaction
        WHERE company_id = $1::uuid AND channel = 'wechat' AND out_trade_no = $2`,
      [DEMO_IDS.companyId, successOrder.orderNo],
    );
    expect(transactions.rows[0]?.n).toBe(1);
  });

  it('③ 金额与应收余额不符 → 422，且不写收款 / 回调记录', async () => {
    // 支付宝表单回调，金额少 0.01：验签通过但金额校验拒绝。
    const request = alipayCallback(mismatchOrder.orderNo, 'ALI-TXN-MISMATCH', '99.99');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/alipay/callback',
      headers: request.headers,
      payload: request.payload,
    });

    expect(response.statusCode).toBe(422);
    const body = response.json() as { code: string; details?: Record<string, unknown> };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details).toMatchObject({ outTradeNo: mismatchOrder.orderNo });

    const receipts = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sales_receipt WHERE sales_order_id = $1::uuid`,
      [mismatchOrder.id],
    );
    expect(receipts.rows[0]?.n).toBe(0);

    const transactions = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM payment_transaction
        WHERE company_id = $1::uuid AND channel = 'alipay' AND out_trade_no = $2`,
      [DEMO_IDS.companyId, mismatchOrder.orderNo],
    );
    expect(transactions.rows[0]?.n).toBe(0);
  });
});
