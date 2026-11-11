import {
  AppError,
  InternalTradeOrderCreateInputSchema,
  InternalTradeOrderReceiveInputSchema,
  InternalTradeOrderListQuerySchema,
  InternalTradeOrderUpdateInputSchema,
  allowsScope,
  assertCancelable,
  clampLimit,
  decodeCursor,
  etagOf,
  internalTradeCancelable,
  internalTradeHeaderState,
  type CursorPayload,
  type InternalTradeOrder,
  type InternalTradeOrderCreateInput,
  type InternalTradeOrderDetail,
  type InternalTradeOrderStatus,
  type InternalTradeOrderUpdateInput,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { takeDocumentNo } from '../../../platform/numbering/service.js';
import { stockBatchTransferPort } from '../../../platform/services/registry.js';
import { settlementDraftPort } from '../../../platform/services/registry.js';
import * as repo from '../repo.js';
import { maskInternalTradeAmounts, maskInternalTradeDetailAmounts } from '../services/masking.js';

/**
 * 内部交易单 N 用例（D15 / D16 / D21 / D22 / D51 / D52 / D54 / D68）。
 *
 * - 权限：internal_trade.read|create|update|delete；
 * - 公司隔离：发出 / 接收公司任一在调用者可见集合内即可读；创建要求双方均可见；
 * - 单号：创建时在业务事务内取 N 号；
 * - 金额：decimal 字符串；行金额、单头在途量由 SQL 计算 / 聚合；
 * - 审计：create / update / cancel 与业务同事务写；普通读不写；
 * - AI：开单和取消默认拒绝，修改允许（D52①）；
 * - 状态：独立四态，取消映射为「进行中」后复用 assertCancelable（D21 / D68②）。
 */

const OBJECT_TYPE = 'internal_trade_order';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addDecimals(values: readonly string[]): string {
  const total = values.reduce((sum, value) => {
    const [whole, fraction = ''] = value.split('.');
    return sum + BigInt(whole ?? '0') * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  }, 0n);
  const whole = total / 1_000_000n;
  const fraction = (total % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? whole.toString() + '.' + fraction : whole.toString();
}

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface InternalTradeOrderContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface InternalTradeOrderWriteContext extends InternalTradeOrderContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly fromCompanyId?: string;
  readonly toCompanyId?: string;
  readonly status?: InternalTradeOrderStatus;
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
  ctx: InternalTradeOrderContext,
  operationId: string,
): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError(
      'NOT_IMPLEMENTED',
      `数据库未配置，${operationId} 不可用`,
      {
        operationId,
      },
    );
  }
  return database;
}

function requireScope(
  principal: Principal,
  action: 'read' | 'create' | 'update' | 'delete',
): void {
  if (!allowsScope(principal.scope, 'internal_trade', action)) {
    throw new AppError('FORBIDDEN', `缺少 internal_trade.${action} 权限`);
  }
}

/** 契约里开单与取消均为 ai.policy=forbid；修改允许。 */
function assertHumanCredential(principal: Principal, action: string): void {
  if (principal.actorType === 'ai') {
    throw new AppError(
      'AI_ACTION_FORBIDDEN',
      `AI 不得直接${action}，需人类审批`,
    );
  }
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
  const parsed = InternalTradeOrderListQuerySchema.safeParse(request.query);
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
    fromCompanyId: parsed.data.fromCompanyId,
    toCompanyId: parsed.data.toCompanyId,
    status: parsed.data.status,
    keyword: parsed.data.keyword,
    cursor,
    limit: clampLimit(parsed.data.limit),
  };
}

function parseOrderId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', {
      field: 'id',
    });
  }
  return id;
}

