import {
  AppError,
  PurchaseOrderCreateInputSchema,
  PurchaseOrderListQuerySchema,
  PurchaseOrderUpdateInputSchema,
  allowsScope,
  assertCancelable,
  canCancel,
  clampLimit,
  decodeCursor,
  etagOf,
  type CursorPayload,
  type PurchaseOrder,
  type PurchaseOrderCreateInput,
  type PurchaseOrderDetail,
  type PurchaseOrderStatus,
  type PurchaseOrderUpdateInput,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { recordAmountDetailRead } from '../../../platform/audit/sensitive-read.js';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { stockFlowPort } from '../../../platform/services/registry.js';
import { takeDocumentNo } from '../../../platform/numbering/service.js';
import * as repo from '../repo.js';
import { maskPurchaseOrderAmounts } from '../services/masking.js';

/**
 * 采购单 A 用例（D15 / D16 / D21 / D39 / D51 / D52 / D52.1 / D54）。
 *
 * - 权限：`purchase.read|create|update|delete`（scope = domain.action，D44）；
 * - 公司隔离（D15）：读改删由 repo 带可见公司集合，跨公司等同不存在；创建显式校验归属公司；
 * - 单号（D16）：创建时在业务事务内取号，格式 `A-<公司码4>-<日期8>-<流水4>`；
 * - 金额（D54）：一律 decimal 字符串；明细金额与单头合计都由 SQL 计算 / 聚合；
 * - 审计（D51）：create / update / cancel 与业务同事务写；普通读不写（D54②）；
 * - AI（D52 / D52.1）：开单、取消属危险动作，AI 凭证默认拒绝；修改允许；
 * - 取消（D21）：复用 `assertCancelable`，已完成 / 已取消不可取消，有下游先取消下游；
 *   错账走冲正单据，不物理删除（D47）。
 */

const OBJECT_TYPE = 'purchase_order';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 写操作的审计事件需要在事务内回填 companyId / 变更摘要（与 masterdata 同款）。 */
type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface PurchaseOrderContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface PurchaseOrderWriteContext extends PurchaseOrderContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly supplierId?: string;
  readonly status?: PurchaseOrderStatus;
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

function requireDatabase(ctx: PurchaseOrderContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, { operationId });
  }
  return database;
}

/** scope = domain.action（D50/D52）；权限引擎已在认证层合并岗位基线 ⊕ 个人覆盖 ∩ token scope。 */
function requireScope(
  principal: Principal,
  action: 'read' | 'create' | 'update' | 'delete',
): void {
  if (!allowsScope(principal.scope, 'purchase', action)) {
    throw new AppError('FORBIDDEN', `缺少 purchase.${action} 权限`);
  }
}

/** D15：创建必须落在调用者可见公司集合内（服务端判定，前端传参不能放大）。 */
function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该采购单所属公司无权限', { companyId });
  }
}

/**
 * AI 不得直接执行危险动作（D52① / D52.1 / D54⑥）。
 * 契约里开单与取消均为 `ai.policy = forbid`；修改允许，不经过这里。
 */
