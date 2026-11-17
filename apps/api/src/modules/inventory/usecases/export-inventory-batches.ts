import {
  AppError,
  EXPORT_MAX_ROWS,
  InventoryBatchExportQuerySchema,
  allowsScope,
  assertNoPagingParams,
  type InventoryBatchExportQuery,
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
 * 库存批次列表导出 CSV（`inventory.batch.export`，敏感读，D54 ② / D96）。
 *
 * - 权限：只认 `inventory_qty.export`（库存批次属数量域 `inventory_qty`，
 *   没有独立的 `inventory` 域；契约里 operationId 用 `inventory.` 伞名，D44）；
 * - 数据范围：与列表同款租户 + 可见公司过滤（D15）；
 * - 不分页：超过 `EXPORT_MAX_ROWS` 直接 422，**不静默截断**；
 * - 不脱敏单价：批次列表本来就把 `lockedUnitCost` 原样返回（列表口径如此），
 *   导出与列表保持一致，不在这里另造一套规则；
 * - 审计：记 `action='export'` + 筛选条件摘要 + 行数，不记行数据。
 *
 * 本文件按模块既有写法自带 require* 小助手（每个用例文件一份），不跨文件共享私有函数。
 */

const OBJECT_TYPE = 'inventory_batch';

const EXPORT_HEADERS = [
  '批次号',
  '商品编号',
  '商品名称',
  '锁定单价',
  '入库数量',
  '剩余数量',
  '在途数量',
  '待执行数量',
  '可用数量',
  '保管人',
  '创建日期',
] as const;

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface InventoryExportContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new AppError('UNAUTHENTICATED', '缺少身份凭证');
  }
  return request.principal;
}

function requireDatabase(ctx: InventoryExportContext, operationId: string): Database {
  if (!ctx.database) {
    throw new AppError('NOT_IMPLEMENTED', `${operationId} 尚未实现（数据库未配置）`, {
      operationId,
    });
  }
  return ctx.database;
}

function requireScope(principal: Principal, action: 'export'): void {
  // 权限点只认 scope（D44）：批次属数量域 inventory_qty，没有独立的 inventory 域。
  if (!allowsScope(principal.scope, 'inventory_qty', action)) {
    throw new AppError('FORBIDDEN', `缺少权限 inventory_qty.${action}`, {
      scope: `inventory_qty.${action}`,
    });
  }
}

function exportDateStamp(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}${month}${day}`;
}

function parseExportQuery(request: FastifyRequest): InventoryBatchExportQuery {
  const parsed = InventoryBatchExportQuerySchema.safeParse(request.query);
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
    objectId: null,
    changeSummary,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    reason: request.auditReason,
  };
}

export async function exportInventoryBatches(
  ctx: InventoryExportContext,
): Promise<{ content: string; filename: string }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'inventory.batch.export');
  requireScope(principal, 'export');
  assertNoPagingParams(ctx.request.query);
  const query = parseExportQuery(ctx.request);

  const result = await withTenant(database, principal.tenantId, (tx) =>
    repo.exportInventoryBatches(
      { tx, tenantId: principal.tenantId, companyIds: principal.companyIds },
      {
        companyId: query.companyId,
        productId: query.productId,
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

  const rows = result.rows.map((batch) => [
    batch.batchNo,
    batch.productNo,
    batch.productName,
    batch.lockedUnitCost,
    batch.inboundQty,
    batch.remainingQty,
    batch.inTransitQty,
    batch.pendingExecutionQty,
    batch.availableQty,
    batch.custodianId,
    batch.createdAt.slice(0, 10),
  ]);
  const content = toCsv(EXPORT_HEADERS, rows);

  const audit = auditEventOf(ctx.request, principal, {
    operationId: 'inventory.batch.export',
    companyId: query.companyId ?? null,
    productId: query.productId ?? null,
    keyword: query.keyword ?? null,
    rowCount: rows.length,
  });
  audit.companyId = query.companyId ?? null;
  await recordAudit(database, audit);

  return { content, filename: `库存批次-${exportDateStamp(new Date())}.csv` };
}
