import {
  AppError,
  DEDUPE_CONSOLE_LIMIT,
  DedupeDecisionInputSchema,
  DedupeListQuerySchema,
  allowsScope,
  type DedupeDecisionInput,
  type DedupeDecisionResult,
  type DedupeKind,
  type DedupeListQuery,
  type DedupeListResult,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import * as repo from '../repo-dedupe.js';

/**
 * 主数据去重审核台用例（#302 块 C 后半段 / D102）。
 *
 * 三条路由：list（待判队列）/ keep-separate（判为不同）/ reopen（撤销判定）。
 * 合并（`pending → merged`）不在这里，属后续合并单；本文件只保证列表能读出 merged。
 *
 * 硬规矩：
 * 1. **没权限 / 公司不可见一律 403，且响应体里没有 `items`**。空数组在前端等于
 *    「没有待审」，运营会以为今天没事——实际是他看不见（同 D99⑧ 的口径）。
 * 2. 两侧档案都要带名字：审核台要显示「张记建材 vs 张记建材店」，只给 id 没法判。
 * 3. 写操作同事务写审计（D51/D54②），AI 凭证直接拒绝（`ai.policy: forbid`）：
 *    判为不同会让这对以后不再提示，判错就永久漏掉重复客户。
 */

const OBJECT_TYPE = 'masterdata_dedupe';

/**
 * 审核台横跨四类主数据，而仓库**没有** `masterdata` 域（它是模块键，不是权限域），
 * 注册表又要求 operationId 以域名开头，所以三条路由的 operationId 只能是
 * `customer.dedupe.*`（D102①）。但**鉴权绝不能跟着 operationId 走**：
 *
 * - 列表：按调用者实际持有的 `*.read` 过滤，`kind = ANY($kinds)`；
 * - 判定：先读出该行真实的 `kind`，再校验**那个域**的 `merge`。
 *
 * 若统一按 `customer.*` 鉴权，一个只有客户权限的销售就能看到供应商的名字与电话，
 * 一个只有 `customer.merge` 的人就能把两家供应商判成同一家——同一份代码在不同类型上
 * 越权，测试里老板什么都有，是测不出来的。
 */
const DEDUPE_KINDS: readonly DedupeKind[] = ['customer', 'supplier', 'processor', 'product'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface DedupeContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface DedupeWriteContext extends DedupeContext {
  readonly reply: FastifyReply;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

export function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

export function requireDatabase(ctx: DedupeContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, { operationId });
  }
  return database;
}

/**
 * 调用者持有 `read` 的档案类型。空集合 → 403（不是空列表：空列表等于「没有待审」，
 * 见本文件头注释第 1 条）。
 */
function readableKinds(principal: Principal): DedupeKind[] {
  return DEDUPE_KINDS.filter((kind) => allowsScope(principal.scope, kind, 'read'));
}

/**
 * scope = domain.action（D50/D52），domain 取**该行实际的 kind**。
 *
 * 判定用 `merge` 而不是 `update`：「这两个要不要并成一个」就是合并主数据这个动作本身，
 * 判为不同是它的另一种结论；借 `update` 会让「能改客户电话的人」顺手把重复提示全部关掉（D102②）。
 *
 * 导出给块 D 的合并用例复用（`usecases/dedupe-merge.ts`）：合并与判不同是同一个权限点，
 * 两处各写一份 `allowsScope` 迟早一边改了另一边没改。
 */
export function requireKindMerge(principal: Principal, kind: DedupeKind): void {
  if (!allowsScope(principal.scope, kind, 'merge')) {
    throw new AppError('FORBIDDEN', `缺少 ${kind}.merge 权限`, { kind });
  }
}

/** D15：公司必须在调用者可见集合内；不在此集合 → 403，绝不降级成空列表。 */
export function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该公司的去重队列无权限', { companyId });
  }
}

/** AI 不得直接执行判定（D52① / D54⑥）。 */
export function assertHumanCredential(principal: Principal): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接判定主数据去重结果，需人类审批');
  }
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseQuery(request: FastifyRequest): DedupeListQuery {
  const parsed = DedupeListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', { field, issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

export function parsePairId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id' });
  }
  return id;
}

function parseDecision(body: unknown): DedupeDecisionInput {
  const parsed = DedupeDecisionInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

export function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  action: string,
  objectId: string,
  changeSummary: Record<string, unknown>,
  reason: string,
): MutableAuditEvent {
  return {
    tenantId: principal.tenantId,
    companyId: null,
    actorType: principal.actorType,
    actorId: principal.actorId,
    credentialId: principal.credentialId,
    source: request.auditSource,
    action,
    objectType: OBJECT_TYPE,
    objectId,
    changeSummary,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: headerValue(request, 'user-agent') ?? null,
    // 判定理由是请求体里的业务理由，比 X-Reason 头更能说明这次判定为什么这么判。
    reason,
  };
}

/**
 * 待判队列（普通读，不记审计 D54②）。
 *
 * 一次 200 条、不分页（D102）：这是「今天有多少可疑对子」的工作台，
 * 处理一条少一条；真到 200 条该先处理，而不是翻页。
 */
export async function listDedupe(ctx: DedupeContext): Promise<DedupeListResult> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'customer.dedupe.list');

  const kinds = readableKinds(principal);
  if (kinds.length === 0) {
    // 一类主数据都读不了 → 403，绝不回空列表：空列表会被当成「今天没有待审」。
    throw new AppError('FORBIDDEN', '缺少主数据读权限，无法查看去重队列', { kinds: [] });
  }

  const query = parseQuery(ctx.request);
  assertCompanyVisible(principal, query.companyId);
  if (query.kind && !kinds.includes(query.kind)) {
    // 点名要一类自己没有读权限的档案，同样 403（回空列表等于暗示「这一类没有重复」）。
    throw new AppError('FORBIDDEN', `缺少 ${query.kind}.read 权限`, { kind: query.kind });
  }

  const items = await withTenant(database, principal.tenantId, (tx) =>
    repo.listPairs(repoContext(tx, principal), {
      companyId: query.companyId,
      kinds,
      kind: query.kind,
      state: query.state ?? 'pending',
      limit: DEDUPE_CONSOLE_LIMIT,
    }),
  );

  return { items };
}

/**
 * 读出该行真实的 `kind` 再鉴权：先查行、后校验 `merge`，且**不锁行**
 * （`FOR UPDATE` 在 repo 里、位于鉴权之后——否则越权者能靠刷 403 把行锁住）。
 */
async function authorizeDecision(tx: SqlClient, principal: Principal, id: string): Promise<void> {
  const row = await repo.readPair(repoContext(tx, principal), id);
  if (!row) throw new AppError('NOT_FOUND', '疑似重复记录不存在');
  requireKindMerge(principal, row.kind);
}

/** 判为不同：`pending → kept`，同事务记审计；已判定 → 409。 */
export async function keepSeparateDedupe(ctx: DedupeWriteContext): Promise<DedupeDecisionResult> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'customer.dedupe.keep_separate');
  assertHumanCredential(principal);

  const id = parsePairId(ctx.request);
  const input = parseDecision(ctx.request.body);

  const audit = auditEventOf(
    ctx.request,
    principal,
    'customer.dedupe.keep_separate',
    id,
    { to: 'kept', reason: input.reason },
    input.reason,
  );

  const outcome = await withAudit(database, audit, async (tx) => {
    await authorizeDecision(tx, principal, id);
    const decided = await repo.keepSeparate(repoContext(tx, principal), id, principal.employeeId);
    audit.companyId = decided.companyId;
    return decided;
  });

  return { id: outcome.id, state: outcome.state, decidedAt: outcome.decidedAt };
}

/** 撤销「判为不同」：`kept → pending`，清空 decided_at / decided_by；merged 不许撤销。 */
export async function reopenDedupe(ctx: DedupeWriteContext): Promise<DedupeDecisionResult> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'customer.dedupe.reopen');
  assertHumanCredential(principal);

  const id = parsePairId(ctx.request);
  const input = parseDecision(ctx.request.body);

  const audit = auditEventOf(
    ctx.request,
    principal,
    'customer.dedupe.reopen',
    id,
    { to: 'pending', reason: input.reason },
    input.reason,
  );

  const outcome = await withAudit(database, audit, async (tx) => {
    await authorizeDecision(tx, principal, id);
    const reopened = await repo.reopen(repoContext(tx, principal), id);
    audit.companyId = reopened.companyId;
    return reopened;
  });

  return { id: outcome.id, state: outcome.state, decidedAt: outcome.decidedAt };
}

export function repoContext(tx: SqlClient, principal: Principal): repo.DedupeRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
}
