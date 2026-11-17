import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 主数据去重审核台契约（#302 块 C 后半段 / D102）。
 *
 * 场景：块 C 前半段（D100）在开单时静默建档，疑似重复的档案对进 `masterdata_dedupe` 队列；
 * 运营在这个审核台看到「张记建材 vs 张记建材店」，判它俩是不是同一家——
 * 判为不同（keep-separate）之后这对不再提示；判错了可以撤销（reopen）。
 *
 * **合并**（`pending → merged`）由块 D 补上（`customer.dedupe.merge`，D103）：它不改判定的
 * 语义，只是把「要并」这个结论真正执行掉——改写全库引用 + 被并档案记 `merged_into_id`。
 */

/** 对子两侧的档案类型；与 `masterdata_dedupe.kind` 的 CHECK 一致（以迁移为准）。 */
export const DEDUPE_KINDS = ['customer', 'supplier', 'processor', 'product'] as const;
export const DedupeKindSchema = z.enum(DEDUPE_KINDS);
export type DedupeKind = z.infer<typeof DedupeKindSchema>;

/** 命中依据；与 `masterdata_dedupe.matched_by` 的 CHECK 一致（20261118030000 补的列）。 */
export const MATCHED_BY_VALUES = ['name_only', 'name_phone', 'alias'] as const;
export const MatchedBySchema = z.enum(MATCHED_BY_VALUES);
export type MatchedBy = z.infer<typeof MatchedBySchema>;

/**
 * 判定状态：`pending` 待判 / `kept` 判为不同 / `merged` 已合并。
 * 合法流转只有三条（D102）：`pending→kept`（keep-separate）、`kept→pending`（reopen）、
 * `pending→merged`（合并单）。`merged` 不能回退——合并已经改写了引用，不是改个状态能撤销的。
 */
export const DEDUPE_STATES = ['pending', 'merged', 'kept'] as const;
export const DedupeStateSchema = z.enum(DEDUPE_STATES);
export type DedupeState = z.infer<typeof DedupeStateSchema>;

/**
 * 审核台一次取多少条。
 *
 * 不分页是刻意的（D102）：审核台是「今天有哪些可疑对子要处理」的工作台，不是档案检索页，
 * 一个公司一天攒不出 200 条新候选；真到了 200 条，正确的动作是先处理掉，而不是翻第 2 页。
 * 分页会同时引入 cursor / 序号稳定性 / 排序字段三件麻烦事，而这三件事在「按分数倒序、
 * 处理一条少一条」的队列上没有收益。写死上限也就无需向前端承诺「一定能拿全」。
 */
export const DEDUPE_CONSOLE_LIMIT = 200;

/** 判定理由的长度上限：够写「两家其实是夫妻店，电话一样但不是一个客户」。 */
export const DEDUPE_REASON_MAX = 200;

/**
 * 列表入参。
 *
 * - `companyId` **必传**：principal 只有「可见公司集合」，集合顺序由授权查询决定，
 *   服务端拿 `companyIds[0]` 兜底会把 A 公司的待办显示成 B 公司的（同 D99⑧）；
 * - `kind` 可选：前端「全部类型」时不传，服务端按 `LIMIT` 混合排队；
 * - `state` 用 `.optional()` + 用例层补 `pending`，不用 zod 的 `.default()`——
 *   带 default 的字段在生成的 OpenAPI 里会被标成 `required: true`，而缺省是合法的（D95）。
 */
export const DedupeListQuerySchema = z.object({
  companyId: z.string().uuid(),
  kind: DedupeKindSchema.optional(),
  state: DedupeStateSchema.optional(),
});
export type DedupeListQuery = z.infer<typeof DedupeListQuerySchema>;

/**
 * 对子一侧的档案摘要。
 *
 * `name` 可空只有一个原因：档案被物理删除（D93 起主数据是物理删除，`left_id`/`right_id`
 * 没有外键，删档案不会连带删队列行）。这时审核台要能显示「档案已删除」而不是崩掉。
 * `contactPhone` 只有客户 / 供应商有（加工厂表没有电话列，商品没有电话）；
 * `specification` 只有商品有。取不到的给 `null`，别用空字符串冒充「没填」。
 */
