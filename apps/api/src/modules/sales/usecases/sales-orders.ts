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
  type PrintDocument,
  type SalesOrder,
  type SalesOrderCreateInput,
  type SalesOrderDetail,
  type SalesOrderStatus,
  type SalesOrderUpdateInput,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { recordAmountDetailRead } from '../../../platform/audit/sensitive-read.js';
import { recordAudit, withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
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
import {
  maskSalesOrderAmounts,
  maskSalesOrderDetailAmounts,
} from '../services/masking.js';

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
  action: 'read' | 'create' | 'update' | 'delete' | 'export',
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

  const canViewPrice = allowsScope(principal.scope, 'sales', 'view_price');
  const page = await withTenant(database, principal.tenantId, (tx) =>
    repo.listSalesOrders(repoContext(tx, principal), query),
  );
  return {
    items: page.items.map((order) => maskSalesOrderAmounts(order, canViewPrice)),
    nextCursor: page.nextCursor,
  };
}

/** 导出上限：超过直接 400，避免一次查询把进程内存打满（D54 ② 未规定上限）。 */
const EXPORT_MAX_ROWS = 5000;

/** UTF-8 BOM（U+FEFF）：让 Excel 按 UTF-8 识别中文。 */
const UTF8_BOM = String.fromCharCode(0xfeff);

/** RFC4180：含逗号 / 引号 / CRLF 的字段用双引号包裹，内部引号双写。 */
function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvLine(fields: readonly string[]): string {
  return fields.map(escapeCsvField).join(',');
}

/** 金额统一两位小数（四舍五入），用定点整数避免浮点误差。 */
function formatAmount2(value: string): string {
  const micro = toMicro(value);
  const cents = micro >= 0n ? (micro + 5_000n) / 10_000n : (micro - 5_000n) / 10_000n;
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n)
    .toString()
    .padStart(2, '0')}`;
}

function sumQty(lines: readonly { readonly qty: string }[]): string {
  return fromMicro(lines.reduce((total, line) => total + toMicro(line.qty), 0n));
}

function exportDateStamp(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}${month}${day}`;
}

/**
 * 销售单列表导出 CSV（`sales.order.export`，敏感读，D54 ②）。
 *
 * - 权限：`sales.export`；数据范围仍走列表同款租户 + 可见公司过滤；
 * - 不分页：一次取全部符合条件行，超过 5000 行报 400（不静默截断）；
 * - 金额按 `sales.view_price` 脱敏：无权限时金额列留空，并加一行 CSV 注释说明；
 * - 成功必记 `action='export'` 审计；失败由 route-mount 统一补 fail 审计。
 */
export async function exportSalesOrders(
  ctx: SalesOrderContext,
): Promise<PrintDocument> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.export');
  requireScope(principal, 'export');
  const query = parseListQuery(ctx.request);
  const canViewPrice = allowsScope(principal.scope, 'sales', 'view_price');

  const page = await withTenant(database, principal.tenantId, (tx) =>
    repo.listSalesOrders(repoContext(tx, principal), {
      companyId: query.companyId,
      customerId: query.customerId,
      status: query.status,
      keyword: query.keyword,
      limit: EXPORT_MAX_ROWS,
    }),
  );
  if (page.nextCursor !== null) {
    throw new AppError(
      'VALIDATION_FAILED',
      `导出结果超过 ${EXPORT_MAX_ROWS} 行，请缩小筛选条件`,
      { limit: EXPORT_MAX_ROWS },
    );
  }

  const rows = page.items.map((order) => [
    order.orderNo,
    order.createdAt.slice(0, 10),
    order.customerName,
    order.status,
    order.handlerId,
    sumQty(order.lines),
    canViewPrice && order.totalAmount !== null
      ? formatAmount2(order.totalAmount)
      : '',
  ]);
  const body: string[] = [];
  if (!canViewPrice) body.push('# 当前账号无看价权限，金额列已留空');
  body.push(
    csvLine(['单号', '日期', '客户', '状态', '经办人', '数量合计', '金额合计']),
    ...rows.map(csvLine),
  );
  // RFC4180 使用 CRLF。
  const content = UTF8_BOM + body.join('\r\n') + '\r\n';

  const audit = auditEventOf(ctx.request, principal, 'export', null, {
    operationId: 'sales.order.export',
    companyId: query.companyId ?? null,
    customerId: query.customerId ?? null,
    status: query.status ?? null,
    keyword: query.keyword ?? null,
    rowCount: rows.length,
    canViewPrice,
  });
  audit.companyId = query.companyId ?? null;
  await recordAudit(database, audit);

  return {
    contentType: 'text/csv',
    content,
    filename: `销售单-${exportDateStamp(new Date())}.csv`,
  };
}

