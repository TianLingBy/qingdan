import {
  AppError,
  SettlementOrderListQuerySchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  etagOf,
  settlementConfirmable,
  type CursorPayload,
  type SettlementOrder,
  type SettlementOrderDetail,
  type SettlementOrderStatus,
  type SettlementSourceDocType,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import * as repo from '../repo.js';

/**
 * C 结算单用例（D15 / D19 / D26 / D51 / D52 / D54 / D69）。
 *
 * - 查询：settlement.read；普通读不记审计。
 * - 确认：settlement.approve；AI 默认禁止且必须带 reason（D52 / D52.1）；
 *   强制 If-Match 强 ETag；成功后状态置「已结算」并冻结相关损失快照。
 * - 金额：服务端不接收 body 金额；确认时由 SQL 以毛利 - 相关损失计算净毛利。
 * - 一期一单一次结算：重复确认返回 422，并发版本变化返回 409。
 *
 * TODO(D19 / D29)：E / N 完成态自动生成 C 单草稿不在本批端点内；待跨模块公开
 * 用例通道落地后接入，禁止 settlement 直读 E / N 表。
 */

const OBJECT_TYPE = 'settlement_order';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface SettlementOrderContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface SettlementOrderWriteContext extends SettlementOrderContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly status?: SettlementOrderStatus;
  readonly sourceDocType?: SettlementSourceDocType;
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
  ctx: SettlementOrderContext,
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
  action: 'read' | 'approve',
): void {
  if (!allowsScope(principal.scope, 'settlement', action)) {
    throw new AppError('FORBIDDEN', `缺少 settlement.${action} 权限`);
  }
}

/**
 * 结算确认是危险审批动作（D52① / D52.1）。
 * 路由 preHandler 会先对 AI 写请求执行 X-Reason 闸门；这里再兜底用例直调用，
 * 并在有 reason 时仍明确拒绝 AI 审批。
 */
function assertHumanConfirmation(
  request: FastifyRequest,
  principal: Principal,
): void {
  if (principal.actorType !== 'ai') return;
  if (!request.auditReason) {
    throw new AppError(
      'VALIDATION_FAILED',
      'AI 调用确认结算必须提供 X-Reason',
      { header: 'X-Reason' },
    );
  }
  throw new AppError(
    'AI_ACTION_FORBIDDEN',
    'AI 不得确认结算，必须由人类审批',
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
  const parsed = SettlementOrderListQuerySchema.safeParse(request.query);
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
    sourceDocType: parsed.data.sourceDocType,
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
    action: 'settlement.order.confirm',
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

function detailOf(order: SettlementOrder): SettlementOrderDetail {
  return {
    ...order,
    confirmable: settlementConfirmable(order.status),
  };
}

/** C 结算单列表（普通读，不记审计）。 */
export async function listSettlementOrders(
  ctx: SettlementOrderContext,
): Promise<{ items: SettlementOrder[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'settlement.order.list.read');
  requireScope(principal, 'read');
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listSettlementOrders(repoContext(tx, principal), query),
  );
}

/** C 结算单详情（普通读，不记审计）；内嵌 confirmable。 */
export async function getSettlementOrder(
  ctx: SettlementOrderContext,
): Promise<SettlementOrderDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'settlement.order.detail.read');
  requireScope(principal, 'read');
  const id = parseOrderId(ctx.request);

  const order = await withTenant(database, principal.tenantId, (tx) =>
    repo.getSettlementOrder(repoContext(tx, principal), id),
  );
  if (!order) throw new AppError('NOT_FOUND', '结算单不存在');
  return detailOf(order);
}

/**
 * 确认结算：人类审批 + settlement.approve + If-Match。
 * 成功同事务冻结相关损失快照、写审计并返回新 ETag。
 */
export async function confirmSettlementOrder(
  ctx: SettlementOrderWriteContext,
): Promise<SettlementOrderDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'settlement.order.confirm');
  requireScope(principal, 'approve');
  assertHumanConfirmation(ctx.request, principal);

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const state = await withTenant(database, principal.tenantId, (tx) =>
    repo.loadSettlementOrderState(repoContext(tx, principal), id),
  );
  if (!state) throw new AppError('NOT_FOUND', '结算单不存在');
  if (state.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '结算单版本与 If-Match 不一致，请重新读取后重试',
      { expected: expectedVersion, current: state.version },
    );
  }
  if (state.status === '已结算') {
    throw new AppError(
      'VALIDATION_FAILED',
      '结算单已结算；一期一单只能结算一次（D19）',
      { status: state.status },
    );
  }

  const audit = auditEventOf(ctx.request, principal, id, {
    beforeStatus: state.status,
    afterStatus: '已结算',
  });
  audit.companyId = state.companyId;

  const order = await withAudit(database, audit, async (tx) => {
    const confirmed = await repo.confirmSettlementOrder(
      repoContext(tx, principal),
      id,
      expectedVersion,
    );
    if (!confirmed) {
      throw new AppError(
        'VERSION_CONFLICT',
        '结算单已被并发修改，请重新读取后重试',
      );
    }
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: confirmed.status,
      version: confirmed.version,
      relatedLossAmount: confirmed.relatedLossAmount,
      netProfit: confirmed.netProfit,
      commissionRateSnapshot: confirmed.commissionRateSnapshot,
      commissionAmount: confirmed.commissionAmount,
    };
    return confirmed;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return detailOf(order);
}
