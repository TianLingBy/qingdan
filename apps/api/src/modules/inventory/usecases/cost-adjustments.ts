import {
  AppError,
  CostAdjustmentCreateInputSchema,
  CostAdjustmentListQuerySchema,
  CostAdjustmentRejectInputSchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  type CostAdjustmentReferenceSnapshot,
  type CostAdjustmentTier,
  type CursorPayload,
  type InventoryCostAdjustment,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { downstreamReferencePort } from '../../../platform/services/registry.js';
import type { InventoryRepoContext } from '../repo.js';
import * as repo from '../repo-cost-adjustments.js';

/**
 * 批次成本更正用例（Issue #163 / #100）。
 *
 * 业务口径（负责人已拍板，别在这里重新判）：
 * - **只改成本、不改数量**：全过程不写 `inventory_flow.delta`，只更新
 *   `inventory_batch.locked_unit_cost` 并追加 `inventory_cost_adjustment`；
 * - **分档全自动**：
 *   T1 无下游引用且未结算 → 同一事务直接生效（status='applied'）；
 *   T2 已被下游引用但未结算 → 落 `pending_approval`，走 `inventory_qty.approve`；
 *   T3 已进入结算 → 不落库，422 `VALIDATION_FAILED` + `details.reason='COST_ADJUSTMENT_LOCKED'`；
 * - **下游引用只经端口**（D70）：processing / sales / settlement 各自实现，
 *   inventory 不直读别人的表；
 * - **金额脱敏**（D27 / D50）：无 `inventory_qty.view_price` 时
 *   before / after / delta 三个金额字段置 `null`（不 403、不返回 0）；
 * - 提交 / 审批 / 驳回与业务同事务写审计（D51）；列表是普通读，不记审计（D54 ②）；
 * - AI 不得发起或审批（D52① / D54 ⑥），审批还要求人类 + 强 If-Match（D60③ 同款）。
 */

const OBJECT_TYPE = 'cost_adjustment';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** T3 一键退货入口：只给已有单据端口，不凭空造端点。 */
const RETURN_ENTRY = {
  operationId: 'customer_return.create',
  method: 'POST',
  path: '/api/v1/customer-returns',
} as const;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface CostAdjustmentContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface CostAdjustmentWriteContext extends CostAdjustmentContext {
  readonly reply: FastifyReply;
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

function requireDatabase(ctx: CostAdjustmentContext, operationId: string): Database {
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
  action: 'read' | 'update' | 'approve',
): void {
  if (!allowsScope(principal.scope, 'inventory_qty', action)) {
    throw new AppError('FORBIDDEN', `缺少 inventory_qty.${action} 权限`);
  }
}

function canViewPrice(principal: Principal): boolean {
  return allowsScope(principal.scope, 'inventory_qty', 'view_price');
}

/** 契约 inventory.cost.adjustment.create 为 ai.policy=forbid（D52①）。 */
function assertHumanCreation(principal: Principal): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得发起成本更正，需人类操作');
  }
}

/** 契约 approve / reject 为 ai.policy=forbid + reasonRequired：AI 一律拒绝，缺原因先报 422。 */
function assertHumanApproval(request: FastifyRequest, principal: Principal): void {
  if (principal.actorType !== 'ai') return;
  if (!request.auditReason) {
    throw new AppError('VALIDATION_FAILED', 'AI 调用成本更正审批必须提供 X-Reason', {
      header: 'X-Reason',
    });
  }
  throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得审批成本更正，必须由人类审批');
}

function issuesOf(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseBatchId(request: FastifyRequest): string {
  const params = request.params as { batchId?: unknown };
  const id = typeof params.batchId === 'string' ? params.batchId : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'batchId 必须是合法 uuid', {
      field: 'batchId',
    });
  }
  return id;
}

function parseAdjustmentId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id' });
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

