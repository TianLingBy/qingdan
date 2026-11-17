import { normalizeDedupeName, normalizePhone, normalizeSpec } from './normalize.js';
import { similarity } from './trigram.js';

/**
 * 疑似重复的判定口径（#302 块 C 前半段 / D100，设计 §四）。
 *
 * 判定顺序**命中即停**，与设计 §四 的表逐条对应：
 *   ① 同公司内电话数字相同 → 1.0 / `name_phone`（客户、供应商；加工厂表没有电话列）
 *   ② 名称规范化后完全相同 → 1.0 / `name_only`
 *   ③ 名称 trigram Jaccard ≥ 0.85 → 分数原值 / `name_only`
 *   ④ 商品：名称 ≥ 0.7 → 分数原值 / `name_only`，规格不同则 `note='同名不同规格'`
 *
 * 顺序不能换：电话相同是最强证据（同名不同号可能是重名，同号不同名几乎一定是同一家），
 * 先判电话可以避免「名字恰好不像」的同号档案被阈值挡掉。
 */

/**
 * 人、厂、客户这类「按名字认人」的档案：0.85。
 *
 * 为什么是 0.85 而不是 0.8 或 0.9：中文店名平均 4–6 字，trigram 集合只有 2–4 个元素，
 * 差一个字就掉 0.3 左右，0.9 会把「张记建材」/「张记建材店」也挡在外面；
 * 而 0.8 又开始把「张记建材」/「张记五金」这类**只共享前缀**的名字推上队列。
 * 0.85 落在「差一个字（共享大部分 gram）能进、只共享地名不能进」这一档上。
 * 这个数是提示用的，判错的代价只是审核台多一条待办，所以宁松不严。
 */
export const NAME_THRESHOLD = 0.85;

/**
 * 商品：0.7。
 *
 * 低于人名的 0.85，因为商品名普遍更长（`φ20 热轧螺纹钢 HRB400`），
 * 同样差一个规格词，长名字的 Jaccard 掉得更多（分母更大）；
 * 0.85 会让「螺纹钢 HRB400」/「螺纹钢 HRB500」永远进不来。
 * 规格相同才用这一档；规格不同时仍然入队（设计 §四 的强规则：同名商品必提示），
 * 只是打上 `note='同名不同规格'`，让人工判断是「另起一条」还是「合成为多规格商品」。
 */
export const PRODUCT_THRESHOLD = 0.7;

export type DedupeKind = 'customer' | 'supplier' | 'processor' | 'product';

/** 命中依据。`alias` 由审核台的别名匹配使用，本块不会产出（见文件末尾注释）。 */
export type MatchedBy = 'name_only' | 'name_phone' | 'alias';

/** 商品规格不同时写进队列的备注（设计 §四 原文）。 */
export const SAME_NAME_DIFF_SPEC_NOTE = '同名不同规格';

export interface JudgeInput {
  readonly kind: DedupeKind;
  readonly incomingName: string;
  readonly incomingSpec?: string | null;
  readonly incomingPhone?: string | null;
  readonly candidateName: string;
  readonly candidateSpec?: string | null;
  readonly candidatePhone?: string | null;
}

export interface JudgeResult {
  readonly score: number;
  readonly matchedBy: MatchedBy;
  readonly note: string | null;
}

/** 电话太短就不是「同一个号」，而是「都填了个 1」这类脏数据；至少 7 位才参比。 */
const MIN_PHONE_DIGITS = 7;

/**
 * 判定一条「新档案 vs 既有档案」是不是疑似重复。
 * 返回 `null` 表示不够阈值、不提示；返回结果表示应当进审核队列。
 *
 * 纯函数：不查库、不读时钟，方便直接单测，也保证同一对档案每次判定结果一致
 * （幂等写队列的前提——`recordDedupeCandidate` 冲突更新时不会因为抖动改分数）。
 */
export function judgeCandidate(input: JudgeInput): JudgeResult | null {
  const incomingName = normalizeDedupeName(input.incomingName);
  const candidateName = normalizeDedupeName(input.candidateName);

  // ① 电话相同：最强证据，与名字像不像无关（同名不同号常见，同号不同名几乎不存在）。
  const incomingPhone = normalizePhone(input.incomingPhone);
  const candidatePhone = normalizePhone(input.candidatePhone);
  if (
    incomingPhone !== null &&
    candidatePhone !== null &&
    incomingPhone.length >= MIN_PHONE_DIGITS &&
    incomingPhone === candidatePhone
  ) {
    return { score: 1, matchedBy: 'name_phone', note: null };
  }

  if (incomingName === '' || candidateName === '') return null;

  // ② 名称规范化后完全相同：商品也走这条，且**无论规格**都进队列（设计 §四 强规则）。
  if (incomingName === candidateName) {
    return { score: 1, matchedBy: 'name_only', note: specNote(input) };
  }

  const score = similarity(incomingName, candidateName);

  // ③④ 阈值分档：商品 0.7，其余 0.85。
  const threshold = input.kind === 'product' ? PRODUCT_THRESHOLD : NAME_THRESHOLD;
  if (score < threshold) return null;

  return { score, matchedBy: 'name_only', note: specNote(input) };
}

/**
 * 商品规格不同的备注。非商品（客户/供应商/加工厂没有规格概念）一律 null，
 * 免得审核台在人名那栏看到一句「同名不同规格」。
 */
function specNote(input: JudgeInput): string | null {
  if (input.kind !== 'product') return null;
  const incoming = normalizeSpec(input.incomingSpec);
  const candidate = normalizeSpec(input.candidateSpec);
  return incoming === candidate ? null : SAME_NAME_DIFF_SPEC_NOTE;
}

/*
 * 为什么本块不产出 `matched_by='alias'`：
 * 别名只存在于 `product.aliases`，而「开单即建档」带出来的新商品没有别名可匹配；
 * 别名命中属于审核台「手动搜一遍」的场景（块 C 后半段），到那时补
 * `aliases` 的判定分支，`MatchedBy` 联合类型已经预留了这个值，不用再改契约。
 */
