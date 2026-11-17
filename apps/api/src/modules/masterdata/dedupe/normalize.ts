/**
 * 名称规范化（#302 块 C 前半段 / D100）。
 *
 * **只做四件事**：NFKC（全角→半角）、压空白、trim、小写。
 *
 * 为什么**不**像块 B 的 `name-similarity.normalizeName` 那样把括号里的备注也去掉：
 * 「张记（老店）」和「张记」在设计 §四里是两家不同的店（分店要单独算账），
 * 抹平括号内容会让它们直接变成同一条，去重队列就再也提示不出来了。
 * 块 B 那份是给「候选提示」用的宽松口径（宁可多提示），这里是给「疑似重复判定」用的
 * 严格口径（宁可不合并），两者故意不共用同一个函数。
 *
 * 空白压成一个而不是全删：「张 记 建材」和「张记建材」在中文里是两种写法，
 * 但「Zhang  Ji」与「Zhang Ji」只是多打了空格；压成一个空格能同时照顾英文单词边界，
 * 而中文多打空格的情况本来就少见，留着比抹掉更安全（抹掉会把两个英文单词粘成一个词）。
 *
 * **函数名带 `Dedupe` 是刻意的**：块 B 的 `name-similarity.ts` 里也有一个 `normalizeName`，
 * 语义不同（那份去括号）且阈值独立标定。两者若同名，任何一次「顺手 import」都可能
 * 把去重的严格口径换成候选提示的宽松口径，且改动后测试仍然全绿——这种错很难在 review 里看出来。
 */
export function normalizeDedupeName(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * 电话规范化：只留数字。
 * `138-0013-8000` / `138 0013 8000` / `+86 13800138000` 在业务上是同一个号；
 * 保留 `+86` 这类区号差异不管——两名员工录入风格不同时，多一条待办比漏掉一条安全。
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.replace(/\D+/g, '');
  return digits === '' ? null : digits;
}

/**
 * 规格规范化：商品规格是自由文本（`500ml*12` / `500ML × 12`），
 * 判「规格是否相同」时按同样四件事抹平，否则同一箱货会被判成不同规格。
 */
export function normalizeSpec(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  return normalizeDedupeName(raw);
}
