import {
  AppError,
  InternalTradeOrderCreateInputSchema,
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
import {
  settlementDraftPort,
  stockFlowPort,
} from '../../../platform/services/registry.js';
import * as repo from '../repo.js';

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

/** 六个小数位的定点整数（D54 `numeric(18,6)`）：数量均分不出现浮点。 */
const SCALE = 1_000_000n;

function toMicro(value: string): bigint {
  const negative = value.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? value.slice(1) : value).split('.');
  const frac = `${fracPart}000000`.slice(0, 6);
  const micro = BigInt(intPart ?? '0') * SCALE + BigInt(frac);
  return negative ? -micro : micro;
}

function fromMicro(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const intPart = abs / SCALE;
  const fracPart = (abs % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  const body = fracPart === '' ? `${intPart}` : `${intPart}.${fracPart}`;
  return negative ? `-${body}` : body;
}

/**
 * 把一行的数量按所引用批次均分，除不尽的余量由**最后一个批次**承接（与 D72 同规则）。
 *
 * 契约里 `internal_trade_order_line_batch` 只有引用关系、没有每批分配量（0015），
 * 所以「每批锁多少」只能由这条确定性规则推导；为 0 的批次直接跳过，不写空占用。
 */
function distributeQty(
  qty: string,
  batchIds: readonly string[],
): { readonly batchId: string; readonly qty: string }[] {
  const total = toMicro(qty);
  const count = BigInt(batchIds.length);
  const base = total / count;
  const remainder = total - base * count;
  const shares: { batchId: string; qty: string }[] = [];
  batchIds.forEach((batchId, index) => {
    const share = index === batchIds.length - 1 ? base + remainder : base;
    if (share === 0n) return;
    shares.push({ batchId, qty: fromMicro(share) });
  });
  return shares;
}

/** 内部交易单列表（普通读，不记审计）。 */
export async function listInternalTradeOrders(
  ctx: InternalTradeOrderContext,
): Promise<{ items: InternalTradeOrder[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.list.read');
  requireScope(principal, 'read');
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listInternalTradeOrders(repoContext(tx, principal), query),
  );
}

/** 内部交易单详情（普通读，不记审计）；内嵌四态取消判定。 */
export async function getInternalTradeOrder(
  ctx: InternalTradeOrderContext,
): Promise<InternalTradeOrderDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.detail.read');
  requireScope(principal, 'read');
  const id = parseOrderId(ctx.request);

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
  return detail;
}

/** 开内部交易单：201 + 同事务取 N 号 / 审计（D16 / D51）。 */
export async function createInternalTradeOrder(
  ctx: InternalTradeOrderWriteContext,
): Promise<InternalTradeOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.create');
  requireScope(principal, 'create');
  assertHumanCredential(principal, '开内部交易单');

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
  return order;
}

/** 修改内部交易单：If-Match 强 ETag；仅「进行中」可改；成功后回新 ETag。 */
export async function updateInternalTradeOrder(
  ctx: InternalTradeOrderWriteContext,
): Promise<InternalTradeOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.update');
  requireScope(principal, 'update');

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
  return order;
}

/**
 * 发货（D68③ / D73）：`进行中` → `在途`，同时锁定批次的在途占用。
 *
 * - 权限 `internal_trade.update`（不新增动作词，D4 封闭枚举）；危险动作 → AI 禁止且必须给原因（D52①）；
 * - 只有**发出公司**的调用者可发货（D15 / D22）：接收方等「确认到货」；
 * - 按行把数量均分到所引用批次（末批承余，与 D72 同规则），逐批调 D70 的
 *   `StockFlowPort.reserveInTransit` 锁 `in_transit_qty`；**不改入库量、不写库存流水**——
 *   在途占用不是库存变动（D31 / D67）；
 * - 批次 `company_id` 不变，仍归发出公司（D68③）；转司要等确认到货端点；
 * - 单头 `in_transit_qty` = Σ 行数量；可用量不足 → 409 整单回滚。
 */
