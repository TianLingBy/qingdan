import { AppError } from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { Principal } from '../../../platform/auth/principal.js';
import type { SqlClient } from '../../../platform/db/client.js';
import { recordDedupeCandidate } from '../dedupe/queue.js';
import { judgeCandidate, type DedupeKind, type JudgeResult } from '../dedupe/thresholds.js';

/**
 * 「开单即建档」的静默建档（#302 块 C 前半段 / D100，设计 §〇 / §六）。
 *
 * 四条口径（D100 记录同一份，改这里必须同步改决策）：
 *   ① **不提示员工**：返回值只有 `{ id }`，响应体里不出现「已建档」「新建」这类字段；
 *      员工以为自己只是报了个名字，实际系统在背后建了档。
 *   ② **不受主数据 create 限制**：调用方（开单用例）已经校验过自己的 `*.create`
 *      （`sales.create` / `purchase.create` / `processing.create`），
 *      这里**不**再要求 `customer.create`；否则「能开单不能建客户」的岗位开不了单。
 *   ③ **不阻塞存单**：疑似重复判定是「事后审计」，任何异常都吞掉（见 `queueCandidates`）。
 *   ④ **`company_id` 取单据自身的公司**：`companyId` 由调用方从单据上取，
 *      前端传什么一律不信——否则前端可以把档案建到别的公司去，绕过 D15 公司隔离。
 */

/** 每类档案的候选上限（设计 §四：上限 500，避免全表扫 + 内存失控）。 */
export const CANDIDATE_LIMIT = 500;

/**
 * 建档入参里的草档字段。
 *
 * 为什么是一个宽松联合而不是四个具名类型：E/A/B 三张单各带一种草档，
 * 但 `resolveMasterdataDraft` 只有一份 INSERT 逻辑，按 `kind` 取需要的那几个字段即可。
 * 契约层仍然是四个严格 schema（`CustomerDraftSchema` 等），类型收口在那里做。
 */
export interface MasterdataDraft {
  readonly name: string;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly creditTermDays?: number | null;
  readonly suppliedMaterials?: readonly string[];
  /** 商品规格（`kind='product'` 时用；商品按规格去重，见设计 §四）。 */
  readonly spec?: string | null;
  /** 商品单位（`product.unit` 是 NOT NULL，商品建档时必填）。 */
  readonly unit?: string | null;
}

export interface ResolveMasterdataInput {
  readonly kind: DedupeKind;
  /**
   * **单据自身的公司**（由调用方从已校验的单据上取，不是请求体里的独立字段）。
   * 这里只校验它落在调用者可见公司集合内，不校验别的。
   */
  readonly companyId: string;
  readonly draft: MasterdataDraft;
}

/** 档案表名。键是闭集合，拼进 SQL 的是本文件里的字面量，不接受外部输入。 */
const TABLE_BY_KIND: Record<DedupeKind, string> = {
  customer: 'customer',
  supplier: 'supplier',
  processor: 'processor',
  product: 'product',
};

/**
 * 静默建档并登记疑似重复，返回新建档案的 id。
 *
 * 必须在**开单用例的同一个事务**里调用：单据引用这个 id，档案与单据要么一起成功、
 * 要么一起回滚。客户端拿到 201 时档案已经存在，不需要再补一次请求。
 */
export async function resolveMasterdataDraft(
  tx: SqlClient,
  principal: Principal,
  input: ResolveMasterdataInput,
): Promise<{ id: string }> {
  // 权限只校验「这个公司归不归你」，`*.create` 由开单用例负责（口径 ②）。
  if (!principal.companyIds.includes(input.companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该单据所属公司无权限', {
      companyId: input.companyId,
    });
  }

  const name = input.draft.name.trim();
  if (name === '') {
    throw new AppError('VALIDATION_FAILED', '档案名称不能为空', { field: 'name' });
  }

  const id = uuidv7();
  await insertDraft(tx, principal.tenantId, input.companyId, input.kind, id, {
    ...input.draft,
    name,
  });

  // 建档是主流程，判定是旁路：先后顺序不能反——候选里必须包含「刚建的这条自己」以外的行，
  // 用 `id <> $3` 排除自己，而不是等事务提交后再查（那时单据早就回给前端了）。
  await queueCandidates(tx, {
    tenantId: principal.tenantId,
    companyId: input.companyId,
    kind: input.kind,
    newId: id,
    draft: { ...input.draft, name },
  });

  // 只回 id：多回一个字段就等于把「系统替你建了档」泄漏给前端（口径 ①）。
  return { id };
}

