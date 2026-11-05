import {
  AppError,
  ProcessingOrderCreateInputSchema,
  ProcessingOrderListQuerySchema,
  ProcessingOrderUpdateInputSchema,
  allowsScope,
  assertCancelable,
  canCancel,
  clampLimit,
  decodeCursor,
  etagOf,
  type CursorPayload,
  type ProcessingOrder,
  type ProcessingOrderCreateInput,
  type ProcessingOrderDetail,
  type ProcessingOrderStatus,
  type ProcessingOrderUpdateInput,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { takeDocumentNo } from '../../../platform/numbering/service.js';
import * as repo from '../repo.js';

/**
 * 加工单 B 用例（D15 / D16 / D21 / D39 / D47 / D51 / D52 / D54）。
 *
 * - 权限：`processing.read|create|update|delete`（scope = domain.action，D44）；
 * - 公司隔离（D15）：读改删由 repo 带可见公司集合，跨公司等同不存在；
 * - 单号（D16）：创建时在业务事务内取号，格式 `B-<公司码4>-<日期8>-<流水4>`；
 * - 数量 / 金额（D54）：一律 decimal 字符串；可售量由 SQL 计算；
 * - 审计（D51）：create / update / cancel 与业务同事务写；普通读不写；
 * - AI（D52①）：开单 / 取消默认拒绝，修改允许；
 * - 取消（D21）：复用 `assertCancelable`，完成后不可取消，有下游先取消下游。
 */

const OBJECT_TYPE = 'processing_order';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface ProcessingOrderContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface ProcessingOrderWriteContext extends ProcessingOrderContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly processorId?: string;
  readonly status?: ProcessingOrderStatus;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
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
  ctx: ProcessingOrderContext,
  operationId: string,
): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, {
      operationId,
    });
  }
  return database;
}

function requireScope(
  principal: Principal,
  action: 'read' | 'create' | 'update' | 'delete',
): void {
  if (!allowsScope(principal.scope, 'processing', action)) {
    throw new AppError('FORBIDDEN', `缺少 processing.${action} 权限`);
  }
}

function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该加工单所属公司无权限', { companyId });
  }
}

/** 契约里开单与取消均为 `ai.policy = forbid`；修改允许。 */
function assertHumanCredential(principal: Principal, action: string): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', `AI 不得直接${action}，需人类审批`);
  }
}

function issuesOf(
  error: { issues: readonly { path: PropertyKey[]; message: string }[] },
): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseListQuery(request: FastifyRequest): ParsedListQuery {
  const parsed = ProcessingOrderListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  let cursor: CursorPayload | undefined;
  if (parsed.data.cursor !== undefined) {
    cursor = decodeCursor(parsed.data.cursor);
    if (!UUID_RE.test(cursor.id)) {
      throw new AppError('VALIDATION_FAILED', 'cursor 内容不合法', { field: 'cursor' });
    }
  }
  return {
    companyId: parsed.data.companyId,
    processorId: parsed.data.processorId,
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
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id' });
  }
  return id;
}

function parseCreateInput(body: unknown): ProcessingOrderCreateInput {
  const parsed = ProcessingOrderCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

function parseUpdateInput(body: unknown): ProcessingOrderUpdateInput {
  const parsed = ProcessingOrderUpdateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

/** 强 ETag `"<version>"`；缺失 → 428，格式非法 → 409（与 purchase 一致）。 */
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
): repo.ProcessingOrderRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
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

/** 加工单列表（普通读，不记审计）。 */
export async function listProcessingOrders(
  ctx: ProcessingOrderContext,
): Promise<{ items: ProcessingOrder[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processing.order.list.read');
  requireScope(principal, 'read');
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listProcessingOrders(repoContext(tx, principal), query),
  );
}

/** 加工单详情（普通读，不记审计）；补产出批次占位、损失记录占位与取消判定。 */
export async function getProcessingOrder(
  ctx: ProcessingOrderContext,
): Promise<ProcessingOrderDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processing.order.detail.read');
  requireScope(principal, 'read');
  const id = parseOrderId(ctx.request);

  const detail = await withTenant(database, principal.tenantId, async (tx) => {
    const order = await repo.getProcessingOrder(repoContext(tx, principal), id);
    if (!order) return null;
    const state = await repo.loadProcessingOrderState(repoContext(tx, principal), id);
    if (!state) return null;
    const downstream = await repo.hasDirectDownstream(
      repoContext(tx, principal),
      state,
    );
    return {
      ...order,
      /** 本批无「验收 / 完成」端点，产出批次与损失记录均保持占位。 */
      outputBatchId: null,
      lossRecord: null,
      cancelable: canCancel(order.status, downstream),
    };
  });
  if (!detail) throw new AppError('NOT_FOUND', '加工单不存在');
  return detail;
}

