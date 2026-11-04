import {
  AppError,
  EmployeeListQuerySchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  encodeCursor,
  type CursorPayload,
  type EmployeeSummary,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';

/**
 * 员工列表（D15 / D50 / D54②）。
 *
 * - 普通读**不记审计**（D54②）；调用者需 `employee.read`，否则 403；
 * - 数据范围：老板 = 全租户员工；非老板 = 绑定公司集合（`principal.companyIds`）内至少
 *   有一条 `employee_company_position` 的员工——服务端判定，前端传参不能放大；
 * - 返回摘要而非全量员工：只回 `phoneMasked`（前 3 + `****` + 后 4），完整手机号不出服务端；
 * - 游标分页与 api-tokens 一致：`encodeCursor` / `decodeCursor`，按 id 倒序 keyset。
 */

const ACTION = 'platform.employee.read';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EmployeeListContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

interface EmployeeCompany {
  companyId: string;
  companyName: string;
  positionId: string;
  positionName: string;
}

interface EmployeeRow {
  id: string;
  employee_no: string;
  name: string;
  status: string;
  is_owner: boolean;
  phone: string;
  created_at: Date | string;
  companies: unknown;
}

interface ParsedQuery {
  readonly companyId?: string;
  readonly positionId?: string;
  readonly status?: '在职' | '停用';
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

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

function requireDatabase(ctx: EmployeeListContext): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${ACTION} 不可用`, { operationId: ACTION });
  }
  return database;
}

function parseQuery(request: FastifyRequest): ParsedQuery {
  const parsed = EmployeeListQuerySchema.safeParse(request.query);
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
    positionId: parsed.data.positionId,
    status: parsed.data.status,
    keyword: parsed.data.keyword,
    cursor,
    limit: clampLimit(parsed.data.limit),
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** 手机号脱敏：前 3 位 + `****` + 后 4 位（如 `100****0001`）。 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 7) {
    return `${digits.slice(0, 1)}****${digits.slice(-2)}`;
  }
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** LIKE / ILIKE 模式串：转义用户输入里的 `\`、`%`、`_`，避免把关键词当通配符。 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function parseCompanies(raw: unknown): EmployeeCompany[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const companies: EmployeeCompany[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.companyId !== 'string' ||
      typeof item.companyName !== 'string' ||
      typeof item.positionId !== 'string' ||
      typeof item.positionName !== 'string'
    ) {
      continue;
    }
    companies.push({
      companyId: item.companyId,
      companyName: item.companyName,
      positionId: item.positionId,
      positionName: item.positionName,
    });
  }
  return companies;
}

function mapRow(row: EmployeeRow): EmployeeSummary {
  return {
    id: row.id,
    employeeNo: row.employee_no,
    name: row.name,
    status: row.status as EmployeeSummary['status'],
    isOwner: row.is_owner,
    phoneMasked: maskPhone(row.phone),
    companies: parseCompanies(row.companies),
  };
}

async function loadCallerIsOwner(
  tx: SqlClient,
  employeeId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await tx.query<{ is_owner: boolean }>(
    'SELECT is_owner FROM employee WHERE id = $1 AND tenant_id = $2',
    [employeeId, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('UNAUTHENTICATED');
  return row.is_owner === true;
}

/** 员工列表：租户内、按可见范围过滤、cursor 分页。 */
export async function listEmployees(
  ctx: EmployeeListContext,
): Promise<{ items: EmployeeSummary[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);

  if (!allowsScope(principal.scope, 'employee', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 employee.read 权限');
  }

  const query = parseQuery(ctx.request);

  const rows = await withTenant(database, principal.tenantId, async (tx) => {
    const isOwner = await loadCallerIsOwner(tx, principal.employeeId, principal.tenantId);

    const params: unknown[] = [principal.tenantId];
    const where: string[] = ['e.tenant_id = $1'];
    /** 非老板的可见公司数组参数名；老板为 undefined（公司-岗位子查询不过滤）。 */
    let visibleParam: string | undefined;

    // 非老板：只看绑定公司集合内至少有一条任职记录的员工（服务端判定，不信任客户端）。
    if (!isOwner) {
      params.push([...principal.companyIds]);
      visibleParam = `$${params.length}`;
      where.push(`EXISTS (
        SELECT 1
          FROM employee_company_position visible
         WHERE visible.employee_id = e.id
           AND visible.tenant_id = e.tenant_id
           AND visible.company_id = ANY(${visibleParam}::uuid[])
      )`);
    }

    if (query.companyId !== undefined) {
      params.push(query.companyId);
      where.push(`EXISTS (
        SELECT 1
          FROM employee_company_position filter_company
         WHERE filter_company.employee_id = e.id
           AND filter_company.tenant_id = e.tenant_id
           AND filter_company.company_id = $${params.length}::uuid
      )`);
    }

    if (query.positionId !== undefined) {
      params.push(query.positionId);
      where.push(`EXISTS (
        SELECT 1
          FROM employee_company_position filter_position
         WHERE filter_position.employee_id = e.id
           AND filter_position.tenant_id = e.tenant_id
           AND filter_position.position_id = $${params.length}::uuid
      )`);
    }

    if (query.status !== undefined) {
      params.push(query.status);
      where.push(`e.status = $${params.length}`);
    }

    if (query.keyword !== undefined) {
      params.push(likePattern(query.keyword));
      const keywordParam = `$${params.length}`;
      where.push(`(
        e.name ILIKE ${keywordParam} ESCAPE '\\'
        OR e.employee_no ILIKE ${keywordParam} ESCAPE '\\'
        OR right(e.phone, 4) ILIKE ${keywordParam} ESCAPE '\\'
      )`);
    }

    if (query.cursor !== undefined) {
      params.push(query.cursor.id);
      where.push(`e.id < $${params.length}::uuid`);
    }

    params.push(query.limit + 1);

    // 非老板只回可见公司的公司-岗位对；老板返回全租户公司。
    const companyVisibility =
      visibleParam === undefined ? '' : `AND ecp.company_id = ANY(${visibleParam}::uuid[])`;

    const result = await tx.query<EmployeeRow>(
      `SELECT e.id,
              e.employee_no,
              e.name,
              e.status,
              e.is_owner,
              e.phone,
              e.created_at,
              coalesce(
                (
                  SELECT json_agg(
                           json_build_object(
                             'companyId', c.id,
                             'companyName', c.name,
                             'positionId', p.id,
                             'positionName', p.name
                           )
                           ORDER BY c.code, p.name
                         )
                    FROM employee_company_position ecp
                    JOIN company c
                      ON c.id = ecp.company_id AND c.tenant_id = ecp.tenant_id
                    JOIN position p
                      ON p.id = ecp.position_id AND p.tenant_id = ecp.tenant_id
                   WHERE ecp.employee_id = e.id
                     AND ecp.tenant_id = e.tenant_id
                     ${companyVisibility}
                ),
                '[]'::json
              ) AS companies
         FROM employee e
        WHERE ${where.join('\n          AND ')}
        ORDER BY e.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  });

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const items = pageRows.map(mapRow);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: toDate(last.created_at).toISOString(), id: last.id })
      : null;

  // D54②：普通读不记审计。
  return { items, nextCursor };
}
