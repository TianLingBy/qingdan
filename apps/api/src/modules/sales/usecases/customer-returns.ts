import {
  AppError,
  CustomerReturnCreateInputSchema,
  CustomerReturnListQuerySchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  type CursorPayload,
  type CustomerReturn,
  type CustomerReturnCreateInput,
  type CustomerReturnStatus,
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
 * R 客户退货用例（D36 / D40 / D47 / D51 / D52.1 / D54）。
 *
 * - 权限：`customer_return.read|create`；
 * - D47：录入由老板、经理或财务岗位完成，服务端按当前岗位重新校验；
 * - 隔离：所有读写带 tenant_id + 可见公司集合，跨公司等同不存在；
 * - 单号：创建时在同一事务内取 `R-<公司码4>-<日期8>-<流水4>`；
 * - 金额：明细金额由 SQL 计算，应退金额按 amount 域规范化，保持 decimal 字符串；
 * - 审计：普通读不记；创建成功写 customer_return.create（D51）；
 * - AI：登记冲正单据为危险动作，先要求 X-Reason，再返回 AI_ACTION_FORBIDDEN。
 */

const OBJECT_TYPE = 'customer_return';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface CustomerReturnContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface CustomerReturnWriteContext extends CustomerReturnContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly originalSalesOrderId?: string;
  readonly status?: CustomerReturnStatus;
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
  ctx: CustomerReturnContext,
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
  action: 'read' | 'create',
): void {
  if (!allowsScope(principal.scope, 'customer_return', action)) {
    throw new AppError('FORBIDDEN', `缺少 customer_return.${action} 权限`);
  }
}

function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该客户退货所属公司无权限', {
      companyId,
    });
  }
}

function assertHumanCreation(principal: Principal, reason: string | null): void {
  if (principal.actorType !== 'ai') return;
  if (!reason) {
    throw new AppError('VALIDATION_FAILED', 'AI 登记客户退货必须提供 X-Reason', {
      header: 'X-Reason',
    });
  }
  throw new AppError(
    'AI_ACTION_FORBIDDEN',
    'AI 不得直接登记客户退货，需人类审批',
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
  const parsed = CustomerReturnListQuerySchema.safeParse(request.query);
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
    originalSalesOrderId: parsed.data.originalSalesOrderId,
    status: parsed.data.status,
    keyword: parsed.data.keyword,
    cursor,
    limit: clampLimit(parsed.data.limit),
  };
}

function parseCustomerReturnId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', {
      field: 'id',
    });
  }
  return id;
}

function parseCreateInput(body: unknown): CustomerReturnCreateInput {
  const parsed = CustomerReturnCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
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
    action: 'customer_return.create',
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

/** R 客户退货列表（普通读，不记审计）。 */
export async function listCustomerReturns(
  ctx: CustomerReturnContext,
): Promise<{ items: CustomerReturn[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'customer_return.list.read');
  requireScope(principal, 'read');
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listCustomerReturns(repoContext(tx, principal), query),
  );
}

/** R 客户退货详情（普通读，不记审计）；跨公司等同不存在。 */
export async function getCustomerReturn(
  ctx: CustomerReturnContext,
): Promise<CustomerReturn> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'customer_return.detail.read');
  requireScope(principal, 'read');
  const id = parseCustomerReturnId(ctx.request);

  const customerReturn = await withTenant(database, principal.tenantId, (tx) =>
    repo.getCustomerReturn(repoContext(tx, principal), id),
  );
  if (!customerReturn) throw new AppError('NOT_FOUND', '客户退货单不存在');
  return customerReturn;
}

/** 登记 R 客户退货：201 + 同事务取号 / D47 岗位校验 / 审计（D51）。 */
export async function createCustomerReturn(
  ctx: CustomerReturnWriteContext,
): Promise<CustomerReturn> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'customer_return.create');
  requireScope(principal, 'create');
  assertHumanCreation(principal, ctx.request.auditReason);

  const input = parseCreateInput(ctx.request.body);
  assertCompanyVisible(principal, input.companyId);

  const id = uuidv7();
  const lines = input.lines ?? [];
  const audit = auditEventOf(ctx.request, principal, id, {
    companyId: input.companyId,
    originalSalesOrderId: input.originalSalesOrderId,
    returnType: input.returnType,
    onlyRefundKind: input.onlyRefundKind ?? null,
    refundMode: input.refundMode,
    refundAmount: input.refundAmount,
    lineCount: lines.length,
    batchCount: lines.reduce(
      (count, line) => count + line.batchIds.length,
      0,
    ),
  });
  audit.companyId = input.companyId;

  const created = await withAudit(database, audit, async (tx) => {
    const context = repoContext(tx, principal);
    const approvalAllowed = await repo.hasCustomerReturnApprovalPosition(
      context,
      principal.employeeId,
      input.companyId,
    );
    if (!approvalAllowed) {
      throw new AppError(
        'FORBIDDEN',
        'D47：客户退货仅允许老板、经理或财务岗位录入',
        { companyId: input.companyId },
      );
    }

    const returnNo = await takeDocumentNo(tx, 'R', input.companyId, new Date());
    const customerReturn = await repo.insertCustomerReturn(context, {
      ...input,
      id,
      returnNo,
    });
    audit.companyId = customerReturn.companyId;
    audit.changeSummary = {
      returnNo: customerReturn.returnNo,
      originalSalesOrderId: customerReturn.originalSalesOrderId,
      originalSettlementOrderId: customerReturn.originalSettlementOrderId,
      returnType: customerReturn.returnType,
      onlyRefundKind: customerReturn.onlyRefundKind,
      refundMode: customerReturn.refundMode,
      refundAmount: customerReturn.refundAmount,
      status: customerReturn.status,
      lineCount: customerReturn.lines.length,
      batchCount: customerReturn.lines.reduce(
        (count, line) => count + line.batchIds.length,
        0,
      ),
    };
    return customerReturn;
  });

  ctx.reply.status(201);
  return created;
}