async function insertDraft(
  tx: SqlClient,
  tenantId: string,
  companyId: string,
  kind: DedupeKind,
  id: string,
  draft: MasterdataDraft,
): Promise<void> {
  // `origin='order'` / `dedupe_state='pending'`：取值来自块 A 迁移的 CHECK 约束
  // （设计文档写的是「疑似重复」，迁移落的是 `pending`，**以迁移为准**）。
  // `dedupe_state='pending'` 的含义是「参与过相似度比对、还没人工判定」，本函数正好做了比对。
  switch (kind) {
    case 'customer':
      await tx.query(
        `INSERT INTO customer
           (id, tenant_id, company_id, name, contact_name, contact_phone, credit_term_days, origin, dedupe_state)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'order', 'pending')`,
        [
          id,
          tenantId,
          companyId,
          draft.name,
          draft.contactName ?? null,
          draft.contactPhone ?? null,
          draft.creditTermDays ?? null,
        ],
      );
      return;
    case 'supplier':
      await tx.query(
        `INSERT INTO supplier
           (id, tenant_id, company_id, name, contact_name, contact_phone, supplied_materials, origin, dedupe_state)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::text[], 'order', 'pending')`,
        [
          id,
          tenantId,
          companyId,
          draft.name,
          draft.contactName ?? null,
          draft.contactPhone ?? null,
          draft.suppliedMaterials ?? [],
        ],
      );
      return;
    case 'processor':
      // 加工厂表没有电话列（0007 建表语句），契约同样不收电话。
      await tx.query(
        `INSERT INTO processor
           (id, tenant_id, company_id, name, contact_name, origin, dedupe_state)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'order', 'pending')`,
        [id, tenantId, companyId, draft.name, draft.contactName ?? null],
      );
      return;
    case 'product': {
      const unit = (draft.unit ?? '').trim();
      if (unit === '') {
        // `product.unit` 是 NOT NULL：开单现场必须从商品行带出单位，缺了就报字段错误。
        throw new AppError('VALIDATION_FAILED', '商品建档必须给单位', { field: 'unit' });
      }
      await tx.query(
        `INSERT INTO product
           (id, tenant_id, company_id, name, specification, unit, origin, dedupe_state)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'order', 'pending')`,
        [id, tenantId, companyId, draft.name, draft.spec ?? null, unit],
      );
      return;
    }
  }
}

interface CandidateRow {
  readonly id: string;
  readonly name: string;
  readonly contact_phone: string | null;
  readonly specification: string | null;
}

interface QueueContext {
  readonly tenantId: string;
  readonly companyId: string;
  readonly kind: DedupeKind;
  readonly newId: string;
  readonly draft: MasterdataDraft;
}

/**
 * 取同公司、同类型的既有档案（一次 SQL、上限 500、不 N+1），逐条判定并登记。
 *
 * **为什么整段 try/catch 里还要 SAVEPOINT**：PostgreSQL 里一条语句失败会把整个事务置为
 * aborted，之后连单据的 INSERT 都会失败——那样「吞掉异常」就变成了「吞掉异常但存单照样挂」。
 * 包一层 SAVEPOINT 才能在判定出错时回滚到判定之前、让单据继续写（口径 ③）。
 *
 * **为什么不按 `status` 过滤**：D93（`20261117013000_drop_masterdata_status.sql`）已经把
 * 四张主数据表的 `status` 列删掉，「停用」概念取消、删除改为物理删除。任务书里的
 * `status <> '停用'` 在今天的库里是无效列，写上会让开单直接报错；候选集自然只剩存在的行。
 */
