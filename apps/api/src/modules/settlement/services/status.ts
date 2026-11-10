import type { SqlClient } from '../../../platform/db/client.js';
import type {
  ServiceRegistry,
  SettlementStatusFact,
  SettlementStatusQuery,
} from '../../../platform/services/registry.js';

/**
 * settlement 对 inventory 暴露的「来源单是否已结算」只读端口（Issue #163 / D70）。
 *
 * `settlement_order` 没有 batch_id，只能按来源单（E / N）判断：
 * inventory 先经 processing / sales 端口拿到引用单据，再经这里查询这些单据
 * 是否已生成结算单 —— 已生成即视为「已进入结算」，成本锁定（T3）。
 *
 * 只读 SELECT，不写审计、不开事务；租户上下文由调用方 `withTenant` 保证。
 */
async function findSettlements(
  tx: SqlClient,
  query: SettlementStatusQuery,
): Promise<ReadonlyArray<SettlementStatusFact>> {
  if (query.sourceDocs.length === 0) return [];

  const seen = new Set<string>();
  const docs = query.sourceDocs.filter((doc) => {
    const key = `${doc.docType}:${doc.docId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const params: string[] = [query.tenantId, query.companyId];
  const clauses = docs.map((doc) => {
    params.push(doc.docType, doc.docId);
    const typeParam = `$${params.length - 1}`;
    const idParam = `$${params.length}`;
    return `(s.source_doc_type = ${typeParam} AND s.source_doc_id = ${idParam}::uuid)`;
  });

  const result = await tx.query<{
    source_doc_type: string;
    source_doc_id: string;
    status: string;
  }>(
    `
      SELECT s.source_doc_type, s.source_doc_id::text AS source_doc_id, s.status
      FROM settlement_order s
      WHERE s.tenant_id = $1
        AND s.company_id = $2
        AND (${clauses.join(' OR ')})
    `,
    params,
  );

  return result.rows.map((row) => ({
    docType: row.source_doc_type,
    docId: row.source_doc_id,
    status: row.status,
  }));
}

/** settlement 对外端口实现（结算状态，D70 / Issue #163）。 */
export const settlementStatusServices: Pick<ServiceRegistry, 'settlementStatus'> = {
  settlementStatus: { findSettlements },
};
