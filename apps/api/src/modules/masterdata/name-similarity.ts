import type { SuggestCandidate } from '@qingdan/contracts';

/**
 * 档案名相似度（#302 块 B / D99）。
 *
 * 为什么不用 pg_trgm：仓库刻意不装扩展（迁移要能在 PGlite 内存库、托管 PG、离线环境
 * 都原样跑通），所以「粗筛」交给 SQL 的 `ILIKE`，「打分」在这里做 —— 无依赖、O(n)、
 * 中文直接按字符 bigram 切，不需要分词词典。
 *
 * 三个函数的职责分得很开，改任何一处都要同时想另外两处：
 *   normalizeName  把「同一家的不同写法」抹平（全角/空格/括号备注/大小写）
 *   nameCore       再剥掉组织形态后缀（有限公司 / 经营部 / 店 …）后才用于打分
 *   rankCandidates 组合上面的结果，给出候选与理由
 */

/** 进候选的门槛：bigram 有一半重合才提示。详见 D99「阈值为什么是 0.5」。 */
export const SUGGEST_MIN_SCORE = 0.5;

/** 剥完后缀完全一样、但原始名称不同（`张记建材` vs `张记建材有限公司`）时给的分。 */
const SCORE_SAME_CORE = 0.95;

/** 粗筛后进入打分的候选来源（repo 只取这三列，别在这里扩字段）。 */
export interface SuggestSource {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 规范化：NFKC 抹平全角（`Ａ`→`a`、`１２`→`12`、`（）`→`()`），
 * 去掉括号里的备注（`张记建材（新厂）` 与 `张记建材` 是同一家），
 * 再去空白、转小写。中文名里这些差异全是写法差异，不该算进相似度。
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[(\[【][^)\]】]*[)\]】]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * 组织形态后缀：`张记建材` / `张记建材店` / `张记建材经营部` 在业务上是同一家，
 * 不剥掉的话 bigram Dice 会把后缀算成「不重合部分」，把 0.95 压到 0.67（见 D99）。
 * 只剥尾部、且剥完至少留 2 个字，免得把「店」「行」这种单字名字剥空。
 */
const ORG_SUFFIX = /(有限责任公司|股份有限公司|有限公司|分公司|公司|经营部|门市部|经销部|批发部|商行|商店|店|厂|集团|中心|超市)$/;

export function nameCore(normalized: string): string {
  let core = normalized;
  // 最多剥三层：`张记建材有限公司经营部` 这种叠加写法也能收敛到 `张记建材`。
  for (let i = 0; i < 3; i += 1) {
    const next = core.replace(ORG_SUFFIX, '');
    if (next === core || next.length < 2) break;
    core = next;
  }
  return core;
}

/** 字符 bigram 计数（长度 1 的串退化成它自己，避免空集合除以零）。 */
function bigramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (value.length < 2) {
    counts.set(value, 1);
    return counts;
  }
  for (let i = 0; i < value.length - 1; i += 1) {
    const gram = value.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function totalCount(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

/** bigram Dice 系数 `2*|A∩B| / (|A|+|B|)`：O(n)，对称，对短名字不敏感。 */
export function diceSimilarity(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  const left = bigramCounts(a);
  const right = bigramCounts(b);
  let overlap = 0;
  for (const [gram, count] of left) {
    overlap += Math.min(count, right.get(gram) ?? 0);
  }
  return (2 * overlap) / (totalCount(left) + totalCount(right));
}

export interface NameScore {
  readonly score: number;
  readonly reason: string;
}

/**
 * 单个名字打分。
 * - 规范化后完全相同 → 1：这是最危险的情况（用户以为系统没拦住），必须单独标出来；
 * - 剥后缀后相同 → 0.95：`张记建材` vs `张记建材经营部`，只差组织形态；
 * - 其余按 bigram Dice 打分，0.75 以上算「高度相似」，否则「部分相似」。
 */
export function scoreName(query: string, candidateName: string): NameScore {
  const normalizedQuery = normalizeName(query);
  const normalizedCandidate = normalizeName(candidateName);
  if (normalizedQuery === normalizedCandidate) return { score: 1, reason: '名称完全相同' };
  const queryCore = nameCore(normalizedQuery);
  const candidateCore = nameCore(normalizedCandidate);
  if (queryCore === candidateCore) return { score: SCORE_SAME_CORE, reason: '名称高度相似' };
  const score = round3(diceSimilarity(queryCore, candidateCore));
  return { score, reason: score >= 0.75 ? '名称高度相似' : '名称部分相似' };
}

/**
 * 打分 + 排序 + 截断。纯函数，便于直接单测。
 *
 * 别的公司的档案只在「规范化后完全同名」时提示，理由见 D99：
 * 相似但不同名的别家档案一律不露面，否则这个接口就成了跨公司客户探测入口。
 */
export function rankCandidates(
  query: string,
  targetCompanyId: string,
  sources: readonly SuggestSource[],
  limit: number,
): SuggestCandidate[] {
  const normalizedQuery = normalizeName(query);
  const candidates: SuggestCandidate[] = [];
  for (const source of sources) {
    if (source.companyId !== targetCompanyId) {
      if (normalizeName(source.name) === normalizedQuery) {
        candidates.push({ id: source.id, name: source.name, score: 1, reason: '名称相同但公司不同' });
      }
      continue;
    }
    const { score, reason } = scoreName(query, source.name);
    if (score < SUGGEST_MIN_SCORE) continue;
    candidates.push({ id: source.id, name: source.name, score, reason });
  }
  // 稳定排序：同分时保留 SQL 的「本公司优先、名字短优先」顺序。
  candidates.sort((left, right) => right.score - left.score);
  return candidates.slice(0, limit);
}
