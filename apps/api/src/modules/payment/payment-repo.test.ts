import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlClient } from '../../platform/db/client.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import {
  attachReceipt,
  findByOutTradeNo,
  recordCallback,
  type RecordCallbackInput,
} from './repo.js';

/**
 * 支付回调数据层（#101）：唯一键 (company_id, channel, out_trade_no) 即幂等闸门。
 *
 * PGlite + runMigrations，不调用 seed：只准备 FK 必需的租户 / 公司两行。
 */

const TENANT_ID = '01900000-0000-7000-8000-0000000000e1';
const COMPANY_ID = '01900000-0000-7000-8000-0000000000e2';
const RECEIPT_ID = '01900000-0000-7000-8000-0000000000e3';

function callbackInput(overrides: Partial<RecordCallbackInput>): RecordCallbackInput {
  return {
    tenantId: TENANT_ID,
    companyId: COMPANY_ID,
    channel: 'wechat',
    outTradeNo: 'OUT-TRADE-1',
    transactionId: 'WX-TXN-1',
    amount: '99.5',
    status: '已支付',
    ...overrides,
  };
}

describe('payment repo（PGlite）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await test.database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO tenant (id, name, plan, status) VALUES ($1::uuid, '支付测试租户', '基础版', '启用')`,
        [TENANT_ID],
      );
      await tx.query(
        `INSERT INTO company (id, tenant_id, name, code) VALUES ($1::uuid, $2::uuid, '支付测试公司', '0001')`,
        [COMPANY_ID, TENANT_ID],
      );
    });
  });

  afterAll(async () => {
    await test.database.close();
  });

  async function inTenant<T>(work: (tx: SqlClient) => Promise<T>): Promise<T> {
    return test.database.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_ID]);
      return work(tx);
    });
  }

  it('① 首次写入：inserted=true 并落一行', async () => {
    const result = await inTenant((tx) =>
      recordCallback(tx, callbackInput({ outTradeNo: 'OUT-FIRST', transactionId: 'WX-TXN-FIRST' })),
    );
    expect(result.inserted).toBe(true);
    expect(result.id).toEqual(expect.any(String));

    const rows = await test.database.query<{
      amount: string;
      status: string;
      transaction_id: string;
    }>(
      `SELECT trim_scale(amount) AS amount, status, transaction_id
         FROM payment_transaction
        WHERE company_id = $1::uuid AND channel = 'wechat' AND out_trade_no = 'OUT-FIRST'`,
      [COMPANY_ID],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      amount: '99.5',
      status: '已支付',
      transaction_id: 'WX-TXN-FIRST',
    });
  });

  it('② 同 (company, channel, out_trade_no) 再写：inserted=false，表里仍只有 1 行', async () => {
    const input = callbackInput({
      outTradeNo: 'OUT-DUPLICATE',
      transactionId: 'WX-TXN-DUPLICATE-1',
    });
    const first = await inTenant((tx) => recordCallback(tx, input));
    expect(first.inserted).toBe(true);

    const second = await inTenant((tx) =>
      recordCallback(tx, { ...input, transactionId: 'WX-TXN-DUPLICATE-2' }),
    );
    expect(second).toEqual({ inserted: false, id: null });

    const rows = await test.database.query<{ n: number; transaction_id: string }>(
      `SELECT count(*)::int AS n, min(transaction_id) AS transaction_id
         FROM payment_transaction
        WHERE company_id = $1::uuid AND channel = 'wechat' AND out_trade_no = 'OUT-DUPLICATE'`,
      [COMPANY_ID],
    );
    expect(rows.rows[0]).toEqual({ n: 1, transaction_id: 'WX-TXN-DUPLICATE-1' });
  });

  it('③ 不同 channel 同单号：可各写一行', async () => {
    const outTradeNo = 'OUT-CROSS-CHANNEL';
    const wechat = await inTenant((tx) =>
      recordCallback(tx, callbackInput({ channel: 'wechat', outTradeNo })),
    );
    const alipay = await inTenant((tx) =>
      recordCallback(tx, callbackInput({ channel: 'alipay', outTradeNo })),
    );
    expect(wechat.inserted).toBe(true);
    expect(alipay.inserted).toBe(true);

    const rows = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM payment_transaction
        WHERE company_id = $1::uuid AND out_trade_no = $2`,
      [COMPANY_ID, outTradeNo],
    );
    expect(rows.rows[0]?.n).toBe(2);

    const byWechat = await inTenant((tx) =>
      findByOutTradeNo(tx, { companyId: COMPANY_ID, channel: 'wechat', outTradeNo }),
    );
    const byAlipay = await inTenant((tx) =>
      findByOutTradeNo(tx, { companyId: COMPANY_ID, channel: 'alipay', outTradeNo }),
    );
    expect(byWechat?.status).toBe('已支付');
    expect(byAlipay?.status).toBe('已支付');
  });

  it('④ attachReceipt 能回填 receipt_id', async () => {
    const outTradeNo = 'OUT-ATTACH';
    const recorded = await inTenant((tx) =>
      recordCallback(tx, callbackInput({ outTradeNo })),
    );
    expect(recorded.inserted).toBe(true);
    if (!recorded.inserted) throw new Error('unreachable');

    const attached = await inTenant((tx) =>
      attachReceipt(tx, { id: recorded.id, receiptId: RECEIPT_ID }),
    );
    expect(attached).toBe(true);

    const found = await inTenant((tx) =>
      findByOutTradeNo(tx, { companyId: COMPANY_ID, channel: 'wechat', outTradeNo }),
    );
    expect(found).toMatchObject({ id: recorded.id, receiptId: RECEIPT_ID });
  });
});
