import { AppError, type DedupeKind, type DedupePair, type DedupeState, type MatchedBy } from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 去重审核台的读写（#302 块 C 后半段 / D102）。
 *
 * 表是块 A 建的（`20261117223000_masterdata_autocreate.sql`），`matched_by` 由
 * `20261118030000_masterdata_dedupe_matched_by.sql` 补；本文件只读写，不建表。
 *
 * 表名 / 列名一律是字面量，外部输入全部走参数（公司隔离用 `company_id = ANY($n)`）。
 */

export interface DedupeRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  readonly companyIds: readonly string[];
}

export interface DedupeListFilter {
  readonly companyId: string;
  /**
   * 调用者**有读权限**的档案类型（由用例算出）。SQL 里 `kind = ANY($kinds)`，
   * 无权限的类型连行都取不到——不是查到再过滤，避免审核台看到看不到的类型。
   */
  readonly kinds: readonly DedupeKind[];
  /** 调用者点名要某一类时必须命中 `kinds`，否则用例层就 403 了。 */
  readonly kind?: DedupeKind;
  readonly state: DedupeState;
  readonly limit: number;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

interface PairRow {
  readonly id: string;
  readonly kind: string;
  readonly score: string;
  readonly matched_by: string;
  readonly note: string | null;
  readonly state: string;
  readonly created_at: Date | string;
  readonly left_id: string;
  readonly left_name: string | null;
  readonly left_phone: string | null;
  readonly left_spec: string | null;
  readonly right_id: string;
  readonly right_name: string | null;
  readonly right_phone: string | null;
  readonly right_spec: string | null;
}

/**
 * 审核台主查询：一次查完，两侧档案用 CTE + LEFT JOIN 带进来（不做 N+1）。
 *
 * 为什么用 `UNION ALL` 拼一张「档案摘要视图」而不是按 kind 分四次查：四张表的
 * 名称列都叫 `name`，电话/规格列名不同，拼成同一形状后 LEFT JOIN 两次就能同时拿到两侧；
 * 按 kind 分支查会把「一个公司里四类档案混排」变成四段代码和四次往返。
 *
 * 索引 `masterdata_dedupe_console_idx (tenant_id, company_id, kind, state, score DESC, created_at DESC)`
 * 对应 `WHERE` 前三列 + `ORDER BY` 两列；`ORDER BY` 只写这两列、不再追加 `id`，
 * 就是为了让顺序完全由索引给出（不分页，所以并列行谁先谁后不影响正确性）。
 */
const LIST_SQL = `
WITH archive AS (
  SELECT 'customer'::text AS kind, c.id, c.name, c.contact_phone AS phone, NULL::text AS specification
    FROM customer c
  UNION ALL
  SELECT 'supplier'::text, s.id, s.name, s.contact_phone, NULL::text
    FROM supplier s
  UNION ALL
  SELECT 'processor'::text, p.id, p.name, NULL::text, NULL::text
    FROM processor p
  UNION ALL
  SELECT 'product'::text, pr.id, pr.name, NULL::text, pr.specification
    FROM product pr
)
SELECT d.id::text            AS id,
       d.kind,
       d.score::text         AS score,
       d.matched_by,
       d.note,
       d.state,
       d.created_at,
       d.left_id::text       AS left_id,
       l.name                AS left_name,
       l.phone               AS left_phone,
       l.specification       AS left_spec,
       d.right_id::text      AS right_id,
       r.name                AS right_name,
       r.phone               AS right_phone,
       r.specification       AS right_spec
  FROM masterdata_dedupe d
  LEFT JOIN archive l ON l.kind = d.kind AND l.id = d.left_id
  LEFT JOIN archive r ON r.kind = d.kind AND r.id = d.right_id
 WHERE d.tenant_id = $1
   AND d.company_id = $2
   AND d.state = $3
   AND d.kind = ANY($4::text[])
   AND ($5::text IS NULL OR d.kind = $5::text)
 ORDER BY d.score DESC, d.created_at DESC
 LIMIT $6`;

/** 队列列表。`companyId` 已由用例校验过可见性，这里只做归属过滤。 */
export async function listPairs(
  ctx: DedupeRepoContext,
  filter: DedupeListFilter,
): Promise<DedupePair[]> {
  const { rows } = await ctx.tx.query<PairRow>(LIST_SQL, [
    ctx.tenantId,
    filter.companyId,
    filter.state,
    [...filter.kinds],
    filter.kind ?? null,
    filter.limit,
  ]);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as DedupeKind,
    // score 是 numeric(4,3)，driver 给的是字符串；契约里是 number（0~1）。
    score: Number(row.score),
    matchedBy: row.matched_by as MatchedBy,
    note: row.note,
    state: row.state as DedupeState,
    createdAt: toDate(row.created_at).toISOString(),
    left: {
      id: row.left_id,
      name: row.left_name,
      contactPhone: row.left_phone,
      specification: row.left_spec,
    },
    right: {
      id: row.right_id,
      name: row.right_name,
      contactPhone: row.right_phone,
      specification: row.right_spec,
    },
  }));
}

