import {
  AppError,
  StocktakeCreateInputSchema,
  StocktakeDecreaseInputSchema,
  StocktakeIncreaseInputSchema,
  StocktakeListQuerySchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  stocktakeApprovable,
  type CursorPayload,
  type Stocktake,
  type StocktakeCreateInput,
  type StocktakeDetail,
  type StocktakeStatus,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { takeDocumentNo } from '../../../platform/numbering/service.js';
import * as repo from '../repo-stocktakes.js';
import { applyStockAdjustment } from '../services/stock-flow.js';

/**
 * 盘点调整 I 用例（D15 / D16 / D47 / D51 / D52 / D54 / D60 / D67）。
 *
 * - 权限：读 `stocktake.read`；盘盈 `stocktake.create`；盘亏 `stocktake.delete`（仅删减）；
 *   审批 `stocktake.approve`（D71）；
 * - 公司隔离：读写均由 repo 带可见公司集合，跨公司等同不存在；
 * - 单号：创建时在业务事务内取 `I` 号（D16）；
 * - 差异：客户端只传账面量 / 实盘量，`diffQty = actualQty - bookQty` 由 SQL 计算；
 * - 审计：create / approve 与业务同事务写；普通读不记（D51 / D54②）；
 * - AI：发起与审批默认禁止；审批必须人类且带 reason（D52① / D54⑥）；
 * - 审批：强 If-Match；非待审批 409（details.reason 取契约枚举）；通过后在同一
 *   事务内经 `services/stock-flow.ts` 调整批次并追加 `source_doc_type='stocktake'`
 *   的库存流水（D47 / D67），不物理删除任何行。
 */

const OBJECT_TYPE = 'stocktake';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface StocktakeContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface StocktakeWriteContext extends StocktakeContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly status?: StocktakeStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

function headerValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(
  ctx: StocktakeContext,
  operationId: string,
): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError(
      'NOT_IMPLEMENTED',
      `数据库未配置，${operationId} 不可用`,
      { operationId },
    );
  }
  return database;
}

function requireScope(
  principal: Principal,
  action: 'read' | 'create' | 'delete' | 'approve',
): void {
  if (!allowsScope(principal.scope, 'stocktake', action)) {
    throw new AppError('FORBIDDEN', `缺少 stocktake.${action} 权限`);
  }
}

function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该盘点单所属公司无权限', {
      companyId,
    });
  }
}

/** 契约 stocktake.create 为 ai.policy=forbid：AI 不得发起盘点单（D52①）。 */
function assertHumanCreation(principal: Principal): void {
  if (principal.actorType === 'ai') {
    throw new AppError(
      'AI_ACTION_FORBIDDEN',
      'AI 不得发起盘点单，需人类操作',
    );
  }
}

/**
 * 契约 stocktake.approve 为 ai.policy=forbid + reasonRequired：
 * 路由 preHandler 已对 AI 写请求做 X-Reason 闸门；这里兜底用例直调用，
 * 并在有 reason 时仍明确拒绝 AI 审批（D52① / D54⑥）。
 */
function assertHumanApproval(
  request: FastifyRequest,
  principal: Principal,
): void {
  if (principal.actorType !== 'ai') return;
  if (!request.auditReason) {
    throw new AppError(
      'VALIDATION_FAILED',
      'AI 调用审批盘点单必须提供 X-Reason',
      { header: 'X-Reason' },
    );
  }
  throw new AppError(
    'AI_ACTION_FORBIDDEN',
    'AI 不得审批盘点单，必须由人类审批',
  );
}

function issuesOf(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseListQuery(request: FastifyRequest): ParsedListQuery {
  const parsed = StocktakeListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  let cursor: CursorPayload | undefined;
  if (parsed.data.cursor !== undefined) {
    cursor = decodeCursor(parsed.data.cursor);
    if (!UUID_RE.test(cursor.id)) {
      throw new AppError('VALIDATION_FAILED', 'cursor 内容不合法', {
        field: 'cursor',
      });
    }
  }
  return {
    companyId: parsed.data.companyId,
    status: parsed.data.status,
    keyword: parsed.data.keyword,
    cursor,
    limit: clampLimit(parsed.data.limit),
  };
}

function parseStocktakeId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', {
      field: 'id',
    });
  }
  return id;
}

