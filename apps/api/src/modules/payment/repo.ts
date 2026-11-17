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

// ---------------------------------------------------------------------------
// 发起侧：payment_request（#101）
//
// 与回调记录的分工：`payment_transaction` 是「钱真的到了」的凭据，只追加；
// `payment_request` 是「等着客户付」的意图，状态单向推进，入账后回填一对指针
// （status / paid_at / transaction_id）。两张表通过 transaction_id 关联。
// ---------------------------------------------------------------------------

export type PaymentRequestStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export interface PaymentRequestRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly salesOrderId: string;
  readonly channel: PaymentChannel;
  readonly amount: string;
  readonly status: PaymentRequestStatus;
  readonly providerOrderNo: string;
  readonly qrContent: string | null;
  readonly payUrl: string | null;
  readonly expiresAt: string;
  readonly paidAt: string | null;
  readonly transactionId: string | null;
  readonly createdAt: string;
}

export interface InsertPaymentRequestInput {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly salesOrderId: string;
  readonly channel: PaymentChannel;
  readonly amount: string;
  readonly providerOrderNo: string;
  readonly qrContent: string | null;
  readonly payUrl: string | null;
  readonly expiresAt: string;
}

export interface FindPendingPaymentRequestInput {
  readonly companyId: string;
  readonly salesOrderId: string;
  readonly channel: PaymentChannel;
}

export interface MarkPaymentRequestPaidInput {
  readonly id: string;
  readonly paidAt: string;
  /** `payment_transaction.id`——入账凭据的指针，不是第三方交易号。 */
  readonly transactionId: string;
}

interface PaymentRequestRow {
  id: string;
  tenant_id: string;
  company_id: string;
  sales_order_id: string;
  channel: string;
  amount: string | number;
  status: string;
  provider_order_no: string;
  qr_content: string | null;
  pay_url: string | null;
  expires_at: Date | string;
  paid_at: Date | string | null;
  transaction_id: string | null;
  created_at: Date | string;
}

/**
 * 金额取 `amount::text` 而不是 `trim_scale()`：列是 numeric(14,2)，
 * 线上支付以分为最小单位，`'100.00'` 这种固定两位的写法正是对账时要的形态。
 */
const PAYMENT_REQUEST_COLUMNS = `id,
  tenant_id,
  company_id,
  sales_order_id,
  channel,
  amount::text AS amount,
  status,
  provider_order_no,
  qr_content,
  pay_url,
  expires_at,
  paid_at,
  transaction_id,
  created_at`;

function mapPaymentRequest(row: PaymentRequestRow): PaymentRequestRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    salesOrderId: row.sales_order_id,
    channel: row.channel as PaymentChannel,
    amount: String(row.amount),
    status: row.status as PaymentRequestStatus,
    providerOrderNo: row.provider_order_no,
    qrContent: row.qr_content,
    payUrl: row.pay_url,
    expiresAt: toIso(row.expires_at),
    paidAt: row.paid_at === null ? null : toIso(row.paid_at),
    transactionId: row.transaction_id,
    createdAt: toIso(row.created_at),
  };
}

export async function insertPaymentRequest(
  tx: SqlClient,
  input: InsertPaymentRequestInput,
): Promise<PaymentRequestRecord> {
  const result = await tx.query<PaymentRequestRow>(
    `INSERT INTO payment_request
       (id, tenant_id, company_id, sales_order_id, channel, amount,
        provider_order_no, qr_content, pay_url, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric,
             $7, $8, $9, $10::timestamptz)
     RETURNING ${PAYMENT_REQUEST_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.companyId,
      input.salesOrderId,
      input.channel,
      input.amount,
      input.providerOrderNo,
      input.qrContent,
      input.payUrl,
      input.expiresAt,
    ],
  );
  return mapPaymentRequest(result.rows[0]!);
}

/**
 * 找「还没过期的待支付单」——客户反复点收款不该生成一堆二维码。
 *
 * 过期判定直接写进 WHERE：过期单不复用，但仍然留在表里（过期是时间的事实，
 * 见 `read-request.ts` 的惰性判定，不靠状态迁移删单）。
 */
export async function findPendingPaymentRequest(
  tx: SqlClient,
  input: FindPendingPaymentRequestInput,
): Promise<PaymentRequestRecord | null> {
  const result = await tx.query<PaymentRequestRow>(
    `SELECT ${PAYMENT_REQUEST_COLUMNS}
       FROM payment_request
      WHERE company_id = $1::uuid
        AND sales_order_id = $2::uuid
        AND channel = $3
        AND status = 'pending'
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.companyId, input.salesOrderId, input.channel],
  );
  const row = result.rows[0];
  return row ? mapPaymentRequest(row) : null;
}

export async function findPaymentRequestById(
  tx: SqlClient,
  id: string,
): Promise<PaymentRequestRecord | null> {
  const result = await tx.query<PaymentRequestRow>(
    `SELECT ${PAYMENT_REQUEST_COLUMNS} FROM payment_request WHERE id = $1::uuid`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapPaymentRequest(row) : null;
}

export async function findPaymentRequestByProviderOrderNo(
  tx: SqlClient,
  providerOrderNo: string,
): Promise<PaymentRequestRecord | null> {
  const result = await tx.query<PaymentRequestRow>(
    `SELECT ${PAYMENT_REQUEST_COLUMNS} FROM payment_request WHERE provider_order_no = $1`,
    [providerOrderNo],
  );
  const row = result.rows[0];
  return row ? mapPaymentRequest(row) : null;
}

/**
 * 入账后回填：**只发这三列**。
 *
 * 表上没有 UPDATE 触发器去禁改金额（见迁移注释），口径靠这里守：调用方永远只经本函数
 * 推进状态，不给「顺手改金额」留入口。`status = 'pending'` 作为守卫，重复确认时是空操作，
 * 与回调的幂等闸门形成两道防线。
 */
export async function markPaymentRequestPaid(
  tx: SqlClient,
  input: MarkPaymentRequestPaidInput,
): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `UPDATE payment_request
        SET status = 'paid',
            paid_at = $2::timestamptz,
            transaction_id = $3::uuid
      WHERE id = $1::uuid
        AND status = 'pending'
      RETURNING id`,
    [input.id, input.paidAt, input.transactionId],
  );
  return result.rows.length > 0;
}
