import {
  AppError,
  InventoryBatchListQuerySchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  type CursorPayload,
  type InventoryBatch,
  type InventoryBatchDetail,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import * as repo from '../repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InventoryContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

interface ParsedBatchListQuery {
  readonly companyId?: string;
  readonly productId?: string;
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: InventoryContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, { operationId });
  }
  return database;
}

function requireInventoryRead(principal: Principal): void {
  if (!allowsScope(principal.scope, 'inventory_qty', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 inventory_qty.read 权限');
  }
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseCursor(raw: string): CursorPayload {
  const cursor = decodeCursor(raw);
  if (!UUID_RE.test(cursor.id)) {
    throw new AppError('VALIDATION_FAILED', 'cursor 内容不合法', { field: 'cursor' });
  }
  return cursor;
}

function parseListQuery(request: FastifyRequest): ParsedBatchListQuery {
  const parsed = InventoryBatchListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', { issues: issuesOf(parsed.error) });
  }
  return {
    companyId: parsed.data.companyId,
    productId: parsed.data.productId,
    keyword: parsed.data.keyword,
    cursor: parsed.data.cursor === undefined ? undefined : parseCursor(parsed.data.cursor),
    limit: clampLimit(parsed.data.limit),
  };
}

function parseBatchId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id' });
  }
  return id;
}

function repoContext(tx: SqlClient, principal: Principal): repo.InventoryRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
}

/** 批次列表：普通读，不记审计（D54②）。 */
export async function listBatches(
  ctx: InventoryContext,
): Promise<{ items: InventoryBatch[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'inventory.batch.list.read');
  requireInventoryRead(principal);
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listInventoryBatches(repoContext(tx, principal), query),
  );
}

/** 批次详情：普通读，不记审计；跨公司 / 不存在统一 404。 */
export async function getBatch(ctx: InventoryContext): Promise<InventoryBatchDetail> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'inventory.batch.detail.read');
  requireInventoryRead(principal);
  const id = parseBatchId(ctx.request);

  const batch = await withTenant(database, principal.tenantId, (tx) =>
    repo.getInventoryBatch(repoContext(tx, principal), id),
  );
  if (!batch) throw new AppError('NOT_FOUND', '库存批次不存在');
  return batch;
}
