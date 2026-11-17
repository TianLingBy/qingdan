import {
  AppError,
  MasterdataSuggestQuerySchema,
  SUGGEST_DEFAULT_LIMIT,
  allowsScope,
  type MasterdataSuggestQuery,
  type MasterdataSuggestResult,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database } from '../../../platform/db/client.js';
import { nameCore, normalizeName, rankCandidates } from '../name-similarity.js';
import { suggestSources, type SuggestKind } from '../repo-suggest.js';
import {
  SUGGEST_RATE_LIMIT,
  SUGGEST_RATE_WINDOW_MS,
  takeSuggestQuota,
} from '../suggest-rate-limit.js';

/**
 * 建档防重的 suggest 用例（D99 / #302 块 B）。
 *
 * 四条路由（customer / supplier / processor / product）参数与行为完全一致，
 * 只差「查哪张表」与「要哪个权限域」，因此这里一份实现按 `kind` 分派，
 * 不为四张表各写一份逻辑相同、只改表名的函数。
 *
 * 四条硬规矩：
 * 1. **没权限就 403**，绝不回空数组——空数组在前端等于「未发现相似档案」，
 *    用户会放心地建一条重复的，而实际是他看不见；
 * 2. 候选只回 `id` / `name` / `score` / `reason`，不带电话、地址、税号、开户行；
 * 3. `companyId` 必传：服务端不猜「默认公司」，否则会把别家公司的档案当成当前上下文的候选；
 * 4. 只读、无副作用、不写审计（D54②），但按 principal 限流（见 suggest-rate-limit.ts）。
 */

export interface SuggestContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: SuggestContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, { operationId });
  }
  return database;
}

/** scope = domain.action（D50/D52）；没有对应域的 read 就是 403，不能降级成空结果。 */
function requireReadScope(principal: Principal, kind: SuggestKind): void {
  if (!allowsScope(principal.scope, kind, 'read')) {
    throw new AppError('FORBIDDEN', `缺少 ${kind}.read 权限`);
  }
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseQuery(request: FastifyRequest): MasterdataSuggestQuery {
  const parsed = MasterdataSuggestQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    // `field` 取第一个出错字段，前端据此把错误挂在对应输入框上（`issues` 保留全量）。
    const field = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', { field, issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

/**
 * 公司必须在调用者的可见公司集合内（同 D15 的 create 校验口径）。
 * 不在此集合 → 403：绝不能改成「返回空候选」，那会让用户以为该公司确实没有相似档案。
 */
function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该档案所属公司无权限', { companyId });
  }
}

/** 按 principal 限流（不是按 IP：一间办公室共用一个出口 IP，按 IP 会误伤整间办公室）。 */
function requestQuota(principal: Principal): void {
  if (!takeSuggestQuota(principal.actorId)) {
    throw new AppError('RATE_LIMITED', '相似档案提示过于频繁，请稍后再试', {
      limit: SUGGEST_RATE_LIMIT,
      windowSeconds: SUGGEST_RATE_WINDOW_MS / 1000,
    });
  }
}

async function suggest(kind: SuggestKind, ctx: SuggestContext): Promise<MasterdataSuggestResult> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, `${kind}.suggest`);
  requireReadScope(principal, kind);

  const query = parseQuery(ctx.request);
  assertCompanyVisible(principal, query.companyId);
  requestQuota(principal);

  // 粗筛用核心名（剥过组织后缀），否则用户把「经营部」也打全时就匹配不到库里只写「张记建材」的档案。
  const normalized = normalizeName(query.name);
  const needle = nameCore(normalized) || normalized;

  const sources = await withTenant(database, principal.tenantId, (tx) =>
    suggestSources(
      { tx, tenantId: principal.tenantId, companyIds: principal.companyIds },
      kind,
      needle,
      query.companyId,
    ),
  );

  return {
    candidates: rankCandidates(
      query.name,
      query.companyId,
      sources,
      query.limit ?? SUGGEST_DEFAULT_LIMIT,
    ),
  };
}

export function suggestCustomers(ctx: SuggestContext): Promise<MasterdataSuggestResult> {
  return suggest('customer', ctx);
}

export function suggestSuppliers(ctx: SuggestContext): Promise<MasterdataSuggestResult> {
  return suggest('supplier', ctx);
}

export function suggestProcessors(ctx: SuggestContext): Promise<MasterdataSuggestResult> {
  return suggest('processor', ctx);
}

export function suggestProducts(ctx: SuggestContext): Promise<MasterdataSuggestResult> {
  return suggest('product', ctx);
}
