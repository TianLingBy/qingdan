import {
  AppError,
  SalesReceiptCreateInputSchema,
  allowsScope,
  type SalesReceipt,
  type SalesReceiptCreateInput,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import * as repo from '../repo.js';

/**
 * E 单收款记录用例（D24 / D34 / D40 / D47 / D51 / D52.1 / D54）。
 *
 * - 普通读不记审计；追加收款 / 退款与审计同事务提交；
 * - 退款是同一台账中的负数行，历史行不可更新或删除；
 * - 收款块余额始终由 repo 的 SQL SUM 计算，应用侧不做浮点运算；
 * - 钱账危险动作默认拒绝 AI；AI 调用先要求 X-Reason，再返回 AI_ACTION_FORBIDDEN。
 */

const OBJECT_TYPE = 'sales_receipt';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface SalesReceiptContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface SalesReceiptWriteContext extends SalesReceiptContext {
  readonly reply: FastifyReply;
}

export interface SalesReceiptBlock {
  readonly receipts: SalesReceipt[];
  readonly receiptBalance: string;
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
  ctx: SalesReceiptContext,
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

function requireReadScope(principal: Principal): void {
  if (!allowsScope(principal.scope, 'sales', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 sales.read 权限');
  }
}

function requireUpdateScope(principal: Principal): void {
  if (!allowsScope(principal.scope, 'sales', 'update')) {
    throw new AppError('FORBIDDEN', '缺少 sales.update 权限');
  }
}

function parseSalesOrderId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', {
      field: 'id',
    });
  }
  return id;
}

function issuesOf(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseCreateInput(body: unknown): SalesReceiptCreateInput {
  const parsed = SalesReceiptCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

function assertHumanCreation(principal: Principal, reason: string | null): void {
  if (principal.actorType !== 'ai') return;
  if (!reason) {
    throw new AppError('VALIDATION_FAILED', 'AI 追加收款记录必须提供 X-Reason', {
      header: 'X-Reason',
    });
  }
  throw new AppError(
    'AI_ACTION_FORBIDDEN',
    'AI 不得直接追加收款或退款记录，需人类操作',
  );
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
    action: 'sales.receipt.create',
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

/** E 单内嵌收款块：普通读不记审计（D24 / D54）。 */
export async function getSalesReceiptBlock(
  ctx: SalesReceiptContext,
): Promise<SalesReceiptBlock> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.receipt.read');
  requireReadScope(principal);
  const salesOrderId = parseSalesOrderId(ctx.request);

  return withTenant(database, principal.tenantId, async (tx) => {
    const context = repoContext(tx, principal);
    const order = await repo.loadSalesOrderState(context, salesOrderId);
    if (!order) throw new AppError('NOT_FOUND', '销售单不存在');
    const [receipts, receiptBalance] = await Promise.all([
      repo.listSalesReceipts(context, salesOrderId),
      repo.getSalesReceiptBalance(context, salesOrderId),
    ]);
    return { receipts, receiptBalance };
  });
}

/** GET 收款记录端点。 */
export async function listSalesReceipts(
  ctx: SalesReceiptContext,
): Promise<SalesReceipt[]> {
  return (await getSalesReceiptBlock(ctx)).receipts;
}

/** 追加收款 / 退款行：201 + 同事务审计（D51）。 */
export async function createSalesReceipt(
  ctx: SalesReceiptWriteContext,
): Promise<SalesReceipt> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.receipt.create');
  requireUpdateScope(principal);
  assertHumanCreation(principal, ctx.request.auditReason);

  const salesOrderId = parseSalesOrderId(ctx.request);
  const input = parseCreateInput(ctx.request.body);
  const id = uuidv7();
  const audit = auditEventOf(ctx.request, principal, id, {
    salesOrderId,
    direction: input.direction,
    amount: input.amount,
    method: input.method,
    occurredAt: input.occurredAt,
  });

  const created = await withAudit(database, audit, async (tx) => {
    const context = repoContext(tx, principal);
    const order = await repo.loadSalesOrderState(context, salesOrderId);
    if (!order) throw new AppError('NOT_FOUND', '销售单不存在');
    if (order.status === '已取消') {
      throw new AppError(
        'VALIDATION_FAILED',
        '已取消的销售单不可追加收款或退款记录',
        { status: order.status },
      );
    }

    const receipt = await repo.insertSalesReceipt(context, {
      ...input,
      id,
      companyId: order.companyId,
      salesOrderId,
    });
    audit.companyId = receipt.companyId;
    audit.changeSummary = {
      salesOrderId: receipt.salesOrderId,
      direction: receipt.direction,
      amount: receipt.amount,
      method: receipt.method,
      occurredAt: receipt.occurredAt,
      reversalDocId: receipt.reversalDocId,
    };
    return receipt;
  });

  ctx.reply.status(201);
  return created;
}
