import {
  AppError,
  SalesOrderCreateInputSchema,
  SalesOrderListQuerySchema,
  SalesOrderUpdateInputSchema,
  allowsScope,
  assertCancelable,
  canCancel,
  clampLimit,
  decodeCursor,
  etagOf,
  type CursorPayload,
  type SalesOrder,
  type SalesOrderCreateInput,
  type SalesOrderDetail,
  type SalesOrderStatus,
  type SalesOrderUpdateInput,
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
 * 销售单 E 用例（D15 / D16 / D20 / D21 / D22 / D39 / D51 / D52 / D54）。
 *
 * - 权限：sales.read|create|update|delete；
 * - 公司隔离：读改删由 repo 带可见公司集合，跨公司等同不存在；
 * - 单号：创建时在业务事务内取 E 号；
 * - 金额：decimal 字符串；商品行金额与单头合计由 SQL 计算 / 聚合；
 * - 改价下限：repo 按行计算加权平均批次成本；低于下限时本批直接拒绝，
 *   不新增审批表或契约字段，待 platform 审批能力落地后由调用方重试；
 * - 审计：create / update / cancel 与业务同事务写；普通读不写；
 * - AI：开单和取消默认拒绝，修改允许；
 * - 取消：复用 assertCancelable（D21）。
 */

const OBJECT_TYPE = 'sales_order';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface SalesOrderContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface SalesOrderWriteContext extends SalesOrderContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly customerId?: string;
  readonly status?: SalesOrderStatus;
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
  ctx: SalesOrderContext,
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
  if (!allowsScope(principal.scope, 'sales', action)) {
    throw new AppError('FORBIDDEN', `缺少 sales.${action} 权限`);
  }
}

function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该销售单所属公司无权限', {
      companyId,
    });
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
  const parsed = SalesOrderListQuerySchema.safeParse(request.query);
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
    customerId: parsed.data.customerId,
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

function parseCreateInput(body: unknown): SalesOrderCreateInput {
  const parsed = SalesOrderCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

function parseUpdateInput(body: unknown): SalesOrderUpdateInput {
  const parsed = SalesOrderUpdateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
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
): repo.SalesOrderRepoContext {
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

/** 销售单列表（普通读，不记审计）。 */
export async function listSalesOrders(
  ctx: SalesOrderContext,
): Promise<{ items: SalesOrder[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.list.read');
  requireScope(principal, 'read');
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listSalesOrders(repoContext(tx, principal), query),
  );
}

/** 销售单详情（普通读，不记审计）；本批收款块为空占位。 */
export async function getSalesOrder(
  ctx: SalesOrderContext,
): Promise<SalesOrderDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.detail.read');
  requireScope(principal, 'read');
  const id = parseOrderId(ctx.request);

  const detail = await withTenant(database, principal.tenantId, async (tx) => {
    const order = await repo.getSalesOrder(repoContext(tx, principal), id);
    if (!order) return null;
    const downstream = await repo.hasDirectDownstream(
      repoContext(tx, principal),
      {
        id: order.id,
        companyId: order.companyId,
        status: order.status,
        version: order.version,
      },
    );
    return {
      ...order,
      /** 收款记录端点不在本任务范围，详情按契约返回空块与零余额。 */
      receipts: [],
      receiptBalance: '0',
      cancelable: canCancel(order.status, downstream),
    };
  });
  if (!detail) throw new AppError('NOT_FOUND', '销售单不存在');
  return detail;
}

/** 开销售单：201 + 同事务取 E 号 / 审计（D16 / D51）。 */
export async function createSalesOrder(
  ctx: SalesOrderWriteContext,
): Promise<SalesOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.create');
  requireScope(principal, 'create');
  assertHumanCredential(principal, '开销售单');

  const input = parseCreateInput(ctx.request.body);
  assertCompanyVisible(principal, input.companyId);

  const id = uuidv7();
  const audit = auditEventOf(ctx.request, principal, 'sales.order.create', id, {
    companyId: input.companyId,
    customerId: input.customerId,
    handlerId: input.handlerId,
    lineCount: input.lines.length,
    feeCount: input.fees?.length ?? 0,
  });
  audit.companyId = input.companyId;

  const order = await withAudit(database, audit, async (tx) => {
    const orderNo = await takeDocumentNo(tx, 'E', input.companyId, new Date());
    const created = await repo.insertSalesOrder(repoContext(tx, principal), {
      ...input,
      id,
      orderNo,
    });
    audit.companyId = created.companyId;
    audit.changeSummary = {
      orderNo: created.orderNo,
      customerId: created.customerId,
      handlerId: created.handlerId,
      totalAmount: created.totalAmount,
      lineCount: created.lines.length,
      feeCount: created.fees.length,
    };
    return created;
  });

  ctx.reply.status(201);
  return order;
}

/** 修改销售单：If-Match 强 ETag；仅「进行中」可改；成功后回新 ETag。 */
export async function updateSalesOrder(
  ctx: SalesOrderWriteContext,
): Promise<SalesOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.update');
  requireScope(principal, 'update');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const input = parseUpdateInput(ctx.request.body);
  const audit = auditEventOf(ctx.request, principal, 'sales.order.update', id, {
    changedFields: Object.keys(input),
  });

  const order = await withAudit(database, audit, async (tx) => {
    const updated = await repo.updateSalesOrder(
      repoContext(tx, principal),
      id,
      input,
      expectedVersion,
    );
    if (!updated) throw new AppError('NOT_FOUND', '销售单不存在');
    audit.companyId = updated.companyId;
    audit.changeSummary = {
      changedFields: Object.keys(input),
      version: updated.version,
      totalAmount: updated.totalAmount,
      lineCount: updated.lines.length,
      feeCount: updated.fees.length,
    };
    return updated;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return order;
}

/**
 * 取消销售单：危险动作（AI 默认拒绝，D52①）；If-Match 强 ETag。
 * D21：有直接下游先取消下游；已完成 / 已取消不可再次取消。
 */
export async function cancelSalesOrder(
  ctx: SalesOrderWriteContext,
): Promise<SalesOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.cancel');
  requireScope(principal, 'delete');
  assertHumanCredential(principal, '取消销售单');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const state = await withTenant(database, principal.tenantId, (tx) =>
    repo.loadSalesOrderState(repoContext(tx, principal), id),
  );
  if (!state) throw new AppError('NOT_FOUND', '销售单不存在');
  if (state.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '销售单版本与 If-Match 不一致，请重新读取后重试',
      { expected: expectedVersion, current: state.version },
    );
  }

  const downstream = await withTenant(database, principal.tenantId, (tx) =>
    repo.hasDirectDownstream(repoContext(tx, principal), state),
  );
  assertCancelable(state.status, downstream);

  const audit = auditEventOf(ctx.request, principal, 'sales.order.cancel', id, {
    beforeStatus: state.status,
    afterStatus: '已取消',
  });
  const order = await withAudit(database, audit, async (tx) => {
    const cancelled = await repo.cancelSalesOrder(
      repoContext(tx, principal),
      id,
      expectedVersion,
    );
    if (!cancelled) throw new AppError('NOT_FOUND', '销售单不存在');
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
