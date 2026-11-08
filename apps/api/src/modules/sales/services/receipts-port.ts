import { SYSTEM_ACTOR_ID } from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import { appendAudit } from '../../../platform/audit/writer.js';
import type { SqlClient } from '../../../platform/db/client.js';
import type {
  FindSalesOrderByNoInput,
  SalesOrderForPayment,
  SalesReceiptFromPaymentCommand,
  SalesReceiptFromPaymentResult,
  SalesReceiptPort,
  ServiceRegistry,
} from '../../../platform/services/registry.js';
import { insertSalesReceipt } from '../repo.js';

/**
 * sales 对支付模块暴露的收款写入端口（D70 / #101）。
 *
 * - 支付模块只拿到「按单号查未收 / 写一笔在线支付收款」两个动作，
 *   **不直读** `sales_order` / `sales_receipt`（模块边界铁律）；
 * - 收款写入复用 `repo.insertSalesReceipt`，与 E 单人工收款走同一条 path；
 * - 端口不开事务、不 `withTenant`：tx 与租户上下文由调用方（payment 回调）提供；
 * - 审计 actor 固定为平台系统身份（回调没有本系统操作者），来源渠道 / 第三方交易号
 *   写进 `changeSummary` 与收款行 remark；审计 id 复用收款 id，
 *   调用方提交后可用同一个 id `flushAuditOutbox`。
 */

interface OrderRow {
  id: string;
  tenant_id: string;
  company_id: string;
  total_amount: string | number;
  received_amount: string | number;
}

function decimal(value: string | number): string {
  return String(value);
}

export async function findOrderByNo(
  tx: SqlClient,
  input: FindSalesOrderByNoInput,
): Promise<SalesOrderForPayment | null> {
  const result = await tx.query<OrderRow>(
    `SELECT o.id,
            o.tenant_id,
            o.company_id,
            trim_scale(o.total_amount) AS total_amount,
            trim_scale(
              COALESCE(
                (SELECT SUM(r.amount)
                   FROM sales_receipt r
                  WHERE r.tenant_id = o.tenant_id
                    AND r.company_id = o.company_id
                    AND r.sales_order_id = o.id),
                0
              )
            ) AS received_amount
       FROM sales_order o
      WHERE o.company_id = $1::uuid
        AND o.order_no = $2`,
    [input.companyId, input.orderNo],
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    totalAmount: decimal(row.total_amount),
    receivedAmount: decimal(row.received_amount),
  };
}

export async function createReceiptFromPayment(
  tx: SqlClient,
  command: SalesReceiptFromPaymentCommand,
): Promise<SalesReceiptFromPaymentResult> {
  const receiptId = uuidv7();
  const receipt = await insertSalesReceipt(
    { tx, tenantId: command.tenantId, companyIds: [command.companyId] },
    {
      id: receiptId,
      companyId: command.companyId,
      salesOrderId: command.orderId,
      direction: '收款',
      amount: command.amount,
      method: '在线支付回调',
      occurredAt: new Date().toISOString(),
      reversalDocId: null,
      remark: command.remark.slice(0, 200),
    },
  );

  // 审计 id = 收款 id：端口只返回 receiptId，调用方提交后用同一 id 搬 outbox。
  await appendAudit(tx, {
    id: receipt.id,
    tenantId: command.tenantId,
    companyId: command.companyId,
    actorType: 'system',
    actorId: SYSTEM_ACTOR_ID,
    source: 'api',
    action: 'sales.receipt.create',
    objectType: 'sales_receipt',
    objectId: receipt.id,
    changeSummary: {
      salesOrderId: receipt.salesOrderId,
      direction: receipt.direction,
      amount: receipt.amount,
      method: receipt.method,
      channel: command.channel,
      transactionId: command.transactionId,
      remark: receipt.remark,
    },
    result: 'success',
    requestId: `payment-callback:${command.transactionId}`,
    reason: `在线支付回调（${command.channel}）`,
  });

  return { receiptId: receipt.id };
}

/** sales 对外端口实现（D70）。 */
export const salesServices: Pick<ServiceRegistry, 'salesReceipt'> = {
  salesReceipt: { findOrderByNo, createReceiptFromPayment },
};