function parseCreateInput(body: unknown): InternalTradeOrderCreateInput {
  const parsed = InternalTradeOrderCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

function parseUpdateInput(body: unknown): InternalTradeOrderUpdateInput {
  const parsed = InternalTradeOrderUpdateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

function parseReceiveInput(body: unknown): void {
  const parsed = InternalTradeOrderReceiveInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
}

/** 强 ETag `"<version>"`；缺失 → 428，格式非法 → 409。 */
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
): repo.InternalTradeOrderRepoContext {
  return {
    tx,
    tenantId: principal.tenantId,
    companyIds: principal.companyIds,
  };
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  action: string,
  objectId: string | null,
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

/** 内部交易单列表（普通读，不记审计）；金额按 `internal_trade.view_price` 脱敏（D27 / D79）。 */
export async function listInternalTradeOrders(
  ctx: InternalTradeOrderContext,
): Promise<{ items: InternalTradeOrder[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.list.read');
  requireScope(principal, 'read');
  const query = parseListQuery(ctx.request);
  const canViewPrice = allowsScope(principal.scope, 'internal_trade', 'view_price');

  const page = await withTenant(database, principal.tenantId, (tx) =>
    repo.listInternalTradeOrders(repoContext(tx, principal), query),
  );
  return {
    items: page.items.map((order) => maskInternalTradeAmounts(order, canViewPrice)),
    nextCursor: page.nextCursor,
  };
}

/** 内部交易单详情（普通读，不记审计）；内嵌四态取消判定，金额同样脱敏。 */
export async function getInternalTradeOrder(
  ctx: InternalTradeOrderContext,
): Promise<InternalTradeOrderDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.detail.read');
  requireScope(principal, 'read');
  const id = parseOrderId(ctx.request);
  const canViewPrice = allowsScope(principal.scope, 'internal_trade', 'view_price');

  const detail = await withTenant(database, principal.tenantId, async (tx) => {
    const context = repoContext(tx, principal);
    const order = await repo.getInternalTradeOrder(context, id);
    if (!order) return null;
    const downstream = await repo.hasDirectDownstream(context, {
      id: order.id,
      companyId: order.fromCompanyId,
      fromCompanyId: order.fromCompanyId,
      toCompanyId: order.toCompanyId,
      status: order.status,
      version: order.version,
    });
    return {
      ...order,
      cancelable: internalTradeCancelable(order.status, downstream),
    };
  });
  if (!detail) throw new AppError('NOT_FOUND', '内部交易单不存在');
  return maskInternalTradeDetailAmounts(detail, canViewPrice);
}

/** 开内部交易单：201 + 同事务取 N 号 / 审计（D16 / D51）；响应按看价脱敏（D79）。 */
export async function createInternalTradeOrder(
  ctx: InternalTradeOrderWriteContext,
): Promise<InternalTradeOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.create');
  requireScope(principal, 'create');
  assertHumanCredential(principal, '开内部交易单');
  const canViewPrice = allowsScope(principal.scope, 'internal_trade', 'view_price');

  const input = parseCreateInput(ctx.request.body);
  const id = uuidv7();
  const audit = auditEventOf(
    ctx.request,
    principal,
    'internal_trade.order.create',
    id,
    {
      fromCompanyId: input.fromCompanyId,
      toCompanyId: input.toCompanyId,
      handlerId: input.handlerId,
      lineCount: input.lines.length,
      internalPrice: input.internalPrice,
    },
  );

  const order = await withAudit(database, audit, async (tx) => {
    const orderNo = await takeDocumentNo(tx, 'N', input.fromCompanyId, new Date());
    const created = await repo.insertInternalTradeOrder(
      repoContext(tx, principal),
      {
        ...input,
        id,
        orderNo,
      },
    );
    audit.companyId = created.fromCompanyId;
    audit.changeSummary = {
      orderNo: created.orderNo,
      fromCompanyId: created.fromCompanyId,
      toCompanyId: created.toCompanyId,
      handlerId: created.handlerId,
      internalPrice: created.internalPrice,
      inTransitQty: created.inTransitQty,
      lineCount: created.lines.length,
    };
    return created;
  });

  ctx.reply.status(201);
  return maskInternalTradeAmounts(order, canViewPrice);
}

/** 修改内部交易单：If-Match 强 ETag；仅「进行中」可改；成功后回新 ETag；响应按看价脱敏（D79）。 */
export async function updateInternalTradeOrder(
  ctx: InternalTradeOrderWriteContext,
): Promise<InternalTradeOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.update');
  requireScope(principal, 'update');
  const canViewPrice = allowsScope(principal.scope, 'internal_trade', 'view_price');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const input = parseUpdateInput(ctx.request.body);
  const audit = auditEventOf(
    ctx.request,
    principal,
    'internal_trade.order.update',
    id,
    {
      changedFields: Object.keys(input),
    },
  );

  const order = await withAudit(database, audit, async (tx) => {
    const updated = await repo.updateInternalTradeOrder(
      repoContext(tx, principal),
      id,
      input,
      expectedVersion,
    );
    if (!updated) throw new AppError('NOT_FOUND', '内部交易单不存在');
    audit.companyId = updated.fromCompanyId;
    audit.changeSummary = {
      changedFields: Object.keys(input),
      version: updated.version,
      internalPrice: updated.internalPrice,
      inTransitQty: updated.inTransitQty,
      lineCount: updated.lines.length,
    };
    return updated;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return maskInternalTradeAmounts(order, canViewPrice);
}

/**
 * 取消内部交易单：危险动作（AI 默认拒绝，D52①）；If-Match 强 ETag。
 * D21 / D68②：进行中与在途均映射为「进行中」参与取消判定；
 * 已完成 / 已取消不可取消；有直接下游先取消下游。
 */
export async function cancelInternalTradeOrder(
  ctx: InternalTradeOrderWriteContext,
): Promise<InternalTradeOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.cancel');
  requireScope(principal, 'delete');
  assertHumanCredential(principal, '取消内部交易单');
  const canViewPrice = allowsScope(principal.scope, 'internal_trade', 'view_price');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const state = await withTenant(database, principal.tenantId, (tx) =>
    repo.loadInternalTradeOrderState(repoContext(tx, principal), id),
  );
  if (!state) throw new AppError('NOT_FOUND', '内部交易单不存在');
  if (state.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '内部交易单版本与 If-Match 不一致，请重新读取后重试',
      { expected: expectedVersion, current: state.version },
    );
  }

  const downstream = await withTenant(database, principal.tenantId, (tx) =>
    repo.hasDirectDownstream(repoContext(tx, principal), state),
  );
  assertCancelable(internalTradeHeaderState(state.status), downstream);

  const audit = auditEventOf(
    ctx.request,
    principal,
    'internal_trade.order.cancel',
    id,
    {
      beforeStatus: state.status,
      afterStatus: '已取消',
    },
  );
  const order = await withAudit(database, audit, async (tx) => {
    const cancelled = await repo.cancelInternalTradeOrder(
      repoContext(tx, principal),
      id,
      expectedVersion,
    );
    if (!cancelled) throw new AppError('NOT_FOUND', '内部交易单不存在');
    audit.companyId = cancelled.fromCompanyId;
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: cancelled.status,
      version: cancelled.version,
    };
    return cancelled;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return maskInternalTradeAmounts(order, canViewPrice);
}

/** 到货确认：在同一事务内转移关联批次并把 N 单置为已完成（D22 / D31）。 */
export async function receiveInternalTradeOrder(
  ctx: InternalTradeOrderWriteContext,
): Promise<InternalTradeOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.receive');
  requireScope(principal, 'update');
  assertHumanCredential(principal, '确认内部交易到货');
  const canViewPrice = allowsScope(principal.scope, 'internal_trade', 'view_price');
  parseReceiveInput(ctx.request.body);

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const state = await withTenant(database, principal.tenantId, (tx) =>
    repo.loadInternalTradeOrderState(repoContext(tx, principal), id),
  );
  if (!state) throw new AppError('NOT_FOUND', '内部交易单不存在');
  if (state.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '内部交易单版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: state.version,
    });
  }
  if (state.status !== '在途') {
    throw new AppError('VALIDATION_FAILED', '只有在途状态的内部交易单可以确认到货');
  }
  if (!principal.companyIds.includes(state.toCompanyId)) {
    throw new AppError('FORBIDDEN', '调用者对接收公司无权限', { companyId: state.toCompanyId });
  }

  const audit = auditEventOf(
    ctx.request,
    principal,
    'internal_trade.order.receive',
    id,
    { beforeStatus: state.status, afterStatus: '已完成' },
  );
  const order = await withAudit(database, audit, async (tx) => {
    const source = await repo.getInternalTradeOrder(repoContext(tx, principal), id);
    if (!source) throw new AppError('NOT_FOUND', '内部交易单不存在');
    const batchIds = await repo.listBatchIdsForOrder(repoContext(tx, principal), id);
    await stockBatchTransferPort().transferBatches(tx, {
      tenantId: principal.tenantId,
      fromCompanyId: state.fromCompanyId,
      toCompanyId: state.toCompanyId,
      transfers: batchIds.map((batchId) => ({ batchId })),
    });
    const draft = await settlementDraftPort().createDraft(tx, {
      tenantId: principal.tenantId,
      companyId: state.toCompanyId,
      sourceDocType: 'N',
      sourceDocId: id,
      totalSaleAmount: addDecimals(source.lines.map((line) => line.amount ?? '0')),
      totalCostAmount: '0',
      relatedLossAmount: '0',
      commissionRateSnapshot: '0',
      commissionAmount: '0',
      commissionOwnerId: source.handlerId,
      createdBy: principal.employeeId,
      requestId: requestIdFor(ctx.request),
    });
    const received = await repo.receiveInternalTradeOrder(
      repoContext(tx, principal),
      id,
      expectedVersion,
    );
    if (!received) throw new AppError('NOT_FOUND', '内部交易单不存在');
    audit.companyId = received.fromCompanyId;
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: received.status,
      version: received.version,
      transferredBatchCount: batchIds.length,
      settlementOrderId: draft.id,
    };
    return received;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return maskInternalTradeAmounts(order, canViewPrice);
}
