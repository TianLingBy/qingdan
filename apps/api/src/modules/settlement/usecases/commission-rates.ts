import {
  AppError,
  CommissionRateCreateInputSchema,
  CommissionRateListQuerySchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  type CommissionRate,
  type CursorPayload,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { employeeDirectoryPort } from '../../../platform/services/registry.js';
import * as repo from '../repo.js';

/**
 * 提成比例配置用例（D5④ / D36 / D51 / D52 / D77）。
 *
 * - 配置归 settlement 域（D77 ①），一期**只支持按人**；按岗需要 platform 岗位解析端口，
 *   未落地前不在本批猜实现。
 * - 写入受「可见公司集合」约束（D15）：只能配自己公司的人；写操作记审计（D51）。
 * - 普通读不记审计（D54 ②）；读需要 `commission.read`。
 * - AI 默认禁止配置（D52①，路由层已拦）：配置直接决定钱。
 * - 配置行删除不影响已结算单：那类单据已靠 `commissionRateSnapshot` 冻结（D77 ④）。
 */

const OBJECT_TYPE = 'commission_rate';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface CommissionRateContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface CommissionRateWriteContext extends CommissionRateContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly employeeId?: string;
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
  ctx: CommissionRateContext,
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
  action: 'read' | 'create' | 'delete',
): void {
  if (!allowsScope(principal.scope, 'commission', action)) {
    throw new AppError('FORBIDDEN', `缺少 commission.${action} 权限`);
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
  const parsed = CommissionRateListQuerySchema.safeParse(request.query);
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
    employeeId: parsed.data.employeeId,
    cursor,
    limit: clampLimit(parsed.data.limit),
  };
}

function parseRateId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', {
      field: 'id',
    });
  }
  return id;
}

function repoContext(
  tx: SqlClient,
  principal: Principal,
): repo.SettlementOrderRepoContext {
  return {
    tx,
    tenantId: principal.tenantId,
    companyIds: principal.companyIds,
  };
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  action: 'commission.rate.create' | 'commission.rate.delete',
  objectId: string,
  companyId: string | null,
  changeSummary: Record<string, unknown>,
): MutableAuditEvent {
  return {
    tenantId: principal.tenantId,
    companyId,
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

/** 提成比例配置列表（普通读，不记审计）。 */
export async function listCommissionRates(
  ctx: CommissionRateContext,
): Promise<{ items: CommissionRate[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'commission.rate.list.read');
  requireScope(principal, 'read');
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listCommissionRates(repoContext(tx, principal), query),
  );
}

/**
 * 新增提成比例配置。
 * 只允许配自己可见公司（D15）；同员工 + 公司 + 生效日重复返回 409（D77 ①）。
 */
export async function createCommissionRate(
  ctx: CommissionRateWriteContext,
): Promise<CommissionRate> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'commission.rate.create');
  requireScope(principal, 'create');

  const parsed = CommissionRateCreateInputSchema.safeParse(
    ctx.request.body ?? {},
  );
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '提成配置参数不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  const input = parsed.data;
  if (!principal.companyIds.includes(input.companyId)) {
    throw new AppError('FORBIDDEN', '只能给自己可见的公司配置提成比例');
  }
  const createdBy = principal.employeeId;

  const audit = auditEventOf(
    ctx.request,
    principal,
    'commission.rate.create',
    'pending',
    input.companyId,
    {
      companyId: input.companyId,
      employeeId: input.employeeId,
      rate: input.rate,
      effectiveFrom: input.effectiveFrom,
    },
  );

  const created = await withAudit(database, audit, async (tx) => {
    // D80：员工必须属于所选公司（走 platform 端口，不直读 employee_company_position）。
    const belongs = await employeeDirectoryPort().belongsToCompany(tx, {
      tenantId: principal.tenantId,
      companyId: input.companyId,
      employeeId: input.employeeId,
    });
    if (!belongs) {
      throw new AppError(
        'VALIDATION_FAILED',
        '该员工不属于所选公司，不能配置提成比例（D80）',
        { employeeId: input.employeeId, companyId: input.companyId },
      );
    }

    const result = await repo.createCommissionRate(
      repoContext(tx, principal),
      {
        companyId: input.companyId,
        employeeId: input.employeeId,
        rate: input.rate,
        effectiveFrom: input.effectiveFrom,
        createdBy,
      },
    );
    (audit as MutableAuditEvent).objectId = result.id;
    return result;
  });

  ctx.reply.status(201);
  return created;
}

/** 删除提成比例配置；不存在返回 404。 */
export async function deleteCommissionRate(
  ctx: CommissionRateWriteContext,
): Promise<CommissionRate> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'commission.rate.delete');
  requireScope(principal, 'delete');
  const id = parseRateId(ctx.request);

  const audit = auditEventOf(
    ctx.request,
    principal,
    'commission.rate.delete',
    id,
    null,
    {},
  );

  return withAudit(database, audit, async (tx) => {
    const deleted = await repo.deleteCommissionRate(
      repoContext(tx, principal),
      id,
    );
    if (!deleted) {
      throw new AppError('NOT_FOUND', '提成比例配置不存在');
    }
    (audit as MutableAuditEvent).companyId = deleted.companyId;
    (audit as MutableAuditEvent).changeSummary = {
      id: deleted.id,
      companyId: deleted.companyId,
      employeeId: deleted.employeeId,
      rate: deleted.rate,
      effectiveFrom: deleted.effectiveFrom,
    };
    return deleted;
  });
}