function assertHumanCredential(principal: Principal, action: string): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', `AI 不得直接${action}，需人类审批`);
  }
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseListQuery(request: FastifyRequest): ParsedListQuery {
  const parsed = PurchaseOrderListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', { issues: issuesOf(parsed.error) });
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
    supplierId: parsed.data.supplierId,
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

function parseCreateInput(body: unknown): PurchaseOrderCreateInput {
  const parsed = PurchaseOrderCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

function parseUpdateInput(body: unknown): PurchaseOrderUpdateInput {
  const parsed = PurchaseOrderUpdateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

/** 强 ETag `"<version>"`；缺失 → 428，格式非法 → 409（与 masterdata 一致）。 */
function parseIfMatchVersion(request: FastifyRequest): number {
  const raw = headerValue(request, 'if-match');
  if (raw === undefined || raw.trim() === '') {
    throw new AppError('PRECONDITION_REQUIRED', '该操作必须携带 If-Match（强 ETag "<version>"）');
  }
  const match = /^"([0-9]+)"$/.exec(raw.trim());
  if (!match) {
    throw new AppError('VERSION_CONFLICT', 'If-Match 格式不合法，应为强 ETag "<version>"', {
      ifMatch: raw,
    });
  }
  return Number(match[1]);
}

function repoContext(tx: SqlClient, principal: Principal): repo.PurchaseOrderRepoContext {
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

/**
 * 采购单列表（普通读，不记审计 D54②）。
 * `keyword` 匹配单号或供应商名；不可见公司一律返回空列表（D15）。
 */
export async function listPurchaseOrders(
  ctx: PurchaseOrderContext,
): Promise<{ items: PurchaseOrder[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'purchase.order.list.read');
  requireScope(principal, 'read');

  const query = parseListQuery(ctx.request);

  const canViewPrice = allowsScope(principal.scope, 'purchase', 'view_price');
  const page = await withTenant(database, principal.tenantId, (tx) =>
    repo.listPurchaseOrders(repoContext(tx, principal), query),
  );
  return {
    items: page.items.map((order) =>
      maskPurchaseOrderAmounts(order, canViewPrice),
    ),
    nextCursor: page.nextCursor,
  };
}

/** 采购单详情（普通读，不记审计）；内嵌取消判定 cancelable（D21）。 */
export async function getPurchaseOrder(ctx: PurchaseOrderContext): Promise<PurchaseOrderDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'purchase.order.detail.read');
  requireScope(principal, 'read');

  const id = parseOrderId(ctx.request);
  const detail = await withTenant(database, principal.tenantId, async (tx) => {
    const order = await repo.getPurchaseOrder(repoContext(tx, principal), id);
    if (!order) return null;
    const downstream = await repo.hasDirectDownstream(repoContext(tx, principal), {
      id: order.id,
      companyId: order.companyId,
      status: order.status,
      version: order.version,
    });
    return { ...order, cancelable: canCancel(order.status, downstream) };
  });
  if (!detail) throw new AppError('NOT_FOUND', '采购单不存在');

  const canViewPrice = allowsScope(principal.scope, 'purchase', 'view_price');
  await recordAmountDetailRead(database, {
    request: ctx.request,
    principal,
    domain: 'purchase',
    operationId: 'purchase.order.detail.read',
    objectType: OBJECT_TYPE,
    objectId: detail.id,
    companyId: detail.companyId,
  });
  return maskPurchaseOrderAmounts(detail, canViewPrice);
}

/** 开采购单：201 + 同事务取号 / 审计（D16 / D51）。 */
export async function createPurchaseOrder(
  ctx: PurchaseOrderWriteContext,
): Promise<PurchaseOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'purchase.order.create');
  requireScope(principal, 'create');
  assertHumanCredential(principal, '开采购单');

  const input = parseCreateInput(ctx.request.body);
  assertCompanyVisible(principal, input.companyId);

  const id = uuidv7();
  const audit = auditEventOf(ctx.request, principal, 'purchase.order.create', id, {
    companyId: input.companyId,
    supplierId: input.supplierId,
    handlerId: input.handlerId,
    lineCount: input.lines.length,
    feeCount: input.fees?.length ?? 0,
  });
  audit.companyId = input.companyId;

  const order = await withAudit(database, audit, async (tx) => {
    const orderNo = await takeDocumentNo(tx, 'A', input.companyId, new Date());
    const created = await repo.insertPurchaseOrder(repoContext(tx, principal), {
      ...input,
      id,
      orderNo,
    });
    audit.companyId = created.companyId;
    audit.changeSummary = {
      orderNo: created.orderNo,
      supplierId: created.supplierId,
      handlerId: created.handlerId,
      goodsAmount: created.goodsAmount,
      feeAmount: created.feeAmount,
      totalAmount: created.totalAmount,
      lineCount: created.lines.length,
      feeCount: created.fees.length,
    };
    return created;
  });

  ctx.reply.status(201);
  // D79：写路径返回的真实金额同样按看价权限脱敏（脱敏只发生在响应上）。
  return maskPurchaseOrderAmounts(
    order,
    allowsScope(principal.scope, 'purchase', 'view_price'),
  );
}

/** 修改采购单：If-Match 强 ETag；仅「进行中」可改；成功后回新 ETag（D4 / D51）。 */
export async function updatePurchaseOrder(
  ctx: PurchaseOrderWriteContext,
): Promise<PurchaseOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'purchase.order.update');
  requireScope(principal, 'update');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const input = parseUpdateInput(ctx.request.body);

  const audit = auditEventOf(ctx.request, principal, 'purchase.order.update', id, {
    changedFields: Object.keys(input),
  });

  const order = await withAudit(database, audit, async (tx) => {
    const updated = await repo.updatePurchaseOrder(
      repoContext(tx, principal),
      id,
      input,
      expectedVersion,
    );
    if (!updated) throw new AppError('NOT_FOUND', '采购单不存在');
    audit.companyId = updated.companyId;
    audit.changeSummary = {
      changedFields: Object.keys(input),
      version: updated.version,
      goodsAmount: updated.goodsAmount,
      feeAmount: updated.feeAmount,
      totalAmount: updated.totalAmount,
    };
    return updated;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  // D79：写路径返回的真实金额同样按看价权限脱敏（脱敏只发生在响应上）。
  return maskPurchaseOrderAmounts(
    order,
    allowsScope(principal.scope, 'purchase', 'view_price'),
  );
}

/**
 * 取消采购单：危险动作（AI 默认拒绝，D52①）；If-Match 强 ETag。
 * D21：已完成 / 已取消不可取消；有直接下游先取消下游；错账走冲正单据。
 */
export async function cancelPurchaseOrder(
  ctx: PurchaseOrderWriteContext,
): Promise<PurchaseOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'purchase.order.cancel');
  requireScope(principal, 'delete');
  assertHumanCredential(principal, '取消采购单');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const state = await withTenant(database, principal.tenantId, (tx) =>
    repo.loadPurchaseOrderState(repoContext(tx, principal), id),
  );
  if (!state) throw new AppError('NOT_FOUND', '采购单不存在');
  if (state.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '采购单版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: state.version,
    });
  }

  const downstream = await withTenant(database, principal.tenantId, (tx) =>
    repo.hasDirectDownstream(repoContext(tx, principal), state),
  );
  // 复用单据框架口径：已完成 / 已取消 / 有下游分别给出稳定错误码。
  assertCancelable(state.status, downstream);

  const audit = auditEventOf(ctx.request, principal, 'purchase.order.cancel', id, {
    beforeStatus: state.status,
    afterStatus: '已取消',
  });

  const order = await withAudit(database, audit, async (tx) => {
    const cancelled = await repo.cancelPurchaseOrder(
      repoContext(tx, principal),
      id,
      expectedVersion,
    );
    if (!cancelled) throw new AppError('NOT_FOUND', '采购单不存在');
    audit.companyId = cancelled.companyId;
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: cancelled.status,
      version: cancelled.version,
    };
    return cancelled;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  // D79：写路径返回的真实金额同样按看价权限脱敏（脱敏只发生在响应上）。
  return maskPurchaseOrderAmounts(
    order,
    allowsScope(principal.scope, 'purchase', 'view_price'),
  );
}

export async function completePurchaseOrder(ctx: PurchaseOrderWriteContext): Promise<PurchaseOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'purchase.order.complete');
  requireScope(principal, 'update');
  assertHumanCredential(principal, '完成采购单');
  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const audit = auditEventOf(ctx.request, principal, 'purchase.order.complete', id, {});
  return withAudit(database, audit, async (tx) => {
    const context = repoContext(tx, principal);
    const state = await repo.loadPurchaseOrderState(context, id);
    if (!state) throw new AppError('NOT_FOUND', '采购单不存在');
    if (state.version !== expectedVersion) throw new AppError('VERSION_CONFLICT', '采购单版本与 If-Match 不一致');
    if (state.status !== '进行中') throw new AppError('VALIDATION_FAILED', '只有进行中的采购单可以完成');
    const order = await repo.getPurchaseOrder(context, id);
    if (!order) throw new AppError('NOT_FOUND', '采购单不存在');
    for (const line of order.lines) {
      if (line.unitPrice === null) throw new AppError('VALIDATION_FAILED', '完成采购单需要看价权限');
      const batch = await stockFlowPort().createBatch(tx, {
        tenantId: principal.tenantId, companyId: order.companyId, productId: line.productId,
        qty: line.qty, lockedUnitCost: line.unitPrice, custodianId: order.handlerId!,
        sourceDocType: 'A', sourceDocId: id, handledBy: principal.employeeId,
      });
      void batch;
    }
    const completed = await repo.completePurchaseOrder(context, id, expectedVersion);
    if (!completed) throw new AppError('NOT_FOUND', '采购单不存在');
    audit.companyId = completed.companyId;
    audit.changeSummary = { beforeStatus: state.status, afterStatus: completed.status, version: completed.version };
    ctx.reply.header('ETag', etagOf(completed.version));
    return maskPurchaseOrderAmounts(completed, allowsScope(principal.scope, 'purchase', 'view_price'));
  });
}
