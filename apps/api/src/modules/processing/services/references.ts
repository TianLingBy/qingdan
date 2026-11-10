import type { SqlClient } from '../../../platform/db/client.js';
import type {
  DownstreamReferenceQuery,
  DownstreamReferenceSource,
  ServiceRegistry,
} from '../../../platform/services/registry.js';

/**
 * processing 对 inventory 暴露的「批次下游引用」只读端口（Issue #163 / D70）。
 *
 * inventory 判成本更正档位时需要知道「这个批次有没有被加工单引用」，
 * 但不得直读 processing 的表（D70）——因此由 processing 自己实现这份只读 SELECT。
 *
 * - 只读、无副作用：不写审计、不改单据、不开事务；
 * - 租户上下文由调用方 `withTenant` 保证，这里不重复判定 scope；
 * - 已取消的加工单不算有效引用（取消后不再占用该批次）。
 */
async function findBatchReferences(
  tx: SqlClient,
  query: DownstreamReferenceQuery,
): Promise<ReadonlyArray<{ docType: string; docId: string; status: string }>> {
  const result = await tx.query<{ doc_type: string; doc_id: string; status: string }>(
    `
      SELECT DISTINCT
        'B'::text AS doc_type,
        o.id::text AS doc_id,
        o.status
      FROM processing_order_material_batch mb
      JOIN processing_order o
        ON o.id = mb.order_id
       AND o.tenant_id = mb.tenant_id
       AND o.company_id = mb.company_id
      WHERE mb.tenant_id = $1
        AND mb.company_id = $2
        AND mb.batch_id = $3
        AND o.status <> '已取消'
      UNION
      SELECT DISTINCT
        'B'::text AS doc_type,
        o.id::text AS doc_id,
        o.status
      FROM processing_order o
      WHERE o.tenant_id = $1
        AND o.company_id = $2
        AND o.output_batch_id = $3
        AND o.status <> '已取消'
    `,
    [query.tenantId, query.companyId, query.batchId],
  );
  return result.rows.map((row) => ({
    docType: row.doc_type,
    docId: row.doc_id,
    status: row.status,
  }));
}

/** processing 对外端口实现（D70）。 */
export const processingServices: Pick<ServiceRegistry, 'processingReferences'> = {
  processingReferences: { module: 'processing', findBatchReferences },
};