async function queueCandidates(tx: SqlClient, ctx: QueueContext): Promise<void> {
  await tx.query('SAVEPOINT masterdata_dedupe_candidates');
  try {
    const table = TABLE_BY_KIND[ctx.kind];
    const specificationColumn = ctx.kind === 'product' ? 'specification' : 'NULL::text';
    const phoneColumn =
      ctx.kind === 'customer' || ctx.kind === 'supplier' ? 'contact_phone' : 'NULL::text';
    const { rows } = await tx.query<CandidateRow>(
      `SELECT id, name, ${phoneColumn} AS contact_phone, ${specificationColumn} AS specification
         FROM ${table}
        WHERE tenant_id = $1::uuid
          AND company_id = $2::uuid
          AND id <> $3::uuid
        ORDER BY name
        LIMIT ${CANDIDATE_LIMIT}`,
      [ctx.tenantId, ctx.companyId, ctx.newId],
    );

    for (const row of rows) {
      const verdict = judgeFor(ctx, row);
      if (verdict === null) continue;
      await recordDedupeCandidate(tx, {
        tenantId: ctx.tenantId,
        companyId: ctx.companyId,
        kind: ctx.kind,
        leftId: row.id,
        rightId: ctx.newId,
        score: verdict.score,
        matchedBy: verdict.matchedBy,
        note: verdict.note,
      });
    }
    await tx.query('RELEASE SAVEPOINT masterdata_dedupe_candidates');
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT masterdata_dedupe_candidates');
    // 只记 warning、不抛：疑似重复是事后审计，绝不能因为它把存单拦下来（口径 ③）。
    console.warn('[masterdata] 疑似重复判定失败，已忽略（不影响存单）', error);
  }
}

function judgeFor(ctx: QueueContext, candidate: CandidateRow): JudgeResult | null {
  return judgeCandidate({
    kind: ctx.kind,
    incomingName: ctx.draft.name,
    incomingSpec: ctx.draft.spec ?? null,
    incomingPhone: ctx.draft.contactPhone ?? null,
    candidateName: candidate.name,
    candidateSpec: candidate.specification,
    candidatePhone: candidate.contact_phone,
  });
}

/* ------------------------------------------------------------------------- *
 * 单据层校验：id 与草档二选一 / N 单不许建公司
 * ------------------------------------------------------------------------- */

/**
 * `customerId` 与 `customerDraft` 二选一（D100）。
 *
 * 放在用例层而不是 zod 的 `.refine`：zod 失败只能给出 `details.issues[]`，
 * 前端拿不到「该画红框的是哪个字段」；这里直接把 `details.field` 指回 id 字段，
 * 三个开单弹窗共用同一套错误处理。
 */
export function assertIdOrDraft(
  idField: string,
  id: string | undefined,
  draft: unknown,
  label: string,
): void {
  const hasId = typeof id === 'string' && id !== '';
  const hasDraft = draft !== undefined && draft !== null;
  if (hasId && hasDraft) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${label}只能二选一：选已有档案，或填写新档案名称`,
      { field: idField },
    );
  }
  if (!hasId && !hasDraft) {
    throw new AppError('VALIDATION_FAILED', `请选择${label}或填写新${label}名称`, {
      field: idField,
    });
  }
}

/**
 * N 单（内部交易）收到 `companyDraft` → 422。
 *
 * 公司档案属于主体信息，只在公司管理里由有权限的人建；N 单的收发双方必须是**已有**公司
 * （设计 §六「N 单只能选不能建」）。这条拦在用例层而不是靠 zod strip，
 * 否则前端传了 `companyDraft` 会静默失效，员工以为自己在建公司、实际没建。
 */
export function assertNoCompanyDraft(draft: unknown): void {
  if (draft === undefined || draft === null) return;
  throw new AppError('VALIDATION_FAILED', '公司只能选不能建', { field: 'companyDraft' });
}
