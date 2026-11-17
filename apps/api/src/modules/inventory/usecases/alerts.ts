import {
  AppError,
  InventoryAlertListQuerySchema,
  allowsScope,
  type InventoryAlertItem,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import * as repo from '../repo.js';

/**
 * 低库存预警用例（#354 第 2 条 / D104）。
 *
 * 只读、无副作用：普通读不记审计（D54②）。
 */

export interface InventoryAlertContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

/** `thresholdRatio` 的缺省值（D104）：7 天窗口上再提前 20%，≈8.4 天库存开始提醒。 */
export const DEFAULT_ALERT_THRESHOLD_RATIO = 0.2;

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: InventoryAlertContext): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', '数据库未配置，inventory.alert.list 不可用', {
      operationId: 'inventory.alert.list',
    });
  }
  return database;
}

function repoContext(tx: SqlClient, principal: Principal): repo.InventoryRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
}

/**
 * 低库存预警列表。
 *
 * 三条不能含糊的边界：
 * - `companyId` 必传（缺参数 422），且必须落在 `principal.companyIds` 内，否则 **403**——
 *   **不返回空数组**：空数组的含义是「库存都够」，那是撒谎（同 D99⑧ / D102⑦）。
 * - `thresholdRatio` 越界（< 0 或 > 1）由契约 `.min(0).max(1)` 拦成 422；
 *   缺省在用例层兜底 `?? 0.2`，不用 zod `.default()`（否则 OpenAPI 会标成必填）。
 * - 权限走 `inventory_qty.read`，与批次列表同一个权限点：能看到库存的人才看得到预警。
 */
export async function listInventoryAlerts(
  ctx: InventoryAlertContext,
): Promise<{ items: InventoryAlertItem[] }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);
  if (!allowsScope(principal.scope, 'inventory_qty', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 inventory_qty.read 权限');
  }

  const parsed = InventoryAlertListQuerySchema.safeParse(ctx.request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', { issues: issuesOf(parsed.error) });
  }

  const companyId = parsed.data.companyId;
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '无权查看该公司的库存预警', { field: 'companyId' });
  }

  const items = await withTenant(database, principal.tenantId, (tx) =>
    repo.listInventoryAlerts(repoContext(tx, principal), {
      companyId,
      thresholdRatio: parsed.data.thresholdRatio ?? DEFAULT_ALERT_THRESHOLD_RATIO,
    }),
  );
  return { items };
}
