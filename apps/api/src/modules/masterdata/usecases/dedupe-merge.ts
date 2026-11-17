import {
  AppError,
  DedupeMergeInputSchema,
  type DedupeMergeInput,
  type DedupeMergeResult,
} from '@qingdan/contracts';
import { withAudit } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import type { SqlClient } from '../../../platform/db/client.js';
import * as repo from '../repo-dedupe.js';
import {
  assertHumanCredential,
  auditEventOf,
  parsePairId,
  repoContext,
  requireDatabase,
  requireKindMerge,
  requirePrincipal,
  type DedupeWriteContext,
} from './dedupe.js';

/**
 * 主数据合并（#302 块 D / D103）：把一条档案并进另一条，全库引用改向。
 *
 * 一次调用要做完十件事，**全在一个事务里**（`withAudit` 的 work 就是那个事务）：
 *   1. 无锁读队列行（拿 kind / left_id / right_id / state）；
 *   2. 按该行真实 kind 鉴权 `*.merge`（越权的行连锁都碰不到）；
 *   3. 状态必须是 `pending`；
 *   4. 锁对子行 → 按 id 升序逐条锁两条档案；
 *   5. 校验两侧档案：未被并过、同租户、同公司、kind 一致；
 *   6. 按 `direction` 定 source / target；
 *   7. 逐列改写该 kind 的全部引用并统计行数；
 *   8. 被并档案 `merged_into_id = target`、`dedupe_state = 'merged'`；
 *   9. 本对子 `merged`；
 *  10. 连锁把 source 参与的其他 `pending` 对子一并 `merged`。
 *
 * 任何一步失败 → 整个事务回滚，**绝不允许「引用改了一半」**：合并到一半的库比没合并更难救，
 * 单据指向一条已被标成 merged 的档案，对账时两边都对不上。
 */

