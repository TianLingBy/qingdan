import {
  AppError,
  EXPORT_MAX_ROWS,
  SalesExportQuerySchema,
  SalesOrderCreateInputSchema,
  SalesOrderListQuerySchema,
  SalesOrderUpdateInputSchema,
  allowsScope,
  assertCancelable,
  assertNoPagingParams,
  canCancel,
  decodeCursor,
  etagOf,
  type CursorPayload,
  type SalesExportQuery,
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
import { toCsv } from '../../../platform/http/csv.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { takeDocumentNo } from '../../../platform/numbering/service.js';
import {
  batchDirectoryPort,
  productDirectoryPort,
  settlementDraftPort,
  sourceOrderStatusPort,
  stockFlowPort,
  type StockReservationLine,
  type StockReservationReceiptLine,
} from '../../../platform/services/registry.js';
import * as repo from '../repo.js';
import {
  assertIdOrDraft,
  resolveMasterdataDraft,
} from '../../masterdata/usecases/autocreate.js';
import type { SalesOrderPrintLabels } from '../services/customer-copy.js';
import {
  maskSalesOrderAmounts,
  maskSalesOrderDetailAmounts,
} from '../services/masking.js';

/**
 * 销售单 E 用例（D15 / D16 / D20 / D21 / D22 / D39 / D51 / D52 / D54 / D94）。
 *
 * - 权限：sales.read|create|update|ship|approve|delete；
 * - 公司隔离：读改删由 repo 带可见公司集合，跨公司等同不存在；
 * - 单号：创建时在业务事务内取 E 号；
 * - 金额：decimal 字符串；商品行金额与单头合计由 SQL 计算 / 聚合；
 * - 改价下限：repo 按行计算加权平均批次成本；低于下限时本批直接拒绝，
 *   不新增审批表或契约字段，待 platform 审批能力落地后由调用方重试；
 * - 审计：create / update / ship / complete / cancel 与业务同事务写；普通读不写；
 * - AI：开单、出库、签收和取消默认拒绝，修改允许；
 * - 取消：复用 assertCancelable（D21）；
 * - D94：出库（ship）到「已发货」，签收（complete，权限 approve）时按批次反查
 *   来源 A/B 单，未全部完成则 409 并指名；允许进行中直接签收（跳过在途）。
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
  readonly limit?: number;
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: 'orderNo' | 'totalAmount' | 'createdAt';
  readonly order?: 'asc' | 'desc';
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
  action: 'read' | 'create' | 'update' | 'ship' | 'approve' | 'delete' | 'export',
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

/** 契约里开单 / 取消 / 打印 / 导出均为 ai.policy=forbid；修改允许。 */
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
    // 不在这里 clamp：留 undefined 给 resolvePaging 区分「没传 limit」与「传了 limit」，
    // 前者是页码模式默认 20，后者是游标模式默认 50（老调用方行为）。
    limit: parsed.data.limit,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    sort: parsed.data.sort,
    order: parsed.data.order,
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

/**
 * 导出查询解析：用 `SalesExportQuerySchema`（列表 schema 去掉 cursor/limit）。
 * 刻意不复用 `parseListQuery`——它会兜底一个默认 limit，而导出根本不该有分页概念，
 * 复用等于给「导出其实会分页」留了个后门。
 */
function parseExportQuery(request: FastifyRequest): SalesExportQuery {
  const parsed = SalesExportQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

/** 强 ETag `"<version>"`；缺失 → 428，格式非法 → 409。 */
function parseIfMatchVersion(request: FastifyRequest): number {  const raw = headerValue(request, 'if-match');
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
export async function listSalesOrders(ctx: SalesOrderContext): Promise<{
  items: SalesOrder[];
  total: number | null;
  page: number | null;
  pageSize: number | null;
  nextCursor: string | null;
}> {
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
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    nextCursor: page.nextCursor,
  };
}

/**
 * 导出列头。CSV 拼装（BOM / CRLF / 公式注入防护）统一走 platform/http/csv.ts，
 * 不再在本文件维护第二份转义逻辑——#342 把三个导出端点收口到同一处。
 */
const EXPORT_HEADERS = [
  '单号',
  '日期',
  '客户',
  '状态',
  '经办人',
  '数量合计',
  '金额合计',
] as const;

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

function exportDateStamp(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}${month}${day}`;
}

/**
 * 销售单列表导出 CSV（`sales.order.export`，敏感读，D54 ② / D96）。
 *
 * - 权限：`sales.export`；数据范围仍走列表同款租户 + 可见公司过滤；
 * - 不分页、不接受分页参数：一次取全部符合条件行，超过 `EXPORT_MAX_ROWS` 直接 422
 *   （**不静默截断**：截断的导出会被用户当成全量对账依据，比报错危险得多）；
 * - 金额按 `sales.view_price` 脱敏：无权限时金额列留空，并在首行加一行 CSV 注释说明；
 * - 公式注入防护在 `toCsv` 里统一处理：客户名等字段可用 `=` 开头，不加前缀 Excel 会执行；
 * - AI 凭证禁止直接导出（契约 `sales.order.export` 为 `ai.policy=forbid`，D52①）；
 * - 成功必记 `action='export'` 审计（只记筛选条件摘要与行数，不记行数据）；失败由 route-mount 补 fail 审计。
 */
export async function exportSalesOrders(
  ctx: SalesOrderContext,
): Promise<{ content: string; filename: string }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.export');
  requireScope(principal, 'export');
  assertHumanCredential(principal, '导出销售单列表');
  assertNoPagingParams(ctx.request.query);
  const query = parseExportQuery(ctx.request);
  const canViewPrice = allowsScope(principal.scope, 'sales', 'view_price');

  const result = await withTenant(database, principal.tenantId, (tx) =>
    repo.exportSalesOrders(repoContext(tx, principal), {
      companyId: query.companyId,
      customerId: query.customerId,
      status: query.status,
      keyword: query.keyword,
      maxRows: EXPORT_MAX_ROWS,
    }),
  );
  if (result.exceedsMaxRows) {
    throw new AppError(
      'VALIDATION_FAILED',
      `导出结果超过 ${EXPORT_MAX_ROWS} 行，请缩小筛选条件`,
      { limit: EXPORT_MAX_ROWS },
    );
  }

  const rows = result.rows.map((order) => [
    order.orderNo,
    order.createdAt.slice(0, 10),
    order.customerName,
    order.status,
    order.handlerId ?? '',
    order.qtySum,
    canViewPrice ? formatAmount2(order.totalAmount) : '',
  ]);
  const csv = toCsv(EXPORT_HEADERS, rows);
  // toCsv 的第 0 个字符就是 BOM。无看价权限时要把注释行插在 BOM 之后、表头之前，
  // 所以拆开拼：BOM + 注释 + CRLF + 其余内容。
  const content = canViewPrice
    ? csv
    : `${csv.slice(0, 1)}# 当前账号无看价权限，金额列已留空\r\n${csv.slice(1)}`;

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
  /** 打印用展示文案：商品名 / 批次号（D70 端口取数，取不到时渲染层退回短 id）。 */
  readonly labels: SalesOrderPrintLabels;
}

/**
 * 打印取数（prints.ts：单张打印按普通读处理，不记 `amount.detail`）。
 *
 * 与详情端点共用装配与公司可见性逻辑；金额仍按 `sales.view_price` 脱敏，
 * 由渲染层把 null 显示为「—」。公司名暂无跨模块端口，只读 `company.name`。
 * AI 凭证禁止直接打印（契约 `sales.order.print` 为 `ai.policy=forbid`，D52①）。
 */
/**
 * 打印展示文案（商品名 / 批次号）：走 D70 端口，未注册端口时退回空表，
 * 由渲染层显示短 id——打印不能因为端口没接线就 500。
 */
async function loadPrintLabels(
  tx: SqlClient,
  tenantId: string,
  detail: SalesOrderDetail,
): Promise<SalesOrderPrintLabels> {
  const productIds = [...new Set(detail.lines.map((line) => line.productId))];
  const batchIds = [...new Set(detail.lines.flatMap((line) => line.batchIds))];
  try {
    const [products, batches] = await Promise.all([
      productDirectoryPort().lookupProducts(tx, { tenantId, productIds }),
      batchDirectoryPort().lookupBatchNos(tx, { tenantId, batchIds }),
    ]);
    return {
      productName: Object.fromEntries(products.map((item) => [item.id, item.name])),
      batchNo: Object.fromEntries(batches.map((item) => [item.id, item.batchNo])),
    };
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_IMPLEMENTED') {
      return { productName: {}, batchNo: {} };
    }
    throw error;
  }
}