/** 开加工单：201 + 同事务取 B 单号 / 审计（D16 / D51）。 */
export async function createProcessingOrder(
  ctx: ProcessingOrderWriteContext,
): Promise<ProcessingOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processing.order.create');
  requireScope(principal, 'create');
  assertHumanCredential(principal, '开加工单');

  const input = parseCreateInput(ctx.request.body);
  assertCompanyVisible(principal, input.companyId);

  const id = uuidv7();
  const audit = auditEventOf(ctx.request, principal, 'processing.order.create', id, {
    companyId: input.companyId,
    processorId: input.processorId,
    handlerId: input.handlerId,
    materialBatchCount: input.materialBatchIds.length,
    feeCount: input.fees.length,
  });
  audit.companyId = input.companyId;

  const order = await withAudit(database, audit, async (tx) => {
    const orderNo = await takeDocumentNo(tx, 'B', input.companyId, new Date());
    const created = await repo.insertProcessingOrder(repoContext(tx, principal), {
      ...input,
      id,
      orderNo,
    });
    audit.companyId = created.companyId;
    audit.changeSummary = {
      orderNo: created.orderNo,
      processorId: created.processorId,
      handlerId: created.handlerId,
      materialBatchIds: created.materialBatchIds,
      inputQty: created.inputQty,
      lossQty: created.lossQty,
      sellableQty: created.sellableQty,
      feeCount: created.fees.length,
    };
    return created;
  });

  ctx.reply.status(201);
  return order;
}

/** 修改加工单：If-Match 强 ETag；仅「进行中」可改；成功后回新 ETag。 */
export async function updateProcessingOrder(
  ctx: ProcessingOrderWriteContext,
): Promise<ProcessingOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processing.order.update');
  requireScope(principal, 'update');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const input = parseUpdateInput(ctx.request.body);
  const audit = auditEventOf(ctx.request, principal, 'processing.order.update', id, {
    changedFields: Object.keys(input),
  });

  const order = await withAudit(database, audit, async (tx) => {
    const updated = await repo.updateProcessingOrder(
      repoContext(tx, principal),
      id,
      input,
      expectedVersion,
    );
    if (!updated) throw new AppError('NOT_FOUND', '加工单不存在');
    audit.companyId = updated.companyId;
    audit.changeSummary = {
      changedFields: Object.keys(input),
      version: updated.version,
      materialBatchIds: updated.materialBatchIds,
      inputQty: updated.inputQty,
      lossQty: updated.lossQty,
      sellableQty: updated.sellableQty,
      feeCount: updated.fees.length,
    };
    return updated;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return order;
}

/**
 * 取消加工单：危险动作（AI 默认拒绝，D52①）；If-Match 强 ETag。
 * D21：有直接下游先取消下游；已完成 / 已取消不可再次取消。
 */
export async function cancelProcessingOrder(
  ctx: ProcessingOrderWriteContext,
): Promise<ProcessingOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processing.order.cancel');
  requireScope(principal, 'delete');
  assertHumanCredential(principal, '取消加工单');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const state = await withTenant(database, principal.tenantId, (tx) =>
    repo.loadProcessingOrderState(repoContext(tx, principal), id),
  );
  if (!state) throw new AppError('NOT_FOUND', '加工单不存在');
  if (state.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '加工单版本与 If-Match 不一致，请重新读取后重试',
      { expected: expectedVersion, current: state.version },
    );
  }

  const downstream = await withTenant(database, principal.tenantId, (tx) =>
    repo.hasDirectDownstream(repoContext(tx, principal), state),
  );
  assertCancelable(state.status, downstream);

  const audit = auditEventOf(ctx.request, principal, 'processing.order.cancel', id, {
    beforeStatus: state.status,
    afterStatus: '已取消',
  });
  const order = await withAudit(database, audit, async (tx) => {
    const cancelled = await repo.cancelProcessingOrder(
      repoContext(tx, principal),
      id,
      expectedVersion,
    );
    if (!cancelled) throw new AppError('NOT_FOUND', '加工单不存在');
    audit.companyId = cancelled.companyId;
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: cancelled.status,
      version: cancelled.version,
    };
    return cancelled;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return order;
}
