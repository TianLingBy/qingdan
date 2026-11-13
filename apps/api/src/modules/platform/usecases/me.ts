import { AppError, type ScopeMatrix, type WorkbenchEntry } from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database } from '../../../platform/db/client.js';
import { computeWorkbenchEntries } from '../workbench-entries.js';

/**
 * 当前身份（D52.1② / Issue #227）：权限每请求现算，`companyIds` / `scope` / `isOwner`
 * 直接取自已解析的 principal；`displayName` 按请求租户上下文从 employee 表读取；
 * `entries` 为后端按 scope 现算的工作台入口清单（前端不再自行推导）。
 */

export interface MeContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface MeResult {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly isOwner: boolean;
  readonly companyIds: string[];
  readonly scope: ScopeMatrix;
  readonly entries: readonly WorkbenchEntry[];
}

interface EmployeeNameRow {
  name: string;
}

export async function me(ctx: MeContext): Promise<MeResult> {
  const principal = ctx.request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');

  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', '数据库未配置，无法读取身份', {
      operationId: 'platform.auth.me',
    });
  }

  const result = await withTenant(database, principal.tenantId, (tx) =>
    tx.query<EmployeeNameRow>('SELECT name FROM employee WHERE id = $1 AND tenant_id = $2', [
      principal.employeeId,
      principal.tenantId,
    ]),
  );
  const row = result.rows[0];
  if (!row) throw new AppError('UNAUTHENTICATED');

  return {
    employeeId: principal.employeeId,
    tenantId: principal.tenantId,
    displayName: row.name,
    isOwner: principal.isOwner,
    companyIds: [...principal.companyIds],
    scope: principal.scope,
    entries: computeWorkbenchEntries(principal.scope),
  };
}