export const DedupeArchiveSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  contactPhone: z.string().nullable(),
  specification: z.string().nullable(),
});
export type DedupeArchive = z.infer<typeof DedupeArchiveSchema>;

/** 队列里的一条。两侧摘要都要带名字，只给 id 的话审核台没法展示「A vs B」。 */
export const DedupePairSchema = z.object({
  id: z.string(),
  kind: DedupeKindSchema,
  score: z.number(),
  matchedBy: MatchedBySchema,
  /** 人工备注，目前只有商品的「同名不同规格」（命中依据已独立成 `matchedBy`）。 */
  note: z.string().nullable(),
  state: DedupeStateSchema,
  createdAt: z.string(),
  left: DedupeArchiveSchema,
  right: DedupeArchiveSchema,
});
export type DedupePair = z.infer<typeof DedupePairSchema>;

export const DedupeListResultSchema = z.object({
  items: z.array(DedupePairSchema),
});
export type DedupeListResult = z.infer<typeof DedupeListResultSchema>;

/**
 * 判定入参。`reason` 必传 1–200 字：判为不同等于「这两个以后不再提示」，
 * 判错就永久漏掉重复客户，留一句为什么是唯一的追责依据。
 */
export const DedupeDecisionInputSchema = z.object({
  reason: z.string().trim().min(1).max(DEDUPE_REASON_MAX),
});
export type DedupeDecisionInput = z.infer<typeof DedupeDecisionInputSchema>;

/** 判定结果：`decidedAt` 在 keep-separate 后有值，reopen 之后被清空为 `null`。 */
export const DedupeDecisionResultSchema = z.object({
  id: z.string(),
  state: DedupeStateSchema,
  decidedAt: z.string().nullable(),
});
export type DedupeDecisionResult = z.infer<typeof DedupeDecisionResultSchema>;

/**
 * 合并方向：只在这两条档案之间选，**不接受任意 id**（D103①）。
 *
 * 让前端传 `sourceId` / `targetId` 看着更灵活，实际是把「合并方向」这个业务决定
 * 交给了一个可能缓存的页面：审核台打开一分钟后再提交，传回来的 id 可能已被另一次
 * 合并改过；而方向只能在这两条之间，多传一个 id 出来就一定是错的。
 * 传别的 id 一律 422（`request.body` 是 `.strict()`，多余字段直接拒绝）。
 */
export const DEDUPE_MERGE_DIRECTIONS = ['left_into_right', 'right_into_left'] as const;
export const DedupeMergeDirectionSchema = z.enum(DEDUPE_MERGE_DIRECTIONS);
export type DedupeMergeDirection = z.infer<typeof DedupeMergeDirectionSchema>;

/**
 * 合并入参。**只要方向**，不要 id、不要名字：id 来自路径（那是服务端读出来的队列行），
 * 名字来自档案本身——受理一次「改名字的合并」等于让合并顺手改了主数据内容。
 *
 * `.strict()`：多传字段（典型是 `sourceId`）直接 422，不静默忽略。
 */
export const DedupeMergeInputSchema = z
  .object({ direction: DedupeMergeDirectionSchema })
  .strict();
export type DedupeMergeInput = z.infer<typeof DedupeMergeInputSchema>;

/**
 * 一条被改写的引用：`table` + `column` + 改了多少行。
 *
 * 前端要能说清「并了哪些东西」，光回一个 `ok` 等于让用户自己回去翻单据找。
 * `rows = 0` 也照实返回（这个库里这张表一条都没引用过 source），
 * 不省略——少一行会让人以为漏改了这张表。
 */
export const DedupeMovedReferenceSchema = z.object({
  table: z.string(),
  column: z.string(),
  rows: z.number().int().nonnegative(),
});
export type DedupeMovedReference = z.infer<typeof DedupeMovedReferenceSchema>;

/**
 * 合并结果：`keptId` 是留存（引用终点）、`mergedId` 是被并掉的那条。
 *
 * 两个 id 都必回：调用方要拿 `mergedId` 去提示「张记建材（老）已并入张记建材」，
 * 只有 `keptId` 的话前端不知道该把哪一条从列表里划掉。
 */
export const DedupeMergeResultSchema = z.object({
  keptId: z.string(),
  mergedId: z.string(),
  movedReferences: z.array(DedupeMovedReferenceSchema),
});
export type DedupeMergeResult = z.infer<typeof DedupeMergeResultSchema>;

