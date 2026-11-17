import {
  AppError,
  EXPORT_MAX_ROWS,
  PurchaseExportQuerySchema,
  allowsScope,
  assertNoPagingParams,
  type PurchaseExportQuery,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import { recordAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database } from '../../../platform/db/client.js';
import { toCsv } from '../../../platform/http/csv.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import * as repo from '../repo.js';

/**
 * 采购单列表导出 CSV（`purchase.order.export`，敏感读，D54 ② / D96）。
 *
 * - 权限：只认 `purchase.export`，不看岗位（D44 / 权限铁律）；
 * - 数据范围：与列表同款租户 + 可见公司过滤（D15），过滤条件由 repo 的导出函数拼；
 * - 不分页：超过 `EXPORT_MAX_ROWS` 直接 422，**不静默截断**；
 * - 金额按 `purchase.view_price` 脱敏：无权限时金额列留空并加一行注释说明；
 * - 审计：记 `action='export'` + 筛选条件摘要 + 行数，不记行数据（审计表不是数据副本）。
 *
 * 本文件按模块既有写法自带 require* 小助手（每个用例文件一份），不跨文件共享私有函数。
 */

const OBJECT_TYPE = 'purchase_order';

const EXPORT_HEADERS = [
  '单号',
  '日期',
  '供应商',
  '状态',
  '经办人',
  '数量合计',
  '金额合计',
] as const;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface PurchaseExportContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new AppError('UNAUTHENTICATED', '缺少身份凭证');
  }
  return request.principal;
}

function requireDatabase(ctx: PurchaseExportContext, operationId: string): Database {
  if (!ctx.database) {
    throw new AppError('NOT_IMPLEMENTED', `${operationId} 尚未实现（数据库未配置）`, {
      operationId,
    });
  }
  return ctx.database;
}

function requireScope(principal: Principal, action: 'export'): void {
  // 权限点只认 scope（D44），不看岗位。
  if (!allowsScope(principal.scope, 'purchase', action)) {
    throw new AppError('FORBIDDEN', `缺少权限 purchase.${action}`, {
      scope: `purchase.${action}`,
    });
  }
}

/**
 * 金额统一两位小数（四舍五入）。
 *
 * 纯字符串运算，不经过 number：金额是 decimal 字符串（D54），
 * `Number('1234567890.005')` 这种转换会丢精度，导出对账时就是对不上账的经典来源。
 */
function formatAmount2(value: string): string {
  const negative = value.trim().startsWith('-');
  const [intPart, fracRaw = ''] = value.trim().replace('-', '').split('.');
  const frac = fracRaw.padEnd(3, '0');
  let cents = BigInt(`${intPart === '' ? '0' : intPart}${frac.slice(0, 2)}`);
  if ((frac[2] ?? '0') >= '5') cents += 1n;
  const padded = cents.toString().padStart(3, '0');
  return `${negative ? '-' : ''}${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function exportDateStamp(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}${month}${day}`;
}

function parseExportQuery(request: FastifyRequest): PurchaseExportQuery {
  const parsed = PurchaseExportQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
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
    action: 'export',
    objectType: OBJECT_TYPE,
    objectId,
    changeSummary,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    reason: request.auditReason,
  };
}

export async function exportPurchaseOrders(
  ctx: PurchaseExportContext,
): Promise<{ content: string; filename: string }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'purchase.order.export');
  requireScope(principal, 'export');
  assertNoPagingParams(ctx.request.query);
  const query = parseExportQuery(ctx.request);
  const canViewPrice = allowsScope(principal.scope, 'purchase', 'view_price');

  const result = await withTenant(database, principal.tenantId, (tx) =>
    repo.exportPurchaseOrders(
      { tx, tenantId: principal.tenantId, companyIds: principal.companyIds },
      {
        companyId: query.companyId,
        supplierId: query.supplierId,
        status: query.status,
        keyword: query.keyword,
        maxRows: EXPORT_MAX_ROWS,
      },
    ),
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
    order.supplierName,
    order.status,
    order.handlerId ?? '',
    order.qtySum,
    canViewPrice ? formatAmount2(order.totalAmount) : '',
  ]);
  const csv = toCsv(EXPORT_HEADERS, rows);
  // toCsv 第 0 个字符是 BOM；注释行要插在 BOM 之后、表头之前，故拆开拼。
  const content = canViewPrice
    ? csv
    : `${csv.slice(0, 1)}# 当前账号无看价权限，金额列已留空\r\n${csv.slice(1)}`;

  const audit = auditEventOf(ctx.request, principal, null, {
    operationId: 'purchase.order.export',
    companyId: query.companyId ?? null,
    supplierId: query.supplierId ?? null,
    status: query.status ?? null,
    keyword: query.keyword ?? null,
    rowCount: rows.length,
    canViewPrice,
  });
  audit.companyId = query.companyId ?? null;
  await recordAudit(database, audit);

  return { content, filename: `采购单-${exportDateStamp(new Date())}.csv` };
}
