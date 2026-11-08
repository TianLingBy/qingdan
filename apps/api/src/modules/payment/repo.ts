import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 在线支付回调数据访问层（#101）。
 *
 * - 幂等闸门是 `payment_transaction` 的 `(company_id, channel, out_trade_no)` 唯一键：
 *   `recordCallback` 用 INSERT ... ON CONFLICT DO NOTHING 判断首次 / 重复回调；
 * - 回调发生在同一业务事务内：本模块不自己开事务，也不在这里创建收款单；
 *   收款单由调用方生成后用 `attachReceipt` 回填；
 * - 金额保持 decimal 字符串，读出时由 SQL trim_scale 规范化（D54）。
 */

export type PaymentChannel = 'wechat' | 'alipay';

export interface RecordCallbackInput {
  readonly tenantId: string;
  readonly companyId: string;
  readonly channel: PaymentChannel;
  readonly outTradeNo: string;
  readonly transactionId: string | null;
  readonly amount: string;
  readonly status: string;
}

export type RecordCallbackResult =
  | { readonly inserted: true; readonly id: string }
  | { readonly inserted: false; readonly id: null };

export interface FindByOutTradeNoInput {
  readonly companyId: string;
  readonly channel: PaymentChannel;
  readonly outTradeNo: string;
}

export interface AttachReceiptInput {
  readonly id: string;
  readonly receiptId: string;
}

export interface PaymentTransactionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly channel: PaymentChannel;
  readonly outTradeNo: string;
  readonly transactionId: string | null;
  readonly amount: string;
  readonly status: string;
  readonly receiptId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PaymentTransactionRow {
  id: string;
  tenant_id: string;
  company_id: string;
  channel: string;
  out_trade_no: string;
  transaction_id: string | null;
  amount: string | number;
  status: string;
  receipt_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const PAYMENT_TRANSACTION_COLUMNS = `id,
  tenant_id,
  company_id,
  channel,
  out_trade_no,
  transaction_id,
  trim_scale(amount) AS amount,
  status,
  receipt_id,
  created_at,
  updated_at`;

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapPaymentTransaction(row: PaymentTransactionRow): PaymentTransactionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    channel: row.channel as PaymentChannel,
    outTradeNo: row.out_trade_no,
    transactionId: row.transaction_id,
    amount: String(row.amount),
    status: row.status,
    receiptId: row.receipt_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * 记录一次支付回调。
 *
 * 插入成功 → `{ inserted: true, id }`；同 (company, channel, out_trade_no) 已存在
 * → `{ inserted: false, id: null }`，调用方据此走「重复回调」分支且不重复入账。
 */
export async function recordCallback(
  tx: SqlClient,
  input: RecordCallbackInput,
): Promise<RecordCallbackResult> {
  const id = uuidv7();
  const result = await tx.query<{ id: string }>(
    `INSERT INTO payment_transaction
       (id, tenant_id, company_id, channel, out_trade_no, transaction_id, amount, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::numeric, $8)
     ON CONFLICT (company_id, channel, out_trade_no) DO NOTHING
     RETURNING id`,
    [
      id,
      input.tenantId,
      input.companyId,
      input.channel,
      input.outTradeNo,
      input.transactionId,
      input.amount,
      input.status,
    ],
  );

  const row = result.rows[0];
  return row ? { inserted: true, id: row.id } : { inserted: false, id: null };
}

/** 按幂等键查回调记录；不存在返回 null。 */
export async function findByOutTradeNo(
  tx: SqlClient,
  input: FindByOutTradeNoInput,
): Promise<PaymentTransactionRecord | null> {
  const result = await tx.query<PaymentTransactionRow>(
    `SELECT ${PAYMENT_TRANSACTION_COLUMNS}
       FROM payment_transaction
      WHERE company_id = $1::uuid
        AND channel = $2
        AND out_trade_no = $3`,
    [input.companyId, input.channel, input.outTradeNo],
  );
  const row = result.rows[0];
  return row ? mapPaymentTransaction(row) : null;
}

/** 回填本次回调生成的收款单；记录不存在返回 false。 */
export async function attachReceipt(
  tx: SqlClient,
  input: AttachReceiptInput,
): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `UPDATE payment_transaction
        SET receipt_id = $2::uuid
      WHERE id = $1::uuid
      RETURNING id`,
    [input.id, input.receiptId],
  );
  return result.rows.length > 0;
}
