import type { SqlClient } from '../../../platform/db/client.js';
import type {
  DownstreamReferenceQuery,
  ServiceRegistry,
} from '../../../platform/services/registry.js';

/**
 * sales 对 inventory 暴露的「批次下游引用」只读端口（Issue #163 / D70）。
 *
 * 覆盖两类引用：
 *   - E 销售单引用的批次（`sales_order_line_batch`）；
 *   - R 客户退货引用的批次（`customer_return_line_batch`）。
 * 已取消的单据不算有效引用。只读 SELECT，不写审计、不开事务；
 * 租户上下文由调用方 `withTenant` 保证。
 */
async function findBatchReferences(
  tx: SqlClient,
  query: DownstreamReferenceQuery,
): Promise<ReadonlyArray<{ docType: string; docId: string; status: string }>> {
  const result = await tx.query<{ doc_type: string; doc_id: string; status: string }>(
    `
      SELECT DISTINCT
        'E'::text AS doc_type,
        o.id::text AS doc_id,
        o.status
      FROM sales_order_line_batch lb
      JOIN sales_order o
        ON o.id = lb.order_id
       AND o.tenant_id = lb.tenant_id
       AND o.company_id = lb.company_id
      WHERE lb.tenant_id = $1
        AND lb.company_id = $2
        AND lb.batch_id = $3
        AND o.status <> '已取消'
      UNION
      SELECT DISTINCT
        'R'::text AS doc_type,
        r.id::text AS doc_id,
        r.status
      FROM customer_return_line_batch rb
      JOIN customer_return r
        ON r.id = rb.return_id
       AND r.tenant_id = rb.tenant_id
       AND r.company_id = rb.company_id
      WHERE rb.tenant_id = $1
        AND rb.company_id = $2
        AND rb.batch_id = $3
        AND r.status <> '已取消'
    `,
    [query.tenantId, query.companyId, query.batchId],
  );
  return result.rows.map((row) => ({
    docType: row.doc_type,
    docId: row.doc_id,
    status: row.status,
  }));
}

/** sales 对外端口实现（下游引用聚合，D70 / Issue #163）。 */
export const salesReferenceServices: Pick<ServiceRegistry, 'salesReferences'> = {
  salesReferences: { module: 'sales', findBatchReferences },
};