function repoContext(tx: SqlClient, principal: Principal): InventoryRepoContext {
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

/** 无看价权限时三个金额字段置 null；记录仍可见（D27 / D50）。 */
function maskAmounts(
  adjustment: InventoryCostAdjustment,
  principal: Principal,
): InventoryCostAdjustment {
  if (canViewPrice(principal)) return adjustment;
  return {
    ...adjustment,
    beforeUnitCost: null,
    afterUnitCost: null,
    deltaAmount: null,
  };
}

function lockedError(snapshot: CostAdjustmentReferenceSnapshot): AppError {
  return new AppError(
    'STATE_CONFLICT',
    '该批次已进入结算，成本已锁定，不能更正；如需退货请走退货单据',
    {
      reason: 'COST_ADJUSTMENT_LOCKED',
      tier: 'T3',
      settled: snapshot.settled,
      references: snapshot.references,
      returnEntry: RETURN_ENTRY,
    },
  );
}

interface ParsedListQuery {
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

function parseListQuery(request: FastifyRequest): ParsedListQuery {
  const parsed = CostAdjustmentListQuerySchema.safeParse(request.query);
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
  return { cursor, limit: clampLimit(parsed.data.limit) };
}

function tierOf(referenced: boolean, settled: boolean): CostAdjustmentTier {
  if (settled) return 'T3';
  if (referenced) return 'T2';
  return 'T1';
}

/**
 * 提交成本更正：服务端自动判档。
 *
 * 批次的 `FOR UPDATE` 行锁、引用判定、插入更正单、T1 改批次成本
 * 全在**同一个事务**里，避免并发提交时把差额算在过期成本上。
 */
export async function createCostAdjustment(
  ctx: CostAdjustmentWriteContext,
): Promise<InventoryCostAdjustment> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'inventory.cost.adjustment.create');
  requireScope(principal, 'update');
  assertHumanCreation(principal);

  const batchId = parseBatchId(ctx.request);
  const parsed = CostAdjustmentCreateInputSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  const input = parsed.data;

  const id = uuidv7();
  const audit = auditEventOf(ctx.request, principal, 'inventory.cost.adjustment.create', id, {
    batchId,
    afterUnitCost: input.afterUnitCost,
    reason: input.reason,
  });

  const created = await withAudit(database, audit, async (tx) => {
    const rc = repoContext(tx, principal);

    // 1) 锁批次：拿当前锁定成本与入库量，并做公司可见性校验。
    const batch = await repo.loadBatchForCostAdjustment(rc, batchId);
    if (!batch) {
      throw new AppError('NOT_FOUND', '批次不存在或不属于可见公司', { batchId });
    }
    if (batch.lockedUnitCost === null) {
      throw new AppError('VALIDATION_FAILED', '批次尚未锁定成本，不能更正', {
        field: 'batchId',
        batchId,
      });
    }

    // 2) 只经端口判定下游引用/结算事实（D70），不直读 processing/sales/settlement 表。
    const facts = await downstreamReferencePort().inspectBatch(tx, {
      tenantId: principal.tenantId,
      companyId: batch.companyId,
      batchId,
    });
    const snapshot: CostAdjustmentReferenceSnapshot = {
      referenced: facts.referenced,
      settled: facts.settled,
      references: [...facts.references],
    };
    const tier = tierOf(facts.referenced, facts.settled);

    // 3) T3 直接拒绝：不落更正单，错误体带一键退货入口。
    if (tier === 'T3') throw lockedError(snapshot);

    // 4) T1 直接生效，T2 待审批。
    const status = tier === 'T1' ? 'applied' : 'pending_approval';
    const adjustment = await repo.insertCostAdjustment(rc, {
      id,
      tenantId: principal.tenantId,
      companyId: batch.companyId,
      batchId,
      tier,
      beforeUnitCost: batch.lockedUnitCost,
      afterUnitCost: input.afterUnitCost,
      reason: input.reason,
      status,
      requestedBy: principal.employeeId,
      referenceSnapshot: snapshot,
      requestId: requestIdFor(ctx.request),
      appliedAt: status === 'applied' ? new Date() : null,
    });

    if (status === 'applied') {
      const updated = await repo.updateBatchLockedUnitCost(rc, {
        batchId,
        companyId: batch.companyId,
        unitCost: input.afterUnitCost,
      });
      if (!updated) {
        throw new AppError('INTERNAL_ERROR', '成本更正生效后批次更新失败', { batchId });
      }
    }

    audit.companyId = batch.companyId;
    audit.changeSummary = {
      batchId,
      tier,
      beforeUnitCost: adjustment.beforeUnitCost,
      afterUnitCost: adjustment.afterUnitCost,
      deltaAmount: adjustment.deltaAmount,
      status: adjustment.status,
      referenced: snapshot.referenced,
      settled: snapshot.settled,
      referenceCount: snapshot.references.length,
      reason: input.reason,
    };
    return adjustment;
  });

  ctx.reply.status(201);
  return maskAmounts(created, principal);
}

/** 按批次列成本更正历史（普通读，不记审计；金额按看价权限脱敏）。 */
export async function listCostAdjustments(
  ctx: CostAdjustmentContext,
): Promise<{ items: InventoryCostAdjustment[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'inventory.cost.adjustment.history.read');
  requireScope(principal, 'read');
  const batchId = parseBatchId(ctx.request);
  const query = parseListQuery(ctx.request);

  const page = await withTenant(database, principal.tenantId, (tx) =>
    repo.listCostAdjustments(repoContext(tx, principal), {
      batchId,
      cursor: query.cursor,
      limit: query.limit,
    }),
  );

  return {
    items: page.items.map((item) => maskAmounts(item, principal)),
    nextCursor: page.nextCursor,
  };
}

/**
 * 审批通过 T2：人类 + `inventory_qty.approve` + 强 If-Match。
 *
 * 审批时**复查**下游结算事实：等待期间若已进入结算，则按 T3 拒绝，
 * 绝不把已经锁定的成本改掉。通过后同事务改批次锁定成本（不动数量）。
 */
