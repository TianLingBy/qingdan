import type { PaymentCallbackResult, PaymentRequest, SalesOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 在线支付「发起侧 + mock 模式 + 对账查询」HTTP 切片（#101）。
 *
 * 用 PGlite 真库 + 真迁移覆盖：
 * - 发起收款按应收余额算金额，body 里的金额被 `.strict()` 拒掉；
 * - 同单同渠道未过期的待支付单复用，不生成第二张二维码；
 * - 已收齐 → 422；无 `payment.create` → 403；
 * - mock 确认复用回调入账路径，产生与真实回调同一份账（收款行 + payment_transaction）；
 * - 重复确认幂等；过期是「读时的判断」，库里仍是 pending；
 * - live 模式下 mock 端点 404（不是 403）。
 *
 * 不设 `QINGDAN_PAYMENT_CONFIG`：mock 模式不需要商户资质，这正是默认 mock 的意义。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
const WAREHOUSE_PHONE = '10000000004';

const CUSTOMER_ID = '01900000-0000-7000-8000-000000008101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000008111';
const BATCH_ID = '01900000-0000-7000-8000-000000008121';

function writeHeaders(
  cookie: string,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId, ...extra };
}

describe('支付发起侧（PGlite + seed）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let warehouseCookie: string;

  async function login(phone: string, requestId: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': requestId },
      payload: { phone, code: '000000' },
    });
    expect(response.statusCode).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0]!;
  }

  /** 造一张待收款销售单（不发货：收款与出库无关，扫码收款在发货前后都可能发生）。 */
  async function createOrder(unitPrice: string, requestId: string): Promise<SalesOrder> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: writeHeaders(ownerCookie, `${requestId}-create`),
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
    return created.json() as SalesOrder;
  }

  async function createRequest(
    orderId: string,
    requestId: string,
    cookie = ownerCookie,
    payload: unknown = { channel: 'wechat' },
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${orderId}/payment-requests`,
      headers: writeHeaders(cookie, requestId),
      payload: payload as Record<string, unknown>,
    });
  }

  async function confirmMock(providerOrderNo: string, requestId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/payments/mock/${providerOrderNo}/confirm`,
      headers: { 'x-request-id': requestId },
    });
  }

  async function readRequest(id: string, requestId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/payments/${id}`,
      headers: { cookie: ownerCookie, 'x-request-id': requestId },
    });
  }

  async function countReceipts(orderId: string): Promise<{ rows: number; sum: string }> {
    const result = await test.database.query<{ rows: string; sum: string }>(
      `SELECT count(*)::text AS rows, COALESCE(SUM(amount), 0)::text AS sum
         FROM sales_receipt WHERE sales_order_id = $1::uuid`,
      [orderId],
    );
    return result.rows[0]!;
  }

  /**
   * mock 流程里 `out_trade_no` 就是发起时生成的商户订单号（不是 E 单单号）：
   * 真实回调靠单号反查销售单，mock 已经在 payment_request 上把两者对上了，
   * 因此入账凭据记的是商户单号——这也是回调幂等键的一部分。
   */
  async function countTransactions(providerOrderNo: string): Promise<number> {
    const result = await test.database.query<{ rows: string }>(
      `SELECT count(*)::text AS rows FROM payment_transaction WHERE out_trade_no = $1`,
      [providerOrderNo],
    );
    return Number(result.rows[0]!.rows);
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name)
       VALUES ($1, $2, $3, NULL, '支付发起测试客户')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '支付发起测试商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E-PAY-REQ', '10', '100', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [BATCH_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, PRODUCT_ID, DEMO_IDS.ownerEmployeeId],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-payment-request',
    });
    await app.ready();

    ownerCookie = await login(OWNER_PHONE, 'req-payment-request-login-owner');
    warehouseCookie = await login(WAREHOUSE_PHONE, 'req-payment-request-login-warehouse');
  });

  afterAll(async () => {
    delete process.env.QINGDAN_PAYMENT_MODE;
    await app.close();
    await test.database.close();
  });

  it('① 未收 100 的单发起 wechat：200，金额由服务端算，二维码指向 mock', async () => {
    const order = await createOrder('100', 'req-payreq-1');
    const response = await createRequest(order.id, 'req-payreq-1-create');

    expect(response.statusCode).toBe(200);
    const payment = response.json() as PaymentRequest;
    expect(payment).toMatchObject({
      salesOrderId: order.id,
      channel: 'wechat',
      amount: '100.00',
      status: 'pending',
      paidAt: null,
    });
    expect(payment.qrContent?.startsWith('qingdan-mock://pay/')).toBe(true);
    expect(payment.payUrl?.startsWith('/mock-pay/')).toBe(true);
    expect(new Date(payment.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('② 同单同渠道未过期再发起：返回同一张待支付单，不新建', async () => {
    const order = await createOrder('80', 'req-payreq-2');
    const first = await createRequest(order.id, 'req-payreq-2-a');
    expect(first.statusCode).toBe(200);
    const second = await createRequest(order.id, 'req-payreq-2-b');
    expect(second.statusCode).toBe(200);

    expect((second.json() as PaymentRequest).id).toBe((first.json() as PaymentRequest).id);
    const count = await test.database.query<{ rows: string }>(
      `SELECT count(*)::text AS rows FROM payment_request WHERE sales_order_id = $1::uuid`,
      [order.id],
    );
    expect(count.rows[0]!.rows).toBe('1');
  });

  it('③ 已收齐的单发起：422 该单已收齐', async () => {
    const order = await createOrder('60', 'req-payreq-3');
    const created = await createRequest(order.id, 'req-payreq-3-create');
    expect(created.statusCode).toBe(200);
    const payment = created.json() as PaymentRequest;

    const confirmed = await confirmMock(payment.payUrl!.split('/').pop()!, 'req-payreq-3-confirm');
    expect(confirmed.statusCode).toBe(200);

    const again = await createRequest(order.id, 'req-payreq-3-again');
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(again.json())).toContain('该单已收齐');
  });

  it('④ 没有 payment.create 的账号发起：403', async () => {
    const order = await createOrder('100', 'req-payreq-4');
    // 仓管岗位预设里没有任何 payment.* 权限 → 一切非老板账号在此被拦（见 PR 说明）。
    const response = await createRequest(order.id, 'req-payreq-4-forbidden', warehouseCookie);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('⑤ live 模式下 mock 确认返回 404（不暴露端点存在性）', async () => {
    const order = await createOrder('100', 'req-payreq-5');
    const created = await createRequest(order.id, 'req-payreq-5-create');
    const payment = created.json() as PaymentRequest;
    const providerOrderNo = payment.payUrl!.split('/').pop()!;

    process.env.QINGDAN_PAYMENT_MODE = 'live';
    try {
      const response = await confirmMock(providerOrderNo, 'req-payreq-5-confirm');
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      delete process.env.QINGDAN_PAYMENT_MODE;
    }
  });

  it('⑥ mock 确认复用回调入账：收款行 + payment_transaction + 待支付单回填', async () => {
    const order = await createOrder('100', 'req-payreq-6');
    const created = await createRequest(order.id, 'req-payreq-6-create');
    const payment = created.json() as PaymentRequest;
    const providerOrderNo = payment.payUrl!.split('/').pop()!;

    const confirmed = await confirmMock(providerOrderNo, 'req-payreq-6-confirm');
    expect(confirmed.statusCode).toBe(200);
    const result = confirmed.json() as PaymentCallbackResult;
    expect(result).toMatchObject({ received: true, duplicate: false });
    expect(result.receiptId).not.toBeNull();

    const receipts = await countReceipts(order.id);
    expect(receipts.rows).toBe('1');
    expect(receipts.sum).toBe('100.000000');
    expect(await countTransactions(providerOrderNo)).toBe(1);

    const stored = await test.database.query<{
      status: string;
      paid_at: string | null;
      transaction_id: string | null;
    }>(
      `SELECT status, paid_at, transaction_id FROM payment_request WHERE id = $1::uuid`,
      [payment.id],
    );
    expect(stored.rows[0]!.status).toBe('paid');
    expect(stored.rows[0]!.paid_at).not.toBeNull();
    expect(stored.rows[0]!.transaction_id).not.toBeNull();

    const read = await readRequest(payment.id, 'req-payreq-6-read');
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ status: 'paid' });
  });

  it('⑦ 重复确认幂等：第二次 duplicate，账上仍只有一条', async () => {
    const order = await createOrder('100', 'req-payreq-7');
    const created = await createRequest(order.id, 'req-payreq-7-create');
    const payment = created.json() as PaymentRequest;
    const providerOrderNo = payment.payUrl!.split('/').pop()!;

    const first = await confirmMock(providerOrderNo, 'req-payreq-7-confirm-1');
    expect(first.statusCode).toBe(200);
    expect((first.json() as PaymentCallbackResult).duplicate).toBe(false);

    const second = await confirmMock(providerOrderNo, 'req-payreq-7-confirm-2');
    expect(second.statusCode).toBe(200);
    expect((second.json() as PaymentCallbackResult).duplicate).toBe(true);

    expect((await countReceipts(order.id)).rows).toBe('1');
    expect(await countTransactions(providerOrderNo)).toBe(1);
    const paid = await test.database.query<{ rows: string }>(
      `SELECT count(*)::text AS rows FROM payment_request
        WHERE sales_order_id = $1::uuid AND status = 'paid'`,
      [order.id],
    );
    expect(paid.rows[0]!.rows).toBe('1');
  });

  it('⑧ 过期后查单返回 expired，库里仍是 pending（惰性判定不写库）', async () => {
    const order = await createOrder('100', 'req-payreq-8');
    const created = await createRequest(order.id, 'req-payreq-8-create');
    const payment = created.json() as PaymentRequest;

    // 直接把有效期改到过去：比等 15 分钟现实。
    await test.database.query(
      `UPDATE payment_request SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`,
      [payment.id],
    );

    const read = await readRequest(payment.id, 'req-payreq-8-read');
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ status: 'expired', paidAt: null });

    const stored = await test.database.query<{ status: string }>(
      `SELECT status FROM payment_request WHERE id = $1::uuid`,
      [payment.id],
    );
    expect(stored.rows[0]!.status).toBe('pending');
  });

  it('⑨ body 里带 amount：422（金额只由服务端算）', async () => {
    const order = await createOrder('100', 'req-payreq-9');
    const response = await createRequest(order.id, 'req-payreq-9-strict', ownerCookie, {
      channel: 'wechat',
      amount: '1.00',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
