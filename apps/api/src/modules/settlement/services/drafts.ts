import { AppError } from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import { appendAudit } from '../../../platform/audit/writer.js';
import type { SqlClient } from '../../../platform/db/client.js';
import { takeDocumentNo } from '../../../platform/numbering/service.js';
import type {
  ServiceRegistry,
  SettlementDraftCommand,
  SettlementDraftReceipt,
} from '../../../platform/services/registry.js';

/**
 * C 结算单草稿生成（D19 / D70）。
 *
 * 由来源模块（E / N 单完成方）在**自己的业务事务**里调用：金额、佣金费率快照全部由
 * 来源模块算好传入，settlement 不读 E / N 表（D70 ②）。
 *
 * - 同事务：不自己开事务、不 `withTenant`，租户上下文由调用方保证；
 * - 唯一性：`settlement_order` 的 `(tenant_id, source_doc_type, source_doc_id)` 唯一键兜底，
 *   重复生成返回 409，不静默覆盖；
 * - 审计：本函数只往 outbox 追加一行「被调用后生成草稿」，返回 auditId，
 *   调用方提交后自行 `flushAuditOutbox`（D70 ④）。
 */
export async function createSettlementDraft(
  tx: SqlClient,
  command: SettlementDraftCommand,
): Promise<SettlementDraftReceipt> {
  const relatedLoss = command.relatedLossAmount ?? '0';
  const id = uuidv7();
  const orderNo = await takeDocumentNo(tx, 'C', command.companyId, new Date());

  const inserted = await tx.query<{ id: string; version: number }>(
    `INSERT INTO settlement_order
       (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
        total_sale_amount, total_cost_amount, gross_profit, gross_margin_rate,
        related_loss_amount, net_profit, commission_rate_snapshot, commission_amount)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid,
             $7::numeric, $8::numeric,
             $7::numeric - $8::numeric,
             CASE WHEN $7::numeric = 0 THEN 0
                  ELSE round(($7::numeric - $8::numeric) / $7::numeric, 6) END,
             $9::numeric,
             ($7::numeric - $8::numeric) - $9::numeric,
             $10::numeric, $11::numeric)
     ON CONFLICT (tenant_id, source_doc_type, source_doc_id) DO NOTHING
     RETURNING id, version`,
    [
      id,
      command.tenantId,
      command.companyId,
      orderNo,
      command.sourceDocType,
      command.sourceDocId,
      command.totalSaleAmount,
      command.totalCostAmount,
      relatedLoss,
      command.commissionRateSnapshot,
      command.commissionAmount,
    ],
  );

  const row = inserted.rows[0];
  if (!row) {
    throw new AppError('VERSION_CONFLICT', '该来源单据已生成过 C 结算单草稿（D19 一单一次）', {
      sourceDocType: command.sourceDocType,
      sourceDocId: command.sourceDocId,
    });
  }

  const auditId = await appendAudit(tx, {
    tenantId: command.tenantId,
    companyId: command.companyId,
    actorType: 'employee',
    actorId: command.createdBy,
    source: 'api',
    action: 'settlement.draft.create',
    objectType: 'settlement_order',
    objectId: id,
    changeSummary: {
      orderNo,
      sourceDocType: command.sourceDocType,
      sourceDocId: command.sourceDocId,
      totalSaleAmount: command.totalSaleAmount,
      totalCostAmount: command.totalCostAmount,
      relatedLossAmount: relatedLoss,
    },
    result: 'success',
    requestId: command.requestId ?? `port-${id}`,
  });

  return { id, orderNo, version: row.version, auditId };
}

/** settlement 对外端口实现（D70）。 */
export const settlementServices: Pick<ServiceRegistry, 'settlementDraft'> = {
  settlementDraft: { createDraft: createSettlementDraft },
};