function parseMergeInput(body: unknown): DedupeMergeInput {
  const parsed = DedupeMergeInputSchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
    throw new AppError('VALIDATION_FAILED', '合并入参不合法（只接受 direction）', {
      field,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * 对子状态必须是 `pending`。
 *
 * `kept` 要先 reopen：判为不同是**人**给的结论，合并是反方向的结论，
 * 让「合并」顺手把 `kept` 覆盖掉，等于同一个动作把前一个人的判断悄悄反悔了（D103⑤）。
 * `merged` 直接拒：合并不可撤销，再合一次只会把引用改到错误的档案上。
 *
 * 用 `VALIDATION_FAILED`（422）而不是既有判定端点的 `STATE_CONFLICT`（409）：
 * 语义上这是「这对子现在不能合并」的请求不合法，用户要做的是先 reopen 再看一遍，
 * 不是重试。与 `keep-separate` 的 409 口径不同，是有意为之（见 D103⑤）。
 */
function assertPending(state: string): void {
  if (state === 'kept') {
    throw new AppError('VALIDATION_FAILED', '这对已判为不同，先 reopen 才能合并', { state });
  }
  if (state === 'merged') {
    throw new AppError('VALIDATION_FAILED', '这对已经合并过，不能重复合并', { state });
  }
  if (state !== 'pending') {
    throw new AppError('VALIDATION_FAILED', '对子状态不允许合并', { state });
  }
}

export async function mergeDedupe(ctx: DedupeWriteContext): Promise<DedupeMergeResult> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'customer.dedupe.merge');
  // 合并不可撤销（D103③）：AI 一律不许。契约里 `ai.policy: 'forbid'` 只是声明，
  // 真正拦住 AI 凭证的是这一行。
  assertHumanCredential(principal);

  const id = parsePairId(ctx.request);
  const input = parseMergeInput(ctx.request.body);

  const audit = auditEventOf(
    ctx.request,
    principal,
    'customer.dedupe.merge',
    id,
    { to: 'merged', direction: input.direction },
    // 合并的理由来自 X-Reason（`request.auditReason`）：合并入参只允许方向，
    // 业务理由不该塞进请求体让前端把它当成可选的表单字段。
    ctx.request.auditReason ?? '合并疑似重复的主数据',
  );

  return await withAudit(database, audit, async (tx) => {
    const repoCtx = repoContext(tx, principal);

    // 1. 无锁读：先拿 kind 才能按对子真实的档案类型鉴权。
    const pair = await repo.readPair(repoCtx, id);
    if (!pair) throw new AppError('NOT_FOUND', '疑似重复记录不存在');

    // 2. 鉴权（403）：供应商对子查 supplier.merge，与 keep-separate / reopen 同口径。
    requireKindMerge(principal, pair.kind);

    // 3. 锁对子行之后再看状态：两个人同时点合并，后者看到的已经不是 pending。
    const locked = await repo.lockPair(repoCtx, id);
    if (!locked) throw new AppError('NOT_FOUND', '疑似重复记录不存在');
    assertPending(locked.state);

    // 4. 两条档案按 id 字典序**逐条**加锁（不是一条 `ORDER BY id FOR UPDATE`）。
    //
    //    为什么必须升序：合并 A→B 与合并 B→A 是两个方向相反的并发请求，若各自按
    //    「我第一次读到的那条」先锁，A 事务持有 A 等 B、B 事务持有 B 等 A，必然死锁
    //    （PostgreSQL 会杀掉其中一个，用户看到 500）。固定升序后，两个事务都先锁 id 小的，
    //    后到的那个在第一步就排队，等前一个提交后读到 `merged_into_id` 非空而拿到 422。
    //
    //    为什么不写成一条 `SELECT … WHERE id = ANY($ids) ORDER BY id FOR UPDATE`：
    //    行是在扫描阶段被锁住的，`ORDER BY` 发生在加锁之后，锁顺序不受 ORDER BY 约束，
    //    看着有序、实际仍可能反序加锁。只有两次独立语句才能确定顺序。
    const ordered = [pair.leftId, pair.rightId].sort();
    const first = await repo.lockArchive(repoCtx, pair.kind, ordered[0]!);
    const second = await repo.lockArchive(repoCtx, pair.kind, ordered[1]!);
    if (!first || !second) {
      throw new AppError('NOT_FOUND', '对子两侧的档案不存在或已被删除', {
        leftId: pair.leftId,
        rightId: pair.rightId,
      });
    }

    // 5. 两侧档案必须同公司、都还没被并过。
    if (first.companyId !== second.companyId || first.companyId !== pair.companyId) {
      throw new AppError('VALIDATION_FAILED', '两侧档案不属于同一公司，不能合并', {
        leftCompanyId: first.companyId,
        rightCompanyId: second.companyId,
        pairCompanyId: pair.companyId,
      });
    }
    const alreadyMerged = [first, second].find((archive) => archive.mergedIntoId !== null);
    if (alreadyMerged) {
      // 链式合并（A→B 之后再 A→C）会让「并到哪去了」出现两条出路，审计就答不出终点。
      // 要改挂得先在数据层解掉旧边，不能靠合并端点覆盖。
      throw new AppError('VALIDATION_FAILED', '其中一条档案已经被合并过，不能再次合并', {
        archiveId: alreadyMerged.id,
        mergedIntoId: alreadyMerged.mergedIntoId,
      });
    }

    // 6. 方向只在这两条之间选（D103①）：source 被并掉，target 留存。
    const [source, target] =
      input.direction === 'left_into_right' ? [first, second] : [second, first];

    // 7. 改写引用（逐列统计行数，`rows = 0` 也照实返回）。
    const movedReferences = await repo.moveReferences(
      repoCtx,
      pair.kind,
      pair.companyId,
      source.id,
      target.id,
    );

    // 8. 被并档案落到留存档案上。
    await repo.markArchiveMerged(repoCtx, pair.kind, pair.companyId, source.id, target.id);

    // 9. 本对子置 merged。
    await repo.markPairMerged(repoCtx, id, principal.employeeId);

    // 10. 连锁：source 参与的其他待判对子一并收口（D103④）。
    const chainedPairs = await repo.markChainedPairsMerged(repoCtx, id, source.id);

    // 审计的归属公司与变更摘要只能在这里补：事件对象在 work 之后才序列化。
    audit.companyId = pair.companyId;
    audit.changeSummary = {
      to: 'merged',
      kind: pair.kind,
      direction: input.direction,
      keptId: target.id,
      mergedId: source.id,
      movedReferences,
      chainedPairs,
    };

    return { keptId: target.id, mergedId: source.id, movedReferences };
  });
}
