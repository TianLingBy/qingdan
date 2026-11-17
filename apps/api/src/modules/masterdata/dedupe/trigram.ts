/**
 * 字符 n-gram 集合与 Jaccard 系数（#302 块 C 前半段 / D100）。
 *
 * 为什么不用 pg_trgm：迁移要能在 PGlite 内存库与离线环境原样跑通，装扩展就不是纯 SQL 了
 * （块 A 迁移头注释与 D99 都写了这一条），所以打分一律在应用层、纯 JS、零依赖。
 *
 * 为什么是 Jaccard（`|A∩B| / |A∪B|`）而不是块 B 的 Dice：
 * 设计 §四 明确写的是 Jaccard，且 Jaccard 对「一边明显更长」的情况惩罚更重——
 * 去重判定要的是「短名字被长名字吃掉」时的保守，Dice 会给出偏高分数把不该并的也推进队列。
 * 这也意味着**本文件的分数与块 B 的 `diceSimilarity` 不可互换**，阈值各自独立标定。
 */

/** `trigram` 的窗口大小；短串见下面的兜底分支。 */
const GRAM_SIZE = 3;

/**
 * 取字符 n-gram 集合。
 *
 * - 长度 ≥ 3：3 字符滑窗；
 * - 长度 = 2：退化成 bigram（整串一个元素）；
 * - 长度 = 1：单字符集合。
 *
 * **为什么短串必须兜底**：「张记」两个字的 trigram 集合是**空集**，
 * 空集与任何集合的 Jaccard 都是 0，等于「两字店名永远不提示重复」——
 * 而中文里两字、三字店名是最常见的。所以短于窗口长度的串按 `min(长度, 2)` 切。
 * 代价是不同长度的串互相比较时 gram 不齐（「张记」的 bigram 对「张记建材」的 trigram），
 * 分数偏低——这正是想要的保守方向：**名称完全相同已在 `judgeCandidate` 里单独命中 1.0**，
 * 这里只负责「写得不一样但很像」的那一档。
 */
export function trigrams(value: string): Set<string> {
  const grams = new Set<string>();
  if (value === '') return grams;
  const size = value.length >= GRAM_SIZE ? GRAM_SIZE : Math.min(value.length, 2);
  if (value.length <= size) {
    grams.add(value);
    return grams;
  }
  for (let i = 0; i <= value.length - size; i += 1) {
    grams.add(value.slice(i, i + size));
  }
  return grams;
}

/**
 * Jaccard 相似度，保留 3 位小数（与 `masterdata_dedupe.score numeric(4,3)` 对齐，
 * 免得同一个分数在 JS 里是 0.8500000000000001、落库变 0.850、回读又不相等）。
 */
export function similarity(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  let intersection = 0;
  for (const gram of left) {
    if (right.has(gram)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  if (union === 0) return 0;
  return Math.round((intersection / union) * 1000) / 1000;
}
