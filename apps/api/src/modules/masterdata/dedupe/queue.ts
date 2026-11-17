import { v7 as uuidv7 } from 'uuid';
import type { SqlClient } from '../../../platform/db/client.js';
import type { DedupeKind, MatchedBy } from './thresholds.js';

/**
 * 疑似重复队列写入（#302 块 C 前半段 / D100）。
 *
 * 表是块 A 迁移（`20261117223000_masterdata_autocreate.sql`）建好的，本文件只写不建；
 * **列名与取值一律以迁移为准**，与设计文档不一致的地方见下面两处注释。
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

/**
 * 备注列编码：`<matched_by>` 或 `<matched_by>|<人工备注>`。
 *
 * **为什么把 matched_by 塞进 note**：设计 §三 的队列表有独立 `matched_by` 列，
 * 但块 A 落地时没建（迁移里只有 score / note / state），而本次明确不许新增迁移、
 * 不许改既有列名。两个信息都要留给审核台，`note` 是唯一的自由文本列，
 * 于是约定用它承载：解析交给本文件的 `parseDedupeNote`，调用方不要自己 `split('|')`。
 * 块 C 后半段若能补列，这个编解码就是唯一需要改的地方。
 */
const NOTE_SEPARATOR = '|';

export function encodeDedupeNote(matchedBy: MatchedBy, note: string | null | undefined): string {
  return note ? `${matchedBy}${NOTE_SEPARATOR}${note}` : matchedBy;
}

export function parseDedupeNote(raw: string | null): {
  matchedBy: MatchedBy | null;
  note: string | null;
} {
  if (raw === null || raw === '') return { matchedBy: null, note: null };
  const index = raw.indexOf(NOTE_SEPARATOR);
  if (index === -1) return { matchedBy: raw as MatchedBy, note: null };
  return {
    matchedBy: raw.slice(0, index) as MatchedBy,
    note: raw.slice(index + 1) || null,
  };
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
 * - **冲突时只更新分数与备注、不动 state**：同一对子被再次命中说明证据更强（或重复触发），
 *   但人工已经判过的结论（merged / kept）不该被一次新开单推翻——重新打开会让人白判一遍。
 *   `GREATEST` 保留较大分数，避免「先 0.86 后 0.85」把分数改低。
 */
export async function recordDedupeCandidate(
  tx: SqlClient,
  input: DedupePairInput,
): Promise<void> {
  const [leftId, rightId] =
    input.leftId < input.rightId ? [input.leftId, input.rightId] : [input.rightId, input.leftId];
  await tx.query(
    `INSERT INTO masterdata_dedupe
       (id, tenant_id, company_id, kind, left_id, right_id, score, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT ON CONSTRAINT masterdata_dedupe_pair_key
     DO UPDATE SET score = GREATEST(masterdata_dedupe.score, EXCLUDED.score),
                   note  = EXCLUDED.note`,
    [
      uuidv7(),
      input.tenantId,
      input.companyId,
      input.kind,
      leftId,
      rightId,
      round3(input.score),
      encodeDedupeNote(input.matchedBy, input.note ?? null),
    ],
  );
}