function parseCreateInput(
  body: unknown,
  schema: typeof StocktakeCreateInputSchema,
): StocktakeCreateInput {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

/** 强 ETag `"<version>"`；缺失 -> 428，格式非法 -> 409。 */
function parseIfMatchVersion(request: FastifyRequest): number {
  const raw = headerValue(request, 'if-match');
  if (raw === undefined || raw.trim() === '') {
    throw new AppError(
      'PRECONDITION_REQUIRED',
      '该操作必须携带 If-Match（强 ETag "<version>"）',
    );
  }
  const match = /^"([0-9]+)"$/.exec(raw.trim());
  if (!match) {
    throw new AppError(
      'VERSION_CONFLICT',
      'If-Match 格式不合法，应为强 ETag "<version>"',
      { ifMatch: raw },
    );
  }
  return Number(match[1]);
}

function repoContext(
  tx: SqlClient,
  principal: Principal,
): repo.StocktakeRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  action: string,
  objectId: string,
  changeSummary: Record<string, unknown>,
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
    reason: request.auditReason,
  };
}

function detailOf(stocktake: Stocktake): StocktakeDetail {
  return {
    ...stocktake,
    approvable: stocktakeApprovable(stocktake.status),
  };
}

/** 盘点单列表（普通读，不记审计）。 */
export async function listStocktakes(
  ctx: StocktakeContext,
): Promise<{ items: Stocktake[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'stocktake.list.read');
  requireScope(principal, 'read');
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listStocktakes(repoContext(tx, principal), query),
  );
}

/** 盘点单详情（普通读，不记审计）；内嵌 approvable。 */
export async function getStocktake(
  ctx: StocktakeContext,
): Promise<StocktakeDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'stocktake.detail.read');
  requireScope(principal, 'read');
  const id = parseStocktakeId(ctx.request);

  const stocktake = await withTenant(database, principal.tenantId, (tx) =>
    repo.getStocktake(repoContext(tx, principal), id),
  );
  if (!stocktake) throw new AppError('NOT_FOUND', '盘点单不存在');
  return detailOf(stocktake);
}

/** 盘盈 / 盘亏两个发起端点的差异只在这里（D71）：权限动作、入参 schema、审计 action。 */
interface CreateSpec {
  readonly operationId: 'stocktake.increase.create' | 'stocktake.decrease.create';
  readonly scopeAction: 'create' | 'delete';
  readonly schema: typeof StocktakeCreateInputSchema;
}

async function createStocktakeWith(
  ctx: StocktakeWriteContext,
  spec: CreateSpec,
): Promise<Stocktake> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, spec.operationId);
  requireScope(principal, spec.scopeAction);
  assertHumanCreation(principal);

  const input = parseCreateInput(ctx.request.body, spec.schema);
  assertCompanyVisible(principal, input.companyId);

  const id = uuidv7();
  const audit = auditEventOf(ctx.request, principal, spec.operationId, id, {
    companyId: input.companyId,
    batchId: input.batchId,
    bookQty: input.bookQty,
    actualQty: input.actualQty,
  });
  audit.companyId = input.companyId;

  const created = await withAudit(database, audit, async (tx) => {
    const rc = repoContext(tx, principal);
    await repo.assertBatchInCompany(rc, input.batchId, input.companyId);
    const stocktakeNo = await takeDocumentNo(tx, 'I', input.companyId, new Date());
    const stocktake = await repo.insertStocktake(rc, {
      ...input,
      id,
      stocktakeNo,
      applicantId: principal.employeeId,
    });
    audit.changeSummary = {
      stocktakeNo: stocktake.stocktakeNo,
      batchId: stocktake.batchId,
      bookQty: stocktake.bookQty,
      actualQty: stocktake.actualQty,
      diffQty: stocktake.diffQty,
      status: stocktake.status,
    };
    return stocktake;
  });

  ctx.reply.status(201);
  return created;
}