export async function shipInternalTradeOrder(
  ctx: InternalTradeOrderWriteContext,
): Promise<InternalTradeOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.ship');
  requireScope(principal, 'update');
  assertHumanCredential(principal, '发货内部交易单');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const audit = auditEventOf(
    ctx.request,
    principal,
    'internal_trade.order.ship',
    id,
    {
      beforeStatus: '进行中',
      afterStatus: '在途',
    },
  );

  const order = await withAudit(database, audit, async (tx) => {
    const context = repoContext(tx, principal);
    const current = await repo.getInternalTradeOrder(context, id);
    if (!current) throw new AppError('NOT_FOUND', '内部交易单不存在');
    // 先判版本再判状态：并发下 If-Match 不匹配优先报 409，避免把「别人刚发过货」误报成 422。
    if (current.version !== expectedVersion) {
      throw new AppError(
        'VERSION_CONFLICT',
        '内部交易单版本与 If-Match 不一致，请重新读取后重试',
        { expected: expectedVersion, current: current.version },
      );
    }
    if (current.status !== '进行中') {
      throw new AppError(
        'VALIDATION_FAILED',
        '只有「进行中」的内部交易单可发货，在途 / 已完成 / 已取消不可重复发货',
        { status: current.status },
      );
    }
    if (!principal.companyIds.includes(current.fromCompanyId)) {
      throw new AppError(
        'FORBIDDEN',
        '只有发出公司可以发货，接收方不能代发（D15 / D22）',
        { fromCompanyId: current.fromCompanyId },
      );
    }

    let totalMicro = 0n;
    const reservations: { readonly batchId: string; readonly qty: string }[] = [];
    for (const [index, line] of current.lines.entries()) {
      if (line.batchIds.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `第 ${index + 1} 行没有引用批次，无法发货（D22）`,
          { lineNo: index + 1 },
        );
      }
      totalMicro += toMicro(line.qty);
      reservations.push(...distributeQty(line.qty, line.batchIds));
    }

    for (const reservation of reservations) {
      await stockFlowPort().reserveInTransit(tx, {
        tenantId: principal.tenantId,
        companyId: current.fromCompanyId,
        batchId: reservation.batchId,
        delta: reservation.qty,
        sourceDocType: 'internal_trade_order',
        sourceDocId: id,
        handledBy: principal.employeeId,
      });
    }

    const shipped = await repo.shipInternalTradeOrder(
      context,
      id,
      expectedVersion,
      fromMicro(totalMicro),
    );
    if (!shipped) throw new AppError('NOT_FOUND', '内部交易单不存在');

    audit.companyId = shipped.fromCompanyId;
    audit.changeSummary = {
      beforeStatus: '进行中',
      afterStatus: shipped.status,
      version: shipped.version,
      inTransitQty: shipped.inTransitQty,
      reservedBatchCount: new Set(reservations.map((item) => item.batchId)).size,
    };
    return shipped;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return order;
}

/**
 * 到货确认 / 转司（D22 / D31 / D29 / D74 / D75）：`在途` → `已完成`。
 *
 * - 权限 `internal_trade.update`（不新增动作词，D4）；危险动作 → AI 禁止且必须给原因；
 * - **只有接收公司**的调用者可确认（D22「收货方确认到货」）：发出方不能替收货方确认，
 *   否则发货 + 确认都在一方手上，D15/D22 的隔离形同虚设；
 * - 同一事务里三件事（D74 ④）：
 *   ① 按 D73 的同样份数**释放在途占用**；② 批次 `company_id` 转成接收公司（D31 转司）；
 *   ③ 单头改「已完成」且在途量归零；
 * - **不写库存流水**：转司不改变数量（`inventory_flow` 只记量的变化，D47），只写审计；
 * - 同事务生成 **C 单草稿**（D29）：总售价 = Σ 行金额（`qty × unit_price`，D75 ①）、
 *   总成本 = Σ(释放量 × 批次锁价 `lockedUnitCost`，D75 ②)、C 单归属**发出公司**（D75 ③）、
 *   `relatedLossAmount` 与提成记 `0`（D74 ⑧⑨ / D5④）。
 */
