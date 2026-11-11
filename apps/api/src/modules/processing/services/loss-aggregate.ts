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
  }>(
    `SELECT id::text AS id,
            order_no,
            trim_scale(loss_amount) AS loss_amount
       FROM processing_order
      WHERE tenant_id = $1
        AND company_id = ANY($2::uuid[])
        AND status = '已完成'
        AND loss_amount IS NOT NULL
        AND updated_at >= $3::date
        AND updated_at < ($4::date + 1)`,
    [query.tenantId, query.companyIds, query.periodStart, query.periodEnd],
  );
  const orders = result.rows.map((row) => ({
    processingOrderId: row.id,
    processingOrderNo: row.order_no,
    lossAmount: String(row.loss_amount),
    attributed: false,
  }));
  const total = orders.reduce((sum, row) => {
    const [whole, fraction = ''] = row.lossAmount.split('.');
    return sum + BigInt(whole ?? '0') * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  }, 0n);
  const whole = total / 1_000_000n;
  const fraction = (total % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return {
    lossAmount: fraction ? whole.toString() + '.' + fraction : whole.toString(),
    orders,
  };
}

export const processingLossAggregateService: ProcessingLossAggregateSource = {
  aggregateFullLoss,
};