export async function getSalesOrderForPrint(
  ctx: SalesOrderContext,
): Promise<SalesOrderPrintSource> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.print');
  requireScope(principal, 'read');
  assertHumanCredential(principal, '打印销售单');
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
    const labels = await loadPrintLabels(tx, principal.tenantId, detail);
    return {
      detail,
      companyName: company.rows[0]?.name ?? detail.companyId,
      labels,
    };
  });
  if (!source) throw new AppError('NOT_FOUND', '销售单不存在');

  const canViewPrice = allowsScope(principal.scope, 'sales', 'view_price');
  return {
    detail: maskSalesOrderDetailAmounts(source.detail, canViewPrice),
    companyName: source.companyName,
    labels: source.labels,
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
  // 客户二选一（D100）：选已有客户 or 现场报个名字。两个都给 / 都不给 → 422 且指回 customerId。
  assertIdOrDraft('customerId', input.customerId, input.customerDraft, '客户');
  const { customerDraft, ...orderInput } = input;

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
    // 静默建档（D100）：同事务先建客户再写单，单据引用的就是新客户 id；
    // 归属公司取**本单的** companyId（上面已校验可见），不看请求体里别处的公司。
    const customerId =
      input.customerId ??
      (
        await resolveMasterdataDraft(tx, principal, {
          kind: 'customer',
          companyId: input.companyId,
          draft: customerDraft!,
        })
      ).id;
    const orderNo = await takeDocumentNo(tx, 'E', input.companyId, new Date());
    const created = await repo.insertSalesOrder(repoContext(tx, principal), {
      ...orderInput,
      customerId,
      id,
      orderNo,
    });
    const reservation = await stockFlowPort().reservePending(tx, {
      tenantId: principal.tenantId,
      companyId: created.companyId,
      sourceDocType: 'E',
      sourceDocId: created.id,
      handledBy: principal.employeeId,
      lines: reservationLines(created.lines),
    });
    audit.companyId = created.companyId;
    audit.changeSummary = {
      orderNo: created.orderNo,
      customerId: created.customerId,
      handlerId: created.handlerId,
      totalAmount: created.totalAmount,
      lineCount: created.lines.length,
      feeCount: created.fees.length,
      pendingReservations: reservation.lines,
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
    const context = repoContext(tx, principal);
    const current = await repo.getSalesOrder(context, id);
    if (!current) throw new AppError('NOT_FOUND', '销售单不存在');
    const released = await stockFlowPort().releasePending(tx, {
      tenantId: principal.tenantId,
      companyId: current.companyId,
      sourceDocType: 'E',
      sourceDocId: current.id,
      handledBy: principal.employeeId,
      lines: reservationLines(current.lines),
    });
    const cancelled = await repo.cancelSalesOrder(
      context,
      id,
      expectedVersion,
    );
    if (!cancelled) throw new AppError('NOT_FOUND', '销售单不存在');
    audit.companyId = cancelled.companyId;
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: cancelled.status,
      version: cancelled.version,
      pendingReleases: released.lines,
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

function reservationLines(
  lines: readonly { readonly batchIds: readonly string[]; readonly qty: string }[],
): StockReservationLine[] {
  return lines.flatMap((line) => {
    const qty = toMicro(line.qty);
    const count = BigInt(line.batchIds.length);
    const base = qty / count;
    const remainder = qty - base * count;
    return line.batchIds.map((batchId, index) => ({
      batchId,
      qty: fromMicro(index === line.batchIds.length - 1 ? base + remainder : base),
    }));
  });
}

/** 出库副作用（扣库存 + C 草稿）的执行结果，进审计与返回值说明。 */
interface OutboundEffect {
  readonly stockFlowCount: number;
  readonly pendingReleases: readonly StockReservationReceiptLine[];
  readonly settlementOrderId: string;
  readonly settlementOrderNo: string;
  readonly totalSaleAmount: string;
  readonly totalCostAmount: string;
  readonly commissionOwnerId: string;
}

/**
 * 出库副作用（D72 / D85）：扣减批次可用量 + 生成 C 单草稿，同一事务。
 *
 * 出库（`sales.order.ship`）与「进行中直接签收」（D94 ⑤ 跳过在途的老路径）都要走这里；
 * 从「已发货」签收时货已在出库环节扣过，**不再重复调用**。
 *
 * - 库存扣减粒度：按行全量扣减，批次间均分，除不尽的余量由最后一个批次承接（D72）；
 * - C 草稿：总售价 = 单据总金额（含费用行），总成本 = Σ(行数量 × 行加权平均批次成本)；
 *   本单相关损失与提成比例本期取 `0`（D35 损失归集、D5④ 提成配置尚未落地，见 D72 ③④）。
 */
async function applyOutboundStockAndDraft(
  tx: SqlClient,
  principal: Principal,
  source: repo.SalesOrderCompletionSource,
  handledBy: string,
  requestId: string | null,
): Promise<OutboundEffect> {
  const orderId = source.order.id;
  let totalCostMicro = 0n;
  const stockFlows: { batchId: string; delta: string }[] = [];
  for (const line of source.lines) {
    if (line.batchIds.length === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `第 ${line.lineNo} 行没有引用批次，无法出库（D22）`,
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

  // A 案（#286）：完成时先释放本单建单占用，再按原口径扣减入库量。
  // 两步在同一事务内落地，避免 pending 占用与入库扣减对同一批货重复计算。
  const released = await stockFlowPort().releasePending(tx, {
    tenantId: principal.tenantId,
    companyId: source.order.companyId,
    sourceDocType: 'E',
    sourceDocId: orderId,
    handledBy,
    lines: reservationLines(source.lines),
  });

  for (const flow of stockFlows) {
    await stockFlowPort().applyAdjustment(tx, {
      tenantId: principal.tenantId,
      companyId: source.order.companyId,
      batchId: flow.batchId,
      delta: flow.delta,
      sourceDocType: 'E',
      sourceDocId: orderId,
      handledBy,
    });
  }

  const draft = await settlementDraftPort().createDraft(tx, {
    tenantId: principal.tenantId,
    companyId: source.order.companyId,
    sourceDocType: 'E',
    sourceDocId: orderId,
    // 写路径读真实金额（脱敏只作用于响应，D79）；null 仅可能来自响应侧类型。
    totalSaleAmount: source.order.totalAmount ?? '0',
    totalCostAmount: fromMicro(totalCostMicro),
    relatedLossAmount: '0',
    commissionRateSnapshot: '0',
    commissionAmount: '0',
    // D77 ②：提成归属人 = 来源单负责人；比例在结算确认时按配置解析并快照。
    commissionOwnerId: source.order.handlerId!,
    createdBy: handledBy,
    requestId,
  });

  return {
    stockFlowCount: stockFlows.length,
    pendingReleases: released.lines,
    settlementOrderId: draft.id,
    settlementOrderNo: draft.orderNo,
    // 写路径读真实金额（脱敏只作用于响应，D79）；null 仅可能来自响应侧类型。
    totalSaleAmount: source.order.totalAmount ?? '0',
    totalCostAmount: fromMicro(totalCostMicro),
    commissionOwnerId: source.order.handlerId!,
  };
}

/** 一次来源单校验的结果：阻塞明细 + 校验时的状态快照（D94 数据安全）。 */
interface SourceOrderCheck {
  readonly blocking: readonly {
    readonly type: 'A' | 'B';
    readonly no: string;
    readonly status: string;
  }[];
  readonly snapshot: readonly {
    readonly type: 'A' | 'B';
    readonly id: string;
    readonly no: string;
    readonly status: string;
  }[];
  readonly message: string;
}

const SOURCE_ORDER_LABEL: Readonly<Record<'A' | 'B', string>> = {
  A: '采购单',
  B: '加工单',
};

/**
 * 签收前的来源单校验（D94 ③）：按批次反查来源的采购单 / 加工单。
 *
 * - 批次 → 来源单走 inventory 的 `BatchDirectoryPort.lookupBatchSources`（D70）；
 * - 来源单状态走 purchase / processing 注册的 `SourceOrderStatusPort`（D70）；
 * - 只校验 `A` / `B`；`N` 内部交易等其它来源不在本单范围，跳过；
 * - 只要有一张来源单不是「已完成」就返回阻塞明细，由用例统一抛 409。
 */
async function inspectSourceOrders(
  tx: SqlClient,
  principal: Principal,
  source: repo.SalesOrderCompletionSource,
): Promise<SourceOrderCheck> {
  const batchOrder: string[] = [];
  const seenBatches = new Set<string>();
  for (const line of source.lines) {
    for (const batchId of line.batchIds) {
      if (seenBatches.has(batchId)) continue;
      seenBatches.add(batchId);
      batchOrder.push(batchId);
    }
  }
  if (batchOrder.length === 0) {
    return { blocking: [], snapshot: [], message: '' };
  }

  const origins = await batchDirectoryPort().lookupBatchSources(tx, {
    tenantId: principal.tenantId,
    companyId: source.order.companyId,
    batchIds: batchOrder,
  });
  const originByBatch = new Map(origins.map((origin) => [origin.batchId, origin]));

  const seenDocs = new Set<string>();
  const docs: { type: 'A' | 'B'; id: string }[] = [];
  for (const batchId of batchOrder) {
    const origin = originByBatch.get(batchId);
    if (!origin) continue;
    if (origin.sourceDocType !== 'A' && origin.sourceDocType !== 'B') continue;
    const key = `${origin.sourceDocType}:${origin.sourceDocId}`;
    if (seenDocs.has(key)) continue;
    seenDocs.add(key);
    docs.push({ type: origin.sourceDocType, id: origin.sourceDocId });
  }
  if (docs.length === 0) {
    return { blocking: [], snapshot: [], message: '' };
  }

  const facts = await sourceOrderStatusPort().lookupStatuses(tx, {
    tenantId: principal.tenantId,
    companyId: source.order.companyId,
    docs,
  });
  const factByKey = new Map(facts.map((fact) => [`${fact.type}:${fact.id}`, fact]));

  const snapshot: {
    type: 'A' | 'B';
    id: string;
    no: string;
    status: string;
  }[] = [];
  const blocking: { type: 'A' | 'B'; no: string; status: string }[] = [];
  for (const doc of docs) {
    const fact = factByKey.get(`${doc.type}:${doc.id}`);
    // 查不到来源单按「不可确认到货」处理（fail-closed），不静默放行。
    const status = fact?.status ?? '不存在';
    const no = fact?.orderNo ?? doc.id;
    snapshot.push({ type: doc.type, id: doc.id, no, status });
    if (status !== '已完成') blocking.push({ type: doc.type, no, status });
  }

  const message =
    blocking.length === 0
      ? ''
      : `关联单据还没到货，不能签收：${blocking
          .map((item) => `${SOURCE_ORDER_LABEL[item.type]} ${item.no} 状态是「${item.status}」`)
          .join('；')}`;
  return { blocking, snapshot, message };
}

/**
 * 销售出库（D72 / D85 / D94 ③）：进行中 → 已发货，并扣减批次可用量 + 生成 C 单草稿。
 *
 * - 端点 `sales.order.ship`，权限 `sales.ship`，与 `sales.update` 分离——能改单不等于能出库；
 * - AI 默认禁止（会锁定库存与结算额）；
 * - 仅「进行中」可出库；If-Match 强 ETag；扣库存 / C 草稿与状态变更同一事务；
 * - 出库后状态是「已发货」而不是「已完成」；签收由 `completeSalesOrder` 负责。
 */
export async function shipSalesOrder(
  ctx: SalesOrderWriteContext,
): Promise<SalesOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.ship');
  requireScope(principal, 'ship');
  assertHumanCredential(principal, '销售出库（会锁定库存与结算额）');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const handledBy = principal.employeeId;

  const audit = auditEventOf(ctx.request, principal, 'sales.order.ship', id, {
    beforeStatus: '进行中',
    afterStatus: '已发货',
  });

  const order = await withAudit(database, audit, async (tx) => {
    const context = repoContext(tx, principal);
    const state = await repo.lockSalesOrderState(context, id);
    if (!state) throw new AppError('NOT_FOUND', '销售单不存在');
    if (state.version !== expectedVersion) {
      throw new AppError(
        'VERSION_CONFLICT',
        '销售单版本与 If-Match 不一致，请重新读取后重试',
        { expected: expectedVersion, current: state.version },
      );
    }
    if (state.status !== '进行中') {
      throw new AppError(
        'VALIDATION_FAILED',
        '只有「进行中」的销售单可出库，已发货/已完成/已取消不可再次出库',
        { status: state.status },
      );
    }

    const source = await repo.loadSalesOrderCompletionSource(context, id);
    if (!source) throw new AppError('NOT_FOUND', '销售单不存在');

    const outbound = await applyOutboundStockAndDraft(
      tx,
      principal,
      source,
      handledBy,
      requestIdFor(ctx.request),
    );

    const shipped = await repo.shipSalesOrder(context, id, expectedVersion);
    if (!shipped) throw new AppError('NOT_FOUND', '销售单不存在');

    audit.companyId = shipped.companyId;
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: shipped.status,
      version: shipped.version,
      stockFlowCount: outbound.stockFlowCount,
      pendingReleases: outbound.pendingReleases,
      settlementOrderId: outbound.settlementOrderId,
      settlementOrderNo: outbound.settlementOrderNo,
      totalSaleAmount: outbound.totalSaleAmount,
      totalCostAmount: outbound.totalCostAmount,
      commissionRateSnapshot: '0',
      relatedLossAmount: '0',
      commissionOwnerId: outbound.commissionOwnerId,
      placeholders: ['relatedLossAmount', 'commissionRateSnapshot'],
    };
    return shipped;
  });

  ctx.reply.header('ETag', etagOf(order.version));
  // D79：写路径返回的真实金额同样按看价权限脱敏（脱敏只发生在响应上）。
  return maskSalesOrderAmounts(
    order,
    allowsScope(principal.scope, 'sales', 'view_price'),
  );
}

/**
 * 客户签收完成（D94 ③）：已发货 → 已完成；进行中也能直接签收（D94 ⑤ 跳过在途）。
 *
 * - 权限 `sales.approve`（D94 ④：签收是审批动作，不再是 update / ship）；
 * - 签收前**按批次反查来源 A/B 单**，只要有一张不是「已完成」就 409
 *   `STATE_CONFLICT` + `details.reason='SOURCE_ORDER_NOT_READY'` + `details.blocking` 指名；
 * - 来源单校验与状态变更同一事务；先 `SELECT … FOR UPDATE` 锁 E 单行，版本冲突 409；
 * - 从「进行中」直接签收时补出库副作用（扣库存 + C 草稿），与老路径一致；
 * - AI 默认禁止且必须给原因（契约 `sales.order.complete`）。
 */
export async function completeSalesOrder(
  ctx: SalesOrderWriteContext,
): Promise<SalesOrder> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'sales.order.complete');
  requireScope(principal, 'approve');
  assertHumanCredential(principal, '签收销售单（会把应收挂上）');

  const id = parseOrderId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const handledBy = principal.employeeId;

  const audit = auditEventOf(ctx.request, principal, 'sales.order.complete', id, {
    beforeStatus: '已发货',
    afterStatus: '已完成',
  });

  const order = await withAudit(database, audit, async (tx) => {
    const context = repoContext(tx, principal);
    const state = await repo.lockSalesOrderState(context, id);
    if (!state) throw new AppError('NOT_FOUND', '销售单不存在');
    if (state.version !== expectedVersion) {
      throw new AppError(
        'VERSION_CONFLICT',
        '销售单版本与 If-Match 不一致，请重新读取后重试',
        { expected: expectedVersion, current: state.version },
      );
    }
    if (state.status !== '进行中' && state.status !== '已发货') {
      throw new AppError(
        'VALIDATION_FAILED',
        '只有「进行中」或「已发货」的销售单可签收完成，已完成/已取消不可再次完成',
        { status: state.status },
      );
    }

    const source = await repo.loadSalesOrderCompletionSource(context, id);
    if (!source) throw new AppError('NOT_FOUND', '销售单不存在');

    // 关键逻辑：来源 A/B 单必须全部「已完成」，否则 409 并指名哪张单没到货。
    const sourceCheck = await inspectSourceOrders(tx, principal, source);
    if (sourceCheck.blocking.length > 0) {
      throw new AppError('STATE_CONFLICT', sourceCheck.message, {
        reason: 'SOURCE_ORDER_NOT_READY',
        blocking: sourceCheck.blocking,
      });
    }

    // D94 ⑤：跳过在途直接签收时补做老路径的出库副作用；已发货时货已在出库环节扣过。
    const outbound =
      state.status === '进行中'
        ? await applyOutboundStockAndDraft(
            tx,
            principal,
            source,
            handledBy,
            requestIdFor(ctx.request),
          )
        : null;

    const completed = await repo.completeSalesOrder(
      context,
      id,
      expectedVersion,
      ['进行中', '已发货'],
    );
    if (!completed) throw new AppError('NOT_FOUND', '销售单不存在');

    audit.companyId = completed.companyId;
    audit.changeSummary = {
      beforeStatus: state.status,
      afterStatus: completed.status,
      version: completed.version,
      sourceOrders: sourceCheck.snapshot,
      ...(outbound
        ? {
            stockFlowCount: outbound.stockFlowCount,
            pendingReleases: outbound.pendingReleases,
            settlementOrderId: outbound.settlementOrderId,
            settlementOrderNo: outbound.settlementOrderNo,
            totalSaleAmount: outbound.totalSaleAmount,
            totalCostAmount: outbound.totalCostAmount,
            commissionRateSnapshot: '0',
            relatedLossAmount: '0',
            commissionOwnerId: outbound.commissionOwnerId,
            placeholders: ['relatedLossAmount', 'commissionRateSnapshot'],
          }
        : {}),
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
