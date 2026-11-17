import type { SqlClient } from '../../../platform/db/client.js';
import type {
  ProcessingLossAggregate,
  ProcessingLossAggregateSource,
  ProfitAggregateQuery,
} from '../../../platform/services/registry.js';

/** B 单完成快照的期间损耗聚合；report 只通过该端口读取。 */
export async function aggregateFullLoss(
  tx: SqlClient,
  query: ProfitAggregateQuery,
): Promise<ProcessingLossAggregate> {
  const result = await tx.query<{
    id: string;
    order_no: string;
    loss_amount: string | number;
    partial_loss_amount: string | number | null;
  }>(
    `SELECT id::text AS id,
            order_no,
            trim_scale(loss_amount) AS loss_amount,
            trim_scale(partial_loss_amount) AS partial_loss_amount
       FROM processing_order
      WHERE tenant_id = $1
        AND company_id = ANY($2::uuid[])
        AND status = '已完成'
        AND loss_amount IS NOT NULL
        AND updated_at >= $3::date
        AND updated_at < ($4::date + 1)`,
    [query.tenantId, query.companyIds, query.periodStart, query.periodEnd],
  );
  const orders = result.rows.map((row) => {
    const lossType: 'full' | 'partial' = row.partial_loss_amount !== null && String(row.partial_loss_amount) !== '0' ? 'partial' : 'full';
    return {
    processingOrderId: row.id,
    processingOrderNo: row.order_no,
    lossAmount: String(row.loss_amount),
    lossType,
    attributed: false,
    };
  });
  const fullLossAmount = orders.filter((row) => row.lossType === 'full').reduce((sum, row) => addDecimalStrings(sum, row.lossAmount), '0');
  return {
    lossAmount: fullLossAmount,
    partialLossAmount: orders.filter((row) => row.lossType === 'partial').reduce((sum, row) => addDecimalStrings(sum, row.lossAmount), '0'),
    orders,
  };
}

function addDecimalStrings(left: string, right: string): string {
  const [leftWhole, leftFraction = ''] = left.split('.');
  const [rightWhole, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const total = BigInt(`${leftWhole}${leftFraction.padEnd(scale, '0')}`) + BigInt(`${rightWhole}${rightFraction.padEnd(scale, '0')}`);
  if (scale === 0) return total.toString();
  const text = total.toString().padStart(scale + 1, '0');
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
}

export const processingLossAggregateService: ProcessingLossAggregateSource = {
  aggregateFullLoss,
};