/**
 * 四条路由。
 *
 * **为什么 `domain` 是 `customer` 而不是 `masterdata`**（见 D102）：
 * `packages/contracts/src/domains.ts` 里没有 `masterdata` 这个功能域——`masterdata` 只是
 * 模块键（`modules.ts`）。而注册表要求 operationId 以功能域名开头，想要
 * `masterdata.dedupe.*` 就必须新增第 26 个域，那会同时打破
 * `packages/contracts/src/todos.test.ts` 与 `apps/api/src/platform/authz/service.test.ts`
 * 里「域恰好 25 个」的守卫，且要为它配一套五动作权限。
 *
 * **但 operationId 里的 `customer` 只表示路由归属，不表示鉴权口径**：审核台横跨
 * customer / supplier / processor / product 四类档案，鉴权一律按对子真实的 `kind` 走——
 * `list` 只返回调用者持有 `*.read` 的那几类（一类都没有就 403，不是空列表），
 * `keep_separate` / `reopen` 校验该行 `kind` 对应域的 `merge`。把四类都挂在
 * `customer.*` 上会让只有客户权限的销售看到供应商的名字与电话，属于越权。
 * 详见 `apps/api/src/modules/masterdata/usecases/dedupe.ts` 的 `readableKinds` /
 * `requireKindMerge`。
 */
const MODULE = 'masterdata' as const;

export const MASTERDATA_DEDUPE_ROUTES: readonly RouteDef[] = [
  defineRoute({
    operationId: 'customer.dedupe.list',
    method: 'GET',
    path: '/api/v1/masterdata/dedupe',
    module: MODULE,
    domain: 'customer',
    action: 'read',
    summary: '疑似重复档案审核队列（待判 / 判为不同 / 已合并）',
    // 只读、无副作用，不记审计（D54②）；返回体带电话，但只出调用者持有 `*.read` 的类型，
    // 按读权限收口即可，不当敏感读处理——与各类档案列表同口径，否则「看得见客户列表、
    // 看不见重复提示」反而更怪。
    audit: { kind: 'none' },
    ai: { policy: 'allow' },
    request: { query: DedupeListQuerySchema },
    response: { status: 200, schema: DedupeListResultSchema },
  }),
  defineRoute({
    operationId: 'customer.dedupe.keep_separate',
    method: 'POST',
    path: '/api/v1/masterdata/dedupe/{id}/keep-separate',
    module: MODULE,
    domain: 'customer',
    action: 'merge',
    summary: '把疑似重复的一对判为不同（此后不再提示）',
    audit: { kind: 'write' },
    // 判为不同 = 这两条以后不再提示，判错就永久漏掉重复客户，必须人类来做。
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: DedupeDecisionInputSchema },
    response: { status: 200, schema: DedupeDecisionResultSchema },
  }),
  defineRoute({
    operationId: 'customer.dedupe.reopen',
    method: 'POST',
    path: '/api/v1/masterdata/dedupe/{id}/reopen',
    module: MODULE,
    domain: 'customer',
    action: 'merge',
    summary: '撤销「判为不同」，把对子放回待判',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: DedupeDecisionInputSchema },
    response: { status: 200, schema: DedupeDecisionResultSchema },
  }),
  defineRoute({
    operationId: 'customer.dedupe.merge',
    method: 'POST',
    path: '/api/v1/masterdata/dedupe/{id}/merge',
    module: MODULE,
    domain: 'customer',
    action: 'merge',
    summary: '把疑似重复的两条档案合并为一条（source 并进 target，全库引用改向）',
    // 合并改写全库引用（单据明细、库存批次、报价），必须留痕；审计的 objectType 是
    // 队列行本身（`masterdata_dedupe`），changeSummary 里带 keptId / mergedId / 改了几行。
    audit: { kind: 'write' },
    // 合并**不可撤销**（D103③）：AI 一错就是全库引用错，且回滚要逐条复原引用，一律不许。
    ai: { policy: 'forbid', reasonRequired: true },
    request: { body: DedupeMergeInputSchema },
    response: { status: 200, schema: DedupeMergeResultSchema },
  }),
];
