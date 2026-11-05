import {
  AppError,
  InventoryFlowListQuerySchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  type CursorPayload,
  type InventoryFlow,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import * as repo from '../repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InventoryFlowContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

interface ParsedFlowListQuery {
  readonly companyId?: string;
  readonly batchId?: string;
  readonly sourceDocType?: string;
  readonly sourceDocId?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: InventoryFlowContext): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', '数据库未配置，inventory.flow.read 不可用', {
      operationId: 'inventory.flow.read',
    });
  }
  return database;
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseListQuery(request: FastifyRequest): ParsedFlowListQuery {
  const parsed = InventoryFlowListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', { issues: issuesOf(parsed.error) });
  }

  let cursor: CursorPayload | undefined;
  if (parsed.data.cursor !== undefined) {
    cursor = decodeCursor(parsed.data.cursor);
    if (!UUID_RE.test(cursor.id)) {
      throw new AppError('VALIDATION_FAILED', 'cursor 内容不合法', { field: 'cursor' });
    }
  }

  return {
    companyId: parsed.data.companyId,
    batchId: parsed.data.batchId,
    sourceDocType: parsed.data.sourceDocType,
    sourceDocId: parsed.data.sourceDocId,
    cursor,
    limit: clampLimit(parsed.data.limit),
  };
}

function repoContext(tx: SqlClient, principal: Principal): repo.InventoryRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
}

/** 流水列表：普通读，不记审计（D54②）；流水本身只追加（D2① / D67④）。 */
export async function listFlows(
  ctx: InventoryFlowContext,
): Promise<{ items: InventoryFlow[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);
  if (!allowsScope(principal.scope, 'inventory_flow', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 inventory_flow.read 权限');
  }
  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listInventoryFlows(repoContext(tx, principal), query),
  );
}