export interface DecisionOutcome {
  readonly id: string;
  readonly state: DedupeState;
  readonly decidedAt: string | null;
  /** 回填审计事件的归属公司（事件在 work 之后才序列化）。 */
  readonly companyId: string;
}

interface DecisionRow {
  readonly id: string;
  readonly state: string;
  readonly decided_at: Date | string | null;
}

interface StateRow {
  readonly state: string;
  readonly kind: string;
  readonly company_id: string;
  readonly left_id: string;
  readonly right_id: string;
}

interface LockRow {
  readonly state: string;
  readonly company_id: string;
}

/**
 * 只读当前状态 + 类型 + 两侧档案 id，**不加锁**。
 *
 * 判定要按行实际的 `kind` 去校验对应域的 `merge`（供应商对子查 `supplier.merge`），
 * 所以必须先拿到 kind 再鉴权；而鉴权之前不能锁行——否则越权的人只要不停发 403 的请求，
 * 就能把别人正要判定的行一直锁在自己的事务里（`FOR UPDATE` 直到事务结束才释放）。
 *
 * 合并（`usecases/dedupe-merge.ts`）也用它取 `left_id` / `right_id`：两侧档案 id
 * 只能来自队列行本身，不能来自请求体（D103①）。
 */
export async function readPair(
  ctx: DedupeRepoContext,
  id: string,
): Promise<{
  readonly kind: DedupeKind;
  readonly state: DedupeState;
  readonly companyId: string;
  readonly leftId: string;
  readonly rightId: string;
} | null> {
  const { rows } = await ctx.tx.query<StateRow>(
    `SELECT state, kind, company_id, left_id::text AS left_id, right_id::text AS right_id
       FROM masterdata_dedupe
      WHERE id = $1 AND tenant_id = $2 AND company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = rows[0];
  return row
    ? {
        kind: row.kind as DedupeKind,
        state: row.state as DedupeState,
        companyId: row.company_id,
        leftId: row.left_id,
        rightId: row.right_id,
      }
    : null;
}

/**
 * 锁定并读当前状态：`FOR UPDATE` 让「同一行两个人同时点」变成串行，
 * 后一个看到的已不是 pending，会拿到明确的 409 而不是把判定覆盖掉。
 * 可见公司外的行等同不存在（`company_id = ANY`），返回 null 由用例翻成 404。
 *
 * 只在**鉴权通过之后**调用（见 `readPair` 的说明）。
 */
export async function lockPair(
  ctx: DedupeRepoContext,
  id: string,
): Promise<{ readonly state: DedupeState; readonly companyId: string } | null> {
  const { rows } = await ctx.tx.query<LockRow>(
    `SELECT state, company_id
       FROM masterdata_dedupe
      WHERE id = $1 AND tenant_id = $2 AND company_id = ANY($3::uuid[])
      FOR UPDATE`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = rows[0];
  return row ? { state: row.state as DedupeState, companyId: row.company_id } : null;
}

function outcomeOf(row: DecisionRow, companyId: string): DecisionOutcome {
  return {
    id: row.id,
    state: row.state as DedupeState,
    decidedAt: row.decided_at === null ? null : toDate(row.decided_at).toISOString(),
    companyId,
  };
}

/**
 * `pending → kept`：判为不同。
 *
 * `decided_by` 存 **employeeId**（`principal.employeeId`），不存账号 / 凭证 id：
 * 判定是「谁拍的板」的业务留痕，员工离职换号后仍然指向同一个人。
 * 已判定（kept / merged）再点 → 409，绝不静默重复判定（重复判定会覆盖 decided_by，
 * 把最先拍板的人抹掉）。
 */
export async function keepSeparate(
  ctx: DedupeRepoContext,
  id: string,
  employeeId: string,
): Promise<DecisionOutcome> {
  const locked = await lockPair(ctx, id);
  if (!locked) throw new AppError('NOT_FOUND', '疑似重复记录不存在');
  if (locked.state !== 'pending') {
    throw new AppError('STATE_CONFLICT', '该对子已经判定过，不能重复判定', {
      state: locked.state,
    });
  }
  const { rows } = await ctx.tx.query<DecisionRow>(
    `UPDATE masterdata_dedupe
        SET state = 'kept', decided_at = now(), decided_by = $3
      WHERE id = $1 AND tenant_id = $2 AND state = 'pending'
      RETURNING id::text AS id, state, decided_at`,
    [id, ctx.tenantId, employeeId],
  );
  const row = rows[0];
  // 拿到行锁之后 state 不可能再变；真的空了只能是并发删除，按不存在处理。
  if (!row) throw new AppError('NOT_FOUND', '疑似重复记录不存在');
  return outcomeOf(row, locked.companyId);
}

/**
 * `kept → pending`：撤销「判为不同」。
 *
 * 判错要有退路——否则一个手快点错的判定会让这两家客户永远不再提示。
 * - `merged` **不许** reopen：合并已经改写了单据/批次上的引用，撤销不是把 state 改回来
 *   就能完成的（要回滚引用），所以这里给 409 并说明，不让调用方以为撤销成功了；
 * - `pending` 调 reopen 也 409：本来就是待判，没有任何判定可撤。
 */
export async function reopen(
  ctx: DedupeRepoContext,
  id: string,
): Promise<DecisionOutcome> {
  const locked = await lockPair(ctx, id);
  if (!locked) throw new AppError('NOT_FOUND', '疑似重复记录不存在');
  if (locked.state === 'merged') {
    throw new AppError(
      'STATE_CONFLICT',
      '已合并的对子不能撤销判定：合并已改写引用，需走合并回滚',
      { state: locked.state },
    );
  }
  if (locked.state !== 'kept') {
    throw new AppError('STATE_CONFLICT', '该对子仍是待判状态，无需撤销', { state: locked.state });
  }
  const { rows } = await ctx.tx.query<DecisionRow>(
    `UPDATE masterdata_dedupe
        SET state = 'pending', decided_at = NULL, decided_by = NULL
      WHERE id = $1 AND tenant_id = $2 AND state = 'kept'
      RETURNING id::text AS id, state, decided_at`,
    [id, ctx.tenantId],
  );
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', '疑似重复记录不存在');
  return outcomeOf(row, locked.companyId);
}

// ---------------------------------------------------------------------------
// 合并（#302 块 D / D103）
// ---------------------------------------------------------------------------
//
// 本段的表名 / 列名全部来自下面两张**字面量映射表**，绝不接受外部字符串：
// 触发合并的 `kind` 来自队列行、方向来自请求体，两者都只能是枚举值，但把枚举直接拼进
// SQL 的写法一旦被人扩展成「按前端传的表名改引用」，就是一条全库任意 UPDATE 的通道。

/** 四张主数据表：`kind` 即表名，仍显式映射一次（理由见上）。 */
const ARCHIVE_TABLE: Readonly<Record<DedupeKind, string>> = {
  customer: 'customer',
  supplier: 'supplier',
  processor: 'processor',
  product: 'product',
};

interface ReferenceTarget {
  readonly table: string;
  readonly column: string;
}

/**
 * 合并要改写的全部引用（D103：清单来自 `REFERENCES (customer|supplier|processor|product)` 的实测）。
 *
 * 注意几处与设计文档不一致、以仓库现实为准的地方：
 *   - 商品退货明细表实际叫 `customer_return_line`（`0014_sales_receipts_returns.sql:59`）；
 *   - `processor_quote.processor_id`（`0007_masterdata_processor.sql:54`）也算加工厂的引用：
 *     历史报价不改挂，留存加工厂的比价就凭空少了几年数据；
 *   - `processing_order` 有两列引用商品（`processor_id` 的成品 `output_product_id`
 *     与材料无关，但成品商品同属 product），两列都在列表里。
 *
 * `settlement_order` 不在此列：它用 `source_doc_type` + `source_doc_id` 多态引用**单据**，
 * 表里没有客户/供应商/商品的 id 列，也没有名字快照列。
 */
export const DEDUPE_MERGE_REFERENCES: Readonly<Record<DedupeKind, readonly ReferenceTarget[]>> = {
  customer: [{ table: 'sales_order', column: 'customer_id' }],
  supplier: [{ table: 'purchase_order', column: 'supplier_id' }],
  processor: [
    { table: 'processing_order', column: 'processor_id' },
    { table: 'purchase_order_line', column: 'processor_id' },
    { table: 'inventory_batch', column: 'held_by_processor_id' },
    { table: 'processor_quote', column: 'processor_id' },
  ],
  product: [
    { table: 'inventory_batch', column: 'product_id' },
    { table: 'purchase_order_line', column: 'product_id' },
    { table: 'supplier_return_line', column: 'product_id' },
    { table: 'sales_order_line', column: 'product_id' },
    { table: 'customer_return_line', column: 'product_id' },
    { table: 'internal_trade_order_line', column: 'product_id' },
    { table: 'processing_order', column: 'output_product_id' },
  ],
};

export interface ArchiveRow {
  readonly id: string;
  readonly companyId: string;
  readonly mergedIntoId: string | null;
}

interface ArchiveDbRow {
  readonly id: string;
  readonly company_id: string;
  readonly merged_into_id: string | null;
}

/**
 * 锁定一条档案行（`SELECT … FOR UPDATE`），返回归属公司与 `merged_into_id`。
 *
 * **一次只锁一条**，由用例按 id 升序逐条调用，原因见 `usecases/dedupe-merge.ts`：
 * `SELECT … ORDER BY id FOR UPDATE` 不保证加锁顺序——行是在扫描阶段被锁住的，
 * 排序发生在加锁之后，两个方向相反的合并请求照样能各锁一半互等。
 */
export async function lockArchive(
  ctx: DedupeRepoContext,
  kind: DedupeKind,
  id: string,
): Promise<ArchiveRow | null> {
  const { rows } = await ctx.tx.query<ArchiveDbRow>(
    `SELECT id::text AS id, company_id, merged_into_id
       FROM ${ARCHIVE_TABLE[kind]}
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [id, ctx.tenantId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, companyId: row.company_id, mergedIntoId: row.merged_into_id }
    : null;
}

/**
 * 把 `kind` 这一类的全部引用从 `source` 改到 `target`，逐列返回改了行数。
 *
 * `WHERE tenant_id / company_id / <col>` 三列固定：前两列吃掉建表时的
 * `(tenant_id, company_id, <col>)` 复合索引，第三列是本次要改的值。
 * 计数用数据修改型 CTE（`WITH moved AS (UPDATE … RETURNING 1) SELECT count(*)`）：
 * `Database` 抽象只暴露 `rows`，没有 `rowCount`，这样一条语句既改又数。
 *
 * **`purchase_order_line.product_id` 这一列会被 D15 触发器拦一道**：
 * `0027_purchase_order_line_product_company.sql` 有
 * `BEFORE INSERT OR UPDATE OF order_id, tenant_id, company_id, product_id` 触发器，
 * 校验「商品所属公司 = 采购单所属公司」。合并要求双方同公司（用例里已校验），所以这里能过；
 * 将来若放开跨公司合并，这一列会先炸在触发器上——**且应该让它炸，不要绕过**：
 * 绕过等于把跨公司的商品引用塞进库里，比合并失败严重得多。
 */
export async function moveReferences(
  ctx: DedupeRepoContext,
  kind: DedupeKind,
  companyId: string,
  sourceId: string,
  targetId: string,
): Promise<{ table: string; column: string; rows: number }[]> {
  const moved: { table: string; column: string; rows: number }[] = [];
  for (const reference of DEDUPE_MERGE_REFERENCES[kind]) {
    const { rows } = await ctx.tx.query<{ rows: number }>(
      `WITH moved AS (
         UPDATE ${reference.table}
            SET ${reference.column} = $1
          WHERE tenant_id = $2 AND company_id = $3 AND ${reference.column} = $4
          RETURNING 1
       )
       SELECT count(*)::int AS rows FROM moved`,
      [targetId, ctx.tenantId, companyId, sourceId],
    );
    moved.push({ table: reference.table, column: reference.column, rows: rows[0]?.rows ?? 0 });
  }
  return moved;
}

/**
 * 被并档案落到留存档案上：`merged_into_id = target` + `dedupe_state = 'merged'`。
 *
 * 两列一起写：`merged_into_id` 是「并到哪去了」的答案，`dedupe_state` 是「这条档案
 * 已经不在候选池里」的速查位，缺一个都会让后续的候选查询要么漏掉、要么把它再推一次。
 */
export async function markArchiveMerged(
  ctx: DedupeRepoContext,
  kind: DedupeKind,
  companyId: string,
  sourceId: string,
  targetId: string,
): Promise<void> {
  await ctx.tx.query(
    `UPDATE ${ARCHIVE_TABLE[kind]}
        SET merged_into_id = $1, dedupe_state = 'merged'
      WHERE id = $2 AND tenant_id = $3 AND company_id = $4`,
    [targetId, sourceId, ctx.tenantId, companyId],
  );
}

/**
 * 本次判定的对子落到 `merged`。`WHERE … state = 'pending'` 是并发兜底：
 * 用例已先 `lockPair` 看过状态，这里再拦一次，宁可失败也不写出一条
 * 「引用改了、对子却不是本次合并标的」的记录。
 */
export async function markPairMerged(
  ctx: DedupeRepoContext,
  id: string,
  employeeId: string,
): Promise<void> {
  const { rows } = await ctx.tx.query<{ id: string }>(
    `UPDATE masterdata_dedupe
        SET state = 'merged', decided_at = now(), decided_by = $3
      WHERE id = $1 AND tenant_id = $2 AND state = 'pending'
      RETURNING id::text AS id`,
    [id, ctx.tenantId, employeeId],
  );
  if (rows.length === 0) {
    throw new AppError('STATE_CONFLICT', '该对子状态已变化，合并未执行', { id });
  }
}

/**
 * 连锁收口：`source` 参与的其他待判对子一并置 `merged`（D103④）。
 *
 * 不这么做的话，A 并进 B 之后「A vs C」还挂在审核台上：运营点进去，A 已经不在候选池里
 * （`merged_into_id` 非空），判也没法判、合也合不了，只能一条条 keep-separate 清掉，
 * 而 keep-separate 会写下一个「这两条确实不同」的假结论。
 *
 * `decided_by` 留 NULL 而不是记本次操作人：这些对子**没有人做过判断**，它们是因为
 * 一侧档案消失而自动失效的；把操作人写进去等于伪造一条判定记录。
 *
 * **`left_id = $3 OR right_id = $3` 这半条为什么要单独补索引**：`OR` 跨两列，任何一条
 * 复合索引都不可能让两段都进 `Index Cond`。`masterdata_dedupe_console_idx`
 * （`tenant_id, company_id, kind, state, …`）只吃得到前面的等值确认范围，`left_id` /
 * `right_id` 只能当 `Filter`；`right_id` 由 20261117223000 的
 * `masterdata_dedupe_right_idx` 扛，`left_id` 在 20261118040000 之前**完全没有索引**
 * ——缺了 `masterdata_dedupe_left_idx`，这条 UPDATE 就会退化成整表扫（审核台每合一次都扫）。
 * 两个索引各为一半服务，删任何一个都会让规划器放弃 `BitmapOr`。
 */
export async function markChainedPairsMerged(
  ctx: DedupeRepoContext,
  pairId: string,
  sourceId: string,
): Promise<number> {
  const { rows } = await ctx.tx.query<{ id: string }>(
    `UPDATE masterdata_dedupe
        SET state = 'merged', decided_at = now(), decided_by = NULL
      WHERE tenant_id = $1 AND state = 'pending' AND id <> $2
        AND (left_id = $3 OR right_id = $3)
      RETURNING id::text AS id`,
    [ctx.tenantId, pairId, sourceId],
  );
  return rows.length;
}