/** 详情装配：单头 + 行 + 费用 + 空收款块 + 取消判定（详情与打印共用）。 */
async function loadSalesOrderDetail(
  tx: SqlClient,
  principal: Principal,
  id: string,
): Promise<SalesOrderDetail | null> {
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
}

/** 销售单详情（普通读，不记审计）；本批收款块为空占位。 */
export async function getSalesOrder(
  ctx: SalesOrderContext,
): Promise<SalesOrderDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.detail.read');
  requireScope(principal, 'read');
  const id = parseOrderId(ctx.request);

  const detail = await withTenant(database, principal.tenantId, (tx) =>
    loadSalesOrderDetail(tx, principal, id),
  );
  if (!detail) throw new AppError('NOT_FOUND', '销售单不存在');
  const canViewPrice = allowsScope(principal.scope, 'sales', 'view_price');
  await recordAmountDetailRead(database, {
    request: ctx.request,
    principal,
    domain: 'sales',
    operationId: 'sales.order.detail.read',
    objectType: OBJECT_TYPE,
    objectId: detail.id,
    companyId: detail.companyId,
  });
  return maskSalesOrderDetailAmounts(detail, canViewPrice);
}

export interface SalesOrderPrintSource {
  /** 已按看价权限脱敏的详情（无权限时金额为 null）。 */
  readonly detail: SalesOrderDetail;
  readonly companyName: string;
}

/**
 * 打印取数（prints.ts：单张打印按普通读处理，不记 `amount.detail`）。
 *
 * 与详情端点共用装配与公司可见性逻辑；金额仍按 `sales.view_price` 脱敏，
 * 由渲染层把 null 显示为「—」。公司名暂无跨模块端口，只读 `company.name`。
 */
export async function getSalesOrderForPrint(
  ctx: SalesOrderContext,
): Promise<SalesOrderPrintSource> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.print');
  requireScope(principal, 'read');
  const id = parseOrderId(ctx.request);

  const source = await withTenant(database, principal.tenantId, async (tx) => {
    const detail = await loadSalesOrderDetail(tx, principal, id);
    if (!detail) return null;
    const company = await tx.query<{ name: string }>(
      `SELECT name
         FROM company
        WHERE id = $1::uuid
          AND tenant_id = $2`,
      [detail.companyId, principal.tenantId],
    );
    // 销售单可见即公司必然存在；缺失时退回公司 id，避免打印 500。
    return {
      detail,
      companyName: company.rows[0]?.name ?? detail.companyId,
    };
  });
  if (!source) throw new AppError('NOT_FOUND', '销售单不存在');

  const canViewPrice = allowsScope(principal.scope, 'sales', 'view_price');
  return {
    detail: maskSalesOrderDetailAmounts(source.detail, canViewPrice),
    companyName: source.companyName,
  };
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
  // D79：写路径返回的真实金额同样按看价权限脱敏（脱敏只发生在响应上）。
  return maskSalesOrderAmounts(
    order,
    allowsScope(principal.scope, 'sales', 'view_price'),
  );
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
  // D79：写路径返回的真实金额同样按看价权限脱敏（脱敏只发生在响应上）。
  return maskSalesOrderAmounts(
    order,
    allowsScope(principal.scope, 'sales', 'view_price'),
  );
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
  // D79：写路径返回的真实金额同样按看价权限脱敏（脱敏只发生在响应上）。
  return maskSalesOrderAmounts(
    order,
    allowsScope(principal.scope, 'sales', 'view_price'),
  );
}

/** 六个小数位的定点整数（D54 `numeric(18,6)`）：避免浮点算数量。 */
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
 * 完成销售单（D72）：扣减批次可用量 + 生成 C 单草稿，同一事务。
 *
 * - 权限 `sales.update`；AI 默认禁止（会锁定库存与结算额）；
 * - 仅「进行中」可完成；If-Match 强 ETag；
 * - 库存扣减粒度：**按行全量扣减，批次间均分，除不尽的余量由最后一个批次承接**（D72）；
 * - C 草稿：总售价 = 单据总金额（含费用行），总成本 = Σ(行数量 × 行加权平均批次成本)；
 *   本单相关损失与提成比例本期取 `0`（D35 损失归集、D5④ 提成配置尚未落地，见 D72 ③④）。
 */
