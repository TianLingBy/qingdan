import {
  AppError,
  SupplierReturnCreateInputSchema,
  SupplierReturnListQuerySchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  type CursorPayload,
  type SupplierReturn,
  type SupplierReturnCreateInput,
  type SupplierReturnStatus,
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
 * S 供应商退货用例（F4c / D15 / D16 / D21 / D47 / D51 / D52 / D54）。
 *
 * - 只做退钱：没有抵下次货款、换货补发字段或分支；
 * - 权限：`supplier_return.read|create`，服务端按功能域 × 动作判定；
 * - 隔离：所有读写都带 tenant_id + 可见公司集合，跨公司等同不存在；
 * - 单号：创建时在审计同一事务内取 `S-<公司码4>-<日期8>-<流水4>`；
 * - 金额：明细金额与应退金额全部由 repo 交 SQL 计算 / 聚合，保持 decimal 字符串；
 * - 审计：普通读不记；创建成功写 `supplier_return.create`（D51）；
 * - AI：登记冲正单据为危险动作，默认拒绝；AI 调用还必须带 X-Reason（D52）。
 */

const OBJECT_TYPE = 'supplier_return';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface SupplierReturnContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface SupplierReturnWriteContext extends SupplierReturnContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly originalPurchaseOrderId?: string;
  readonly status?: SupplierReturnStatus;
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

function requireDatabase(ctx: SupplierReturnContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, { operationId });
  }
  return database;
}

function requireScope(principal: Principal, action: 'read' | 'create'): void {
  if (!allowsScope(principal.scope, 'supplier_return', action)) {
    throw new AppError('FORBIDDEN', `缺少 supplier_return.${action} 权限`);
  }
}

function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该供应商退货所属公司无权限', { companyId });
  }
}

/**
 * 登记冲正单据是危险动作（D52）：人类录入需具备 supplier_return.create；
 * AI 默认拒绝，且按契约 ai.reasonRequired=true 必须先提供 X-Reason。
 */
function assertHumanCreation(principal: Principal, reason: string | null): void {
  if (principal.actorType !== 'ai') return;
  if (!reason) {
    throw new AppError('VALIDATION_FAILED', 'AI 登记供应商退货必须提供 X-Reason', {
      header: 'X-Reason',
    });
  }
  throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接登记供应商退货，需人类审批');
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseListQuery(request: FastifyRequest): ParsedListQuery {
  const parsed = SupplierReturnListQuerySchema.safeParse(request.query);
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
    originalPurchaseOrderId: parsed.data.originalPurchaseOrderId,
    status: parsed.data.status,
    keyword: parsed.data.keyword,
    cursor,
    limit: clampLimit(parsed.data.limit),
  };
}

function parseSupplierReturnId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id' });
  }
  return id;
}

function parseCreateInput(body: unknown): SupplierReturnCreateInput {
  const parsed = SupplierReturnCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

function repoContext(tx: SqlClient, principal: Principal): repo.PurchaseOrderRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
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
    action: 'supplier_return.create',
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

/** 供应商退货列表（普通读，不记审计）。 */
export async function listSupplierReturns(
  ctx: SupplierReturnContext,
): Promise<{ items: SupplierReturn[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'supplier_return.list.read');
  requireScope(principal, 'read');
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listSupplierReturns(repoContext(tx, principal), query),
  );
}

/** 供应商退货详情（普通读，不记审计）；跨公司等同不存在。 */
export async function getSupplierReturn(ctx: SupplierReturnContext): Promise<SupplierReturn> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'supplier_return.detail.read');
  requireScope(principal, 'read');
  const id = parseSupplierReturnId(ctx.request);

  const supplierReturn = await withTenant(database, principal.tenantId, (tx) =>
    repo.getSupplierReturn(repoContext(tx, principal), id),
  );
  if (!supplierReturn) throw new AppError('NOT_FOUND', '供应商退货单不存在');
  return supplierReturn;
}

/** 登记供应商退货：201 + 同事务取号 / 金额聚合 / 审计（D16 / D51）。 */
export async function createSupplierReturn(
  ctx: SupplierReturnWriteContext,
): Promise<SupplierReturn> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'supplier_return.create');
  requireScope(principal, 'create');
  assertHumanCreation(principal, ctx.request.auditReason);

  const input = parseCreateInput(ctx.request.body);
  assertCompanyVisible(principal, input.companyId);

  const id = uuidv7();
  const audit = auditEventOf(ctx.request, principal, id, {
    companyId: input.companyId,
    originalPurchaseOrderId: input.originalPurchaseOrderId,
    lineCount: input.lines.length,
    batchCount: input.lines.reduce((count, line) => count + line.batchIds.length, 0),
  });
  audit.companyId = input.companyId;

  const created = await withAudit(database, audit, async (tx) => {
    const returnNo = await takeDocumentNo(tx, 'S', input.companyId, new Date());
    const supplierReturn = await repo.insertSupplierReturn(repoContext(tx, principal), {
      ...input,
      id,
      returnNo,
    });
    audit.companyId = supplierReturn.companyId;
    audit.changeSummary = {
      returnNo: supplierReturn.returnNo,
      originalPurchaseOrderId: supplierReturn.originalPurchaseOrderId,
      refundAmount: supplierReturn.refundAmount,
      status: supplierReturn.status,
      lineCount: supplierReturn.lines.length,
      batchCount: supplierReturn.lines.reduce(
        (count, line) => count + line.batchIds.length,
        0,
      ),
    };
    return supplierReturn;
  });

  ctx.reply.status(201);
  return created;
}
