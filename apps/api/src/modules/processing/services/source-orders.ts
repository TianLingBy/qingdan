import type { SqlClient } from '../../../platform/db/client.js';
import type {
  ServiceRegistry,
  SourceOrderStatusFact,
  SourceOrderStatusQuery,
} from '../../../platform/services/registry.js';

/**
 * processing 对 E 单签收暴露的「来源加工单状态」只读端口（D94 ③ / D70）。
 *
 * E 单签收时按批次反查出 `source_doc_type='B'` 的加工单，本文件只读
 * `processing_order` 单头的单号与状态，供 sales 判定「来源单是否全部已完成」。
 * 只读 SELECT、不做 scope 判定；租户上下文由调用方 `withTenant` 保证。
 */
async function lookupStatuses(
  tx: SqlClient,
  query: SourceOrderStatusQuery,
): Promise<readonly SourceOrderStatusFact[]> {
  if (query.docs.length === 0) return [];
  const orderIds = query.docs.map((doc) => doc.id);
  const result = await tx.query<{
    id: string;
    order_no: string;
    status: string;
  }>(
    `SELECT id::text AS id, order_no, status
       FROM processing_order
      WHERE tenant_id = $1
        AND company_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [query.tenantId, query.companyId, orderIds],
  );
  return result.rows.map((row) => ({
    type: 'B' as const,
    id: row.id,
    orderNo: row.order_no,
    status: row.status,
  }));
}

/** processing 对外端口实现（D70）：来源加工单状态只读。 */
export const processingSourceOrderServices: Pick<
  ServiceRegistry,
  'processingSourceOrders'
> = {
  processingSourceOrders: { docType: 'B', lookupStatuses },
};
