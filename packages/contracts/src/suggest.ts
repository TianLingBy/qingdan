import { z } from 'zod';

/**
 * 主数据「建档防重」suggest 契约（D99 / #302 块 B）。
 *
 * 场景：销售在开单 / 建档页面手打客户名，打完时提示「已有相似档案：张记建材经营部（95%）」，
 * 点一下直接用，不再新建一条重复档案。
 *
 * 为什么四张档案表（customer / supplier / processor / product）共用一份 schema：
 * 入参出参完全一致，只差路径与权限域；各抄四份只会让「加一个字段」变成四次改动。
 */

/**
 * 入参。
 * - `name` 是用户边打边查的半成品名字：最少 2 个字、上限 100。最少 2 字不只是性能考量——
 *   单字查询（「张」）会把粗筛的 200 条占满，等于免费得到「本公司所有张姓客户」，
 *   比翻列表还省事；上限 100 则与各档案 `name` 的 64 不同口径，宁可多收几个字也别在打字中报错。
 * - `limit` 上限 20、缺省 5：不给「一次拉一大把」的机会（详见 D99 关于枚举风险的说明）。
 *   这里用 `.optional()` + 用例层补默认值，而不是 zod 的 `.default()`：带 default 的参数在
 *   生成的 OpenAPI 里会被标成 `required: true`（required 取自解析后的输出类型），
 *   而实际上缺省是合法的——契约不许撒谎（D95 同一原则）。
 * - `companyId` **必传**：principal 只有「可见公司集合」，集合顺序由授权查询决定、不是用户当前选中的公司。
 *   若服务端拿 `companyIds[0]` 兜底，用户在 A 公司开单页打字时可能看到 B 公司的客户名，
 *   既漏了别家客户名，又会引导他真去建一条 B 公司的档案，而且全程不报错。
 *   前端开单页本来就有公司选择器，显式传是唯一不会认错人的做法（D99⑧）。
 */
/** 候选条数上限与缺省值：契约与用例层共用同一份数字，避免「文档写 20、代码拦 10」。 */
export const SUGGEST_MAX_LIMIT = 20;
export const SUGGEST_DEFAULT_LIMIT = 5;

export const MasterdataSuggestQuerySchema = z.object({
  name: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(SUGGEST_MAX_LIMIT).optional(),
  companyId: z.string().uuid(),
});
export type MasterdataSuggestQuery = z.infer<typeof MasterdataSuggestQuerySchema>;

/**
 * 候选：**只有这四个字段**，刻意不带电话、地址、税号、开户行。
 *
 * suggest 会命中别的公司里的同名档案（提示「名称相同但公司不同」），一旦带上敏感字段，
 * 这个只读提示接口就成了跨公司客户信息探测器。加字段前先想清楚这一点。
 */
export const SuggestCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 相似度 0~1；1 = 名称完全一致（未剥后缀的规范化名称相同）。 */
  score: z.number(),
  /** 给人看的短句：`名称完全相同` / `名称高度相似` / `名称部分相似` / `名称相同但公司不同`。 */
  reason: z.string(),
});
export type SuggestCandidate = z.infer<typeof SuggestCandidateSchema>;

export const MasterdataSuggestResultSchema = z.object({
  candidates: z.array(SuggestCandidateSchema),
});
export type MasterdataSuggestResult = z.infer<typeof MasterdataSuggestResultSchema>;