export async function approveCostAdjustment(
  ctx: CostAdjustmentWriteContext,
): Promise<InventoryCostAdjustment> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'inventory.cost.adjustment.approve');
  requireScope(principal, 'approve');
  assertHumanApproval(ctx.request, principal);

  const id = parseAdjustmentId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const state = await withTenant(database, principal.tenantId, (tx) =>
    repo.loadCostAdjustmentState(repoContext(tx, principal), id),
  );
  if (!state) throw new AppError('NOT_FOUND', '成本更正不存在');
  if (state.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '成本更正版本与 If-Match 不一致，请重新读取后重试',
      { expected: expectedVersion, current: state.version },
    );
  }
  if (state.status !== 'pending_approval') {
    throw new AppError('VERSION_CONFLICT', `成本更正当前状态「${state.status}」不可审批`, {
      reason: 'NOT_PENDING_APPROVAL',
      status: state.status,
    });
  }

  const audit = auditEventOf(ctx.request, principal, 'inventory.cost.adjustment.approve', id, {
    beforeStatus: state.status,
    afterStatus: 'applied',
    batchId: state.batchId,
  });
  audit.companyId = state.companyId;

  const approved = await withAudit(database, audit, async (tx) => {
    const rc = repoContext(tx, principal);
    const current = await repo.getCostAdjustment(rc, id);
    if (!current || current.afterUnitCost === null) {
      throw new AppError('INTERNAL_ERROR', '成本更正审批前读取失败', { id });
    }

    // 复查：等待审批期间可能已进入结算 → 按 T3 拒绝。
    const facts = await downstreamReferencePort().inspectBatch(tx, {
      tenantId: principal.tenantId,
      companyId: state.companyId,
      batchId: state.batchId,
    });
    const snapshot: CostAdjustmentReferenceSnapshot = {
      referenced: facts.referenced,
      settled: facts.settled,
      references: [...facts.references],
    };
    if (facts.settled) throw lockedError(snapshot);

    const decided = await repo.updateCostAdjustmentDecision(rc, {
      id,
      expectedVersion,
      status: 'applied',
      approvedBy: principal.employeeId,
    });
    if (!decided) {
      throw new AppError('VERSION_CONFLICT', '成本更正已被并发处理，请重新读取后重试');
    }

    const updatedBatch = await repo.updateBatchLockedUnitCost(rc, {
      batchId: state.batchId,
      companyId: state.companyId,
      unitCost: current.afterUnitCost,
    });
    if (!updatedBatch) {
      throw new AppError('INTERNAL_ERROR', '成本更正审批后批次更新失败', {
        batchId: state.batchId,
      });
    }

    const updated = await repo.getCostAdjustment(rc, id);
    if (!updated) {
      throw new AppError('INTERNAL_ERROR', '成本更正审批后读取失败', { id });
    }
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: updated.status,
      version: updated.version,
      approverId: updated.approvedBy,
      batchId: state.batchId,
      beforeUnitCost: updated.beforeUnitCost,
      afterUnitCost: updated.afterUnitCost,
      deltaAmount: updated.deltaAmount,
      tier: updated.tier,
      settledRecheck: snapshot.settled,
    };
    return updated;
  });

  return maskAmounts(approved, principal);
}

/** 驳回 T2：同审批权限与强 If-Match；不改批次成本，只把状态置 rejected。 */
export async function rejectCostAdjustment(
  ctx: CostAdjustmentWriteContext,
): Promise<InventoryCostAdjustment> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'inventory.cost.adjustment.reject');
  requireScope(principal, 'approve');
  assertHumanApproval(ctx.request, principal);

  const id = parseAdjustmentId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const parsed = CostAdjustmentRejectInputSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', {
      issues: issuesOf(parsed.error),
    });
  }

  const state = await withTenant(database, principal.tenantId, (tx) =>
    repo.loadCostAdjustmentState(repoContext(tx, principal), id),
  );
  if (!state) throw new AppError('NOT_FOUND', '成本更正不存在');
  if (state.version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      '成本更正版本与 If-Match 不一致，请重新读取后重试',
      { expected: expectedVersion, current: state.version },
    );
  }
  if (state.status !== 'pending_approval') {
    throw new AppError('VERSION_CONFLICT', `成本更正当前状态「${state.status}」不可驳回`, {
      reason: 'NOT_PENDING_APPROVAL',
      status: state.status,
    });
  }

  const audit = auditEventOf(ctx.request, principal, 'inventory.cost.adjustment.reject', id, {
    beforeStatus: state.status,
    afterStatus: 'rejected',
    batchId: state.batchId,
    rejectReason: parsed.data.reason,
  });
  audit.companyId = state.companyId;

  const rejected = await withAudit(database, audit, async (tx) => {
    const rc = repoContext(tx, principal);
    const decided = await repo.updateCostAdjustmentDecision(rc, {
      id,
      expectedVersion,
      status: 'rejected',
      approvedBy: principal.employeeId,
    });
    if (!decided) {
      throw new AppError('VERSION_CONFLICT', '成本更正已被并发处理，请重新读取后重试');
    }
    const updated = await repo.getCostAdjustment(rc, id);
    if (!updated) {
      throw new AppError('INTERNAL_ERROR', '成本更正驳回后读取失败', { id });
    }
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: updated.status,
      version: updated.version,
      approverId: updated.approvedBy,
      batchId: state.batchId,
      rejectReason: parsed.data.reason,
    };
    return updated;
  });

  return maskAmounts(rejected, principal);
}