export async function completeSalesOrder(
  ctx: SalesOrderWriteContext,
): Promise<SalesOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.complete');
  requireScope(principal, 'update');
  assertHumanCredential(principal, '完成销售单（会锁定库存与结算额）');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const handledBy = principal.employeeId;

  const audit = auditEventOf(ctx.request, principal, 'sales.order.complete', id, {
    beforeStatus: '进行中',
    afterStatus: '已完成',
  });

  const order = await withAudit(database, audit, async (tx) => {
    const context = repoContext(tx, principal);
    const source = await repo.loadSalesOrderCompletionSource(context, id);
    if (!source) throw new AppError('NOT_FOUND', '销售单不存在');
    if (source.order.status !== '进行中') {
      throw new AppError(
        'VALIDATION_FAILED',
        '只有「进行中」的销售单可完成，已完成/已取消不可再次完成',
        { status: source.order.status },
      );
    }

    let totalCostMicro = 0n;
    const stockFlows: { batchId: string; delta: string }[] = [];
    for (const line of source.lines) {
      if (line.batchIds.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `第 ${line.lineNo} 行没有引用批次，无法完成（D22）`,
          { lineNo: line.lineNo },
        );
      }
      const qtyMicro = toMicro(line.qty);
      totalCostMicro += (qtyMicro * toMicro(line.costFloor)) / SCALE;

      const count = BigInt(line.batchIds.length);
      const base = qtyMicro / count;
      const remainder = qtyMicro - base * count;
      line.batchIds.forEach((batchId, index) => {
        const share = index === line.batchIds.length - 1 ? base + remainder : base;
        if (share === 0n) return;
        stockFlows.push({ batchId, delta: fromMicro(-share) });
      });
    }

    for (const flow of stockFlows) {
      await stockFlowPort().applyAdjustment(tx, {
        tenantId: principal.tenantId,
        companyId: source.order.companyId,
        batchId: flow.batchId,
        delta: flow.delta,
        sourceDocType: 'E',
        sourceDocId: id,
        handledBy,
      });
    }

    const draft = await settlementDraftPort().createDraft(tx, {
      tenantId: principal.tenantId,
      companyId: source.order.companyId,
      sourceDocType: 'E',
      sourceDocId: id,
      // 写路径读真实金额（脱敏只作用于响应，D79）；null 仅可能来自响应侧类型。
      totalSaleAmount: source.order.totalAmount ?? '0',
      totalCostAmount: fromMicro(totalCostMicro),
      relatedLossAmount: '0',
      commissionRateSnapshot: '0',
      commissionAmount: '0',
      // D77 ②：提成归属人 = 来源单负责人；比例在结算确认时按配置解析并快照。
      commissionOwnerId: source.order.handlerId,
      createdBy: handledBy,
      requestId: requestIdFor(ctx.request),
    });

    const completed = await repo.completeSalesOrder(context, id, expectedVersion);
    if (!completed) throw new AppError('NOT_FOUND', '销售单不存在');

    audit.companyId = completed.companyId;
    audit.changeSummary = {
      beforeStatus: '进行中',
      afterStatus: completed.status,
      version: completed.version,
      stockFlowCount: stockFlows.length,
      settlementOrderId: draft.id,
      settlementOrderNo: draft.orderNo,
      // 写路径读真实金额（脱敏只作用于响应，D79）；null 仅可能来自响应侧类型。
      totalSaleAmount: source.order.totalAmount ?? '0',
      totalCostAmount: fromMicro(totalCostMicro),
      commissionRateSnapshot: '0',
      relatedLossAmount: '0',
      commissionOwnerId: source.order.handlerId,
      placeholders: ['relatedLossAmount', 'commissionRateSnapshot'],
    };
    return completed;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  // D79：写路径返回的真实金额同样按看价权限脱敏（脱敏只发生在响应上）。
  return maskSalesOrderAmounts(
    order,
    allowsScope(principal.scope, 'sales', 'view_price'),
  );
}