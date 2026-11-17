import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../../platform/db/client.js';
import type { DedupeKind, MatchedBy } from './thresholds.js';

/**
 * 疑似重复队列写入（#302 块 C 前半段 / D100）。
 *
 * 表是块 A 迁移（`20261117223000_masterdata_autocreate.sql`）建好的，本文件只写不建；
 * 块 C 后半段补了 `matched_by` 独列（`20261118030000_masterdata_dedupe_matched_by.sql` / D102），
 * 命中依据不再编进 `note`。
 */

export interface DedupePairInput {
  readonly tenantId: string;
  readonly companyId: string;
  readonly kind: DedupeKind;
  /** 对子的一侧（档案 id）。谁新谁旧见 `recordDedupeCandidate` 的注释。 */
  readonly leftId: string;
  readonly rightId: string;
  readonly score: number;
  readonly matchedBy: MatchedBy;
  /** 人工看的一句话备注，目前只有商品的「同名不同规格」。 */
  readonly note?: string | null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 记一条疑似重复（幂等）。
 *
 * - **左右按字典序固定**（小的一侧放 left_id），因为唯一的约束是
 *   `UNIQUE (kind, left_id, right_id)`——它不知道对称性。不排序的话，
 *   A 先建 B 后建记成 (A,B)，反过来的录入顺序又记成 (B,A)，同一个对子会在
 *   审核台出现两条，合并一条后另一条还挂着，变成永远处理不完的假待办。
 *   代价：`left_id` 不再等于「已有档案」（迁移注释是那么写的），审核台要看新旧
 *   只能读 `origin` / `dedupe_state` 或对子两侧的 `created_at`。
 * - **冲突时只更新分数、命中依据与备注、不动 state**：同一对子被再次命中说明证据更强
 *   （或重复触发），但人工已经判过的结论（merged / kept）不该被一次新开单推翻——
 *   重新打开会让人白判一遍。`GREATEST` 保留较大分数，避免「先 0.86 后 0.85」把分数改低。
 *   注：保持 kept 状态的这条，就是「判为不同之后不再提示」的实现位置（唯一约束 +
 *   不重置 state）；要撤销只能走审核台的 reopen（D102）。
 */
export async function recordDedupeCandidate(
  tx: SqlClient,
  input: DedupePairInput,
): Promise<void> {
  const [leftId, rightId] =
    input.leftId < input.rightId ? [input.leftId, input.rightId] : [input.rightId, input.leftId];
  await tx.query(
    `INSERT INTO masterdata_dedupe
       (id, tenant_id, company_id, kind, left_id, right_id, score, matched_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ON CONSTRAINT masterdata_dedupe_pair_key
     DO UPDATE SET score      = GREATEST(masterdata_dedupe.score, EXCLUDED.score),
                   matched_by = EXCLUDED.matched_by,
                   -- 备注只放人工信息：新一次命中没带备注时不要把已有备注抹掉。
                   note       = COALESCE(EXCLUDED.note, masterdata_dedupe.note)`,
    [
      uuidv7(),
      input.tenantId,
      input.companyId,
      input.kind,
      leftId,
      rightId,
      round3(input.score),
      input.matchedBy,
      input.note ?? null,
    ],
  );
}
