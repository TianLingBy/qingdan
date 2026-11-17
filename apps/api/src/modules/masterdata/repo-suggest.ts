import type { SqlClient } from '../../platform/db/client.js';
import type { SuggestSource } from './name-similarity.js';

/**
 * suggest 的粗筛查询（#302 块 B）。
 *
 * 只做「把名字里含查询片段的行捞回来」这一件事，不打分 —— 打分在 `name-similarity.ts`。
 * 分层的原因：仓库不装 pg_trgm，SQL 里没有可靠的相似度函数，应用层算又不能让候选集无限大，
 * 于是先把候选用 `ILIKE` 收到 200 条以内，再逐条算 bigram Dice。
 *
 * 表名来自 `SuggestKind` 这个字面量联合类型（编译期白名单），不是用户输入，可以拼进 SQL。
 */

export type SuggestKind = 'customer' | 'supplier' | 'processor' | 'product';

export interface SuggestRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

/**
 * 候选上限 200：四张档案表在单公司内通常是几十到几百条（客户/商品上千的公司极少），
 * 200 条足够兜住「这家公司所有名字里含该片段」的档案；再往上加只是让内存里多算几千次
 * Dice，收益为零（D99）。
 */
const COARSE_LIMIT = 200;

/** LIKE / ILIKE 模式串里的通配符转义，避免用户把 `%`、`_` 当查询语法。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * 粗筛：租户 + 可见公司内，名字包含 `needle` 的档案。
 *
 * - `needle` 传的是剥过后缀的核心名（`张记建材经营部` → `张记建材`），
 *   否则用户把后缀也打全时反而匹配不到库里只写 `张记建材` 的档案；
 * - 排序让「本公司」「名字短」的行排在前面，它们在 200 条上限里更可能是用户想要的；
 * - 返回顺序即同分候选的展示顺序（`rankCandidates` 用的是稳定排序）。
 */
export async function suggestSources(
  ctx: SuggestRepoContext,
  kind: SuggestKind,
  needle: string,
  targetCompanyId: string,
): Promise<SuggestSource[]> {
  const pattern = escapeLike(needle);
  const result = await ctx.tx.query<{ id: string; company_id: string; name: string }>(
    `SELECT s.id, s.company_id, s.name
       FROM ${kind} s
      WHERE s.tenant_id = $1
        AND s.company_id = ANY($2::uuid[])
        AND (s.name ILIKE ($3 || '%') ESCAPE '\\' OR s.name ILIKE ('%' || $3 || '%') ESCAPE '\\')
      ORDER BY (s.company_id = $4::uuid) DESC, length(s.name) ASC
      LIMIT ${COARSE_LIMIT}`,
    [ctx.tenantId, [...ctx.companyIds], pattern, targetCompanyId],
  );
  return result.rows.map((row) => ({ id: row.id, companyId: row.company_id, name: row.name }));
}