/**
 * 发起盘盈单（实盘量 > 账面量）：权限 `stocktake.create`（D71）。
 * 201 + 同事务取 I 号 / 服务端算差异 / 审计（D16 / D47 / D51）。
 */
export async function createStocktakeIncrease(
  ctx: StocktakeWriteContext,
): Promise<Stocktake> {
  return await createStocktakeWith(ctx, {
    operationId: 'stocktake.increase.create',
    scopeAction: 'create',
    schema: StocktakeIncreaseInputSchema as unknown as typeof StocktakeCreateInputSchema,
  });
}

/** 发起盘亏单（实盘量 < 账面量）：权限 `stocktake.delete`（仅删减，D47 / D71）。 */
export async function createStocktakeDecrease(
  ctx: StocktakeWriteContext,
): Promise<Stocktake> {
  return await createStocktakeWith(ctx, {
    operationId: 'stocktake.decrease.create',
    scopeAction: 'delete',
    schema: StocktakeDecreaseInputSchema as unknown as typeof StocktakeCreateInputSchema,
  });
}

/**
 * 审批盘点单：人类 + stocktake.approve + If-Match。
 *
 * 通过后同事务调整批次（盘盈 +diff / 盘亏 -|diff|）并追加库存流水；
 * 库存写入只经 `services/stock-flow.ts`（D67），任何行都不物理删除（D47）。
 */
export async function approveStocktake(
  ctx: StocktakeWriteContext,
): Promise<StocktakeDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'stocktake.approve');
  requireScope(principal, 'approve');
  assertHumanApproval(ctx.request, principal);

  const id = parseStocktakeId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const state = await withTenant(database, principal.tenantId, (tx) =>
    repo.loadStocktakeState(repoContext(tx, principal), id),
  );
  if (!state) throw new AppError('NOT_FOUND', '盘点单不存在');
  if (state.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '盘点单版本与 If-Match 不一致，请重新读取后重试',
      { expected: expectedVersion, current: state.version },
    );
  }

  const approvable = stocktakeApprovable(state.status);
  if (!approvable.allowed) {
    throw new AppError(
      'VERSION_CONFLICT',
      `盘点单当前状态「${state.status}」不可审批`,
      { reason: approvable.reason, status: state.status },
    );
  }

  const audit = auditEventOf(ctx.request, principal, 'stocktake.approve', id, {
    beforeStatus: state.status,
    afterStatus: '已批准',
    batchId: state.batchId,
    diffQty: state.diffQty,
  });
  audit.companyId = state.companyId;

  const detail = await withAudit(database, audit, async (tx) => {
    const rc = repoContext(tx, principal);
    const approved = await repo.approveStocktake(
      rc,
      id,
      expectedVersion,
      principal.employeeId,
    );
    if (!approved) {
      throw new AppError(
        'VERSION_CONFLICT',
        '盘点单已被并发修改，请重新读取后重试',
      );
    }

    const adjustment = await applyStockAdjustment(tx, {
      tenantId: principal.tenantId,
      companyId: state.companyId,
      batchId: state.batchId,
      delta: state.diffQty,
      sourceDocType: 'stocktake',
      sourceDocId: id,
      handledBy: principal.employeeId,
    });

    const updated = await repo.getStocktake(rc, id);
    if (!updated) {
      throw new AppError('INTERNAL_ERROR', '盘点单审批后读取失败', { id });
    }
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: updated.status,
      version: updated.version,
      approverId: updated.approverId,
      batchId: state.batchId,
      diffQty: state.diffQty,
      inboundQty: adjustment.inboundQty,
      availableQty: adjustment.availableQty,
      custodianId: adjustment.custodianId,
    };
    return detailOf(updated);
  });

  return detail;
}