export async function receiveInternalTradeOrder(
  ctx: InternalTradeOrderWriteContext,
): Promise<InternalTradeOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'internal_trade.order.receive');
  requireScope(principal, 'update');
  assertHumanCredential(principal, '确认内部交易到货（会改批次归属公司）');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const audit = auditEventOf(
    ctx.request,
    principal,
    'internal_trade.order.receive',
    id,
    {
      beforeStatus: '在途',
      afterStatus: '已完成',
    },
  );

  const order = await withAudit(database, audit, async (tx) => {
    const context = repoContext(tx, principal);
    const current = await repo.getInternalTradeOrder(context, id);
    if (!current) throw new AppError('NOT_FOUND', '内部交易单不存在');
    if (current.version !== expectedVersion) {
      throw new AppError(
        'VERSION_CONFLICT',
        '内部交易单版本与 If-Match 不一致，请重新读取后重试',
        { expected: expectedVersion, current: current.version },
      );
    }
    if (current.status !== '在途') {
      throw new AppError(
        'VALIDATION_FAILED',
        '只有「在途」的内部交易单可确认到货，进行中 / 已完成 / 已取消不可确认',
        { status: current.status },
      );
    }
    if (!principal.companyIds.includes(current.toCompanyId)) {
      throw new AppError(
        'FORBIDDEN',
        '只有接收公司可以确认到货，发出方不能替收货方确认（D22）',
        { toCompanyId: current.toCompanyId },
      );
    }

    let totalSaleMicro = 0n;
    let totalCostMicro = 0n;
    const transfers: { readonly batchId: string; readonly qty: string }[] = [];
    for (const [index, line] of current.lines.entries()) {
      if (line.batchIds.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `第 ${index + 1} 行没有引用批次，无法确认到货（D22）`,
          { lineNo: index + 1 },
        );
      }
      totalSaleMicro += toMicro(line.amount);
      transfers.push(...distributeQty(line.qty, line.batchIds));
    }

    for (const transfer of transfers) {
      const receipt = await stockFlowPort().transferOwnership(tx, {
        tenantId: principal.tenantId,
        companyId: current.fromCompanyId,
        toCompanyId: current.toCompanyId,
        batchId: transfer.batchId,
        delta: transfer.qty,
        sourceDocType: 'internal_trade_order',
        sourceDocId: id,
        handledBy: principal.employeeId,
      });
      totalCostMicro += (toMicro(transfer.qty) * toMicro(receipt.lockedUnitCost)) / SCALE;
    }

    const totalSaleAmount = fromMicro(totalSaleMicro);
    const totalCostAmount = fromMicro(totalCostMicro);

    const draft = await settlementDraftPort().createDraft(tx, {
      tenantId: principal.tenantId,
      companyId: current.fromCompanyId,
      sourceDocType: 'N',
      sourceDocId: id,
      totalSaleAmount,
      totalCostAmount,
      relatedLossAmount: '0',
      commissionRateSnapshot: '0',
      commissionAmount: '0',
      createdBy: principal.employeeId,
      requestId: requestIdFor(ctx.request),
    });

    const received = await repo.receiveInternalTradeOrder(context, id, expectedVersion);
    if (!received) throw new AppError('NOT_FOUND', '内部交易单不存在');

    audit.companyId = received.fromCompanyId;
    audit.changeSummary = {
      beforeStatus: '在途',
      afterStatus: received.status,
      version: received.version,
      transferredBatchCount: new Set(transfers.map((item) => item.batchId)).size,
      fromCompanyId: received.fromCompanyId,
      toCompanyId: received.toCompanyId,
      settlementOrderId: draft.id,
      settlementOrderNo: draft.orderNo,
      totalSaleAmount,
      totalCostAmount,
      commissionRateSnapshot: '0',
      relatedLossAmount: '0',
      placeholders: ['relatedLossAmount', 'commissionRateSnapshot'],
    };
    return received;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return order;
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
    const context = repoContext(tx, principal);

    // D68③ / D73：在途单取消必须释放已锁定的在途占用，否则批次可用量会被永久锁死。
    // 释放与取消同事务；释放是按行的均分份数原路退回，不看调用者属于哪一方（取消权不分收发方）。
    let releasedBatchCount = 0;
    if (state.status === '在途') {
      const current = await repo.getInternalTradeOrder(context, id);
      if (!current) throw new AppError('NOT_FOUND', '内部交易单不存在');
      for (const line of current.lines) {
        for (const share of distributeQty(line.qty, line.batchIds)) {
          await stockFlowPort().reserveInTransit(tx, {
            tenantId: principal.tenantId,
            companyId: current.fromCompanyId,
            batchId: share.batchId,
            delta: fromMicro(-toMicro(share.qty)),
            sourceDocType: 'internal_trade_order',
            sourceDocId: id,
            handledBy: principal.employeeId,
          });
          releasedBatchCount += 1;
        }
      }
    }

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
      releasedBatchCount,
    };
    return cancelled;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  return order;
}
