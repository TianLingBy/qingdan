import {
  AppError,
  EmployeeCreateInputSchema,
  EmployeeListQuerySchema,
  EmployeeUpdateInputSchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  encodeCursor,
  etagOf,
  type CursorPayload,
  type Employee,
  type EmployeeSummary,
} from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { takeEmployeeNo } from '../../../platform/numbering/service.js';
import { requestIdFor } from '../../../platform/http/request-id.js';

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

// ---------------------------------------------------------------------------
// 员工管理写端点（platform.employee.create / update / disable，契约 2026-11-05 PR #46）
//
// 口径（契约注释为准，这里只记实现选择）：
// - 工号由 `takeEmployeeNo` 服务端发放（D48：6 位、租户内全局唯一、入参不接收）；
// - `positionIds` × `companyIds` 两个数组按**全组合**落 `employee_company_position`
//   （契约只有两个数组；「公司×岗位配对」结构需契约后续版本提供，见 Issue #45 讨论）；
// - 手机号全平台唯一（0001 表约束）：同租户占用 → 422；跨租户占用 → 403 +
//   「联系原企业管理员」（D14），检查走既有 SECURITY DEFINER 函数 `auth_find_login`；
// - 停用即失效（D52.1②）：`computeAuthz` 每请求现判 `e.status='在职'`，停用后该员工的
//   会话与 API Token 下一次请求自然 401 —— 不改内核函数、不引入缓存、无需新迁移；
// - 写操作 100% 审计（D51）；create / disable 为危险动作，AI 默认禁止（D54⑥）。
// ---------------------------------------------------------------------------

const EMPLOYEE_OBJECT_TYPE = 'employee';

export interface EmployeeWriteContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

interface EntityRow extends EmployeeRow {
  version: number;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

function requireWriteDatabase(ctx: EmployeeWriteContext, action: string): Database {
  if (!ctx.database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${action} 不可用`, { operationId: action });
  }
  return ctx.database;
}

/** AI 不得建号 / 停用（契约 ai.policy=forbid，D54⑥）；update 的 AI 限制只针对 isOwner 字段。 */
function assertHumanCredential(principal: Principal): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接执行该员工管理动作');
  }
}

/** 路径参数 {id}（契约 employees 路由用 {id}，与 permission 路由的 {employeeId} 不同）。 */
function parseIdParam(request: FastifyRequest, action: string): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id', operationId: action });
  }
  return id;
}

/** If-Match **强制**（契约 requiresIfMatch=true）：缺失 → 428；格式非法 → 409。 */
function requireIfMatchVersion(request: FastifyRequest): number {
  const raw = headerValue(request, 'if-match');
  if (raw === undefined || raw.trim() === '') {
    throw new AppError('PRECONDITION_REQUIRED', '本端点必须携带 If-Match（强 ETag "<version>"）');
  }
  const match = /^"([0-9]+)"$/.exec(raw.trim());
  if (!match) {
    throw new AppError('VERSION_CONFLICT', 'If-Match 格式不合法，应为强 ETag "<version>"', {
      ifMatch: raw,
    });
  }
  return Number(match[1]);
}

function parseCreateBody(body: unknown): import('@qingdan/contracts').EmployeeCreateInput {
  const parsed = EmployeeCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '创建员工入参不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

function parseUpdateBody(body: unknown): import('@qingdan/contracts').EmployeeUpdateInput {
  const parsed = EmployeeUpdateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '修改员工入参不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  action: string,
  objectId: string | null,
  changeSummary: Record<string, unknown>,
): AuditEvent {
  return {
    tenantId: principal.tenantId,
    actorType: principal.actorType,
    actorId: principal.actorId,
    credentialId: principal.credentialId,
    source: request.auditSource,
    action,
    objectType: EMPLOYEE_OBJECT_TYPE,
    objectId,
    changeSummary,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: headerValue(request, 'user-agent') ?? null,
    reason: request.auditReason,
  };
}

function dedupeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * D14 手机号占用检查（跨 RLS 走既有 SECURITY DEFINER 函数，不新增跨租户 SELECT）：
 * 同租户占用 → 422；跨租户占用 → 403 + 「联系原企业管理」。`excludeEmployeeId` 供改号排除自己。
 */
async function assertPhoneAvailable(
  tx: SqlClient,
  phone: string,
  tenantId: string,
  excludeEmployeeId: string | undefined,
): Promise<void> {
  const result = await tx.query<{
    tenant_id: string;
    employee_id: string;
  }>('SELECT tenant_id, employee_id FROM auth_find_login($1)', [phone]);
  for (const row of result.rows) {
    if (excludeEmployeeId !== undefined && row.employee_id === excludeEmployeeId) continue;
    if (row.tenant_id === tenantId) {
      throw new AppError('VALIDATION_FAILED', '该手机号在本企业已被占用', {
        field: 'phone',
        reason: 'PHONE_TAKEN',
      });
    }
    throw new AppError(
      'FORBIDDEN',
      '该手机号已被其他企业使用，请联系原企业管理员移除后再加入本企业',
      { reason: 'PHONE_OCCUPIED_OTHER_TENANT', field: 'phone' },
    );
  }
}

interface NamedIdRow {
  id: string;
  name: string;
}

/** 公司必须存在、属于本租户且启用；缺失 → 404（资源不存在，非参数格式问题）。 */
async function validateCompanies(
  tx: SqlClient,
  companyIds: readonly string[],
  tenantId: string,
): Promise<Map<string, string>> {
  const result = await tx.query<NamedIdRow>(
    `SELECT id, name FROM company
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = '启用'`,
    [tenantId, dedupeIds(companyIds)],
  );
  if (result.rows.length !== dedupeIds(companyIds).length) {
    throw new AppError('NOT_FOUND', '公司不存在、已停用或不属于本租户', {
      companyIds: dedupeIds(companyIds),
    });
  }
  return new Map(result.rows.map((row) => [row.id, row.name]));
}

/** 岗位必须存在且属于本租户；缺失 → 404。 */
async function validatePositions(
  tx: SqlClient,
  positionIds: readonly string[],
  tenantId: string,
): Promise<Map<string, string>> {
  const result = await tx.query<NamedIdRow>(
    'SELECT id, name FROM position WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
    [tenantId, dedupeIds(positionIds)],
  );
  if (result.rows.length !== dedupeIds(positionIds).length) {
    throw new AppError('NOT_FOUND', '岗位不存在或不属于本租户', {
      positionIds: dedupeIds(positionIds),
    });
  }
  return new Map(result.rows.map((row) => [row.id, row.name]));
}

/** 两数组全组合落 `employee_company_position`（契约语义见本节头注释）。 */
async function insertBindings(
  tx: SqlClient,
  employeeId: string,
  tenantId: string,
  companyIds: readonly string[],
  positionIds: readonly string[],
): Promise<void> {
  for (const companyId of dedupeIds(companyIds)) {
    for (const positionId of dedupeIds(positionIds)) {
      await tx.query(
        `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [tenantId, employeeId, companyId, positionId],
      );
    }
  }
}

interface TargetRow {
  id: string;
  employee_no: string;
  phone: string;
  name: string;
  status: string;
  is_owner: boolean;
  version: number;
}

async function loadTargetRow(
  tx: SqlClient,
  employeeId: string,
  tenantId: string,
): Promise<TargetRow> {
  const result = await tx.query<TargetRow>(
    `SELECT id, employee_no, phone, name, status, is_owner, version
       FROM employee WHERE id = $1 AND tenant_id = $2`,
    [employeeId, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('NOT_FOUND', '员工不存在或不属于本租户');
  return row;
}

/** 读回契约 Employee 实体（摘要口径 + version；手机号只回脱敏）。 */
async function loadEmployeeEntity(
  tx: SqlClient,
  employeeId: string,
  tenantId: string,
): Promise<Employee> {
  const result = await tx.query<EntityRow & { companies: unknown }>(
    `SELECT e.id, e.employee_no, e.name, e.status, e.is_owner, e.phone, e.created_at, e.version,
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
                  JOIN company c ON c.id = ecp.company_id AND c.tenant_id = ecp.tenant_id
                  JOIN position p ON p.id = ecp.position_id AND p.tenant_id = ecp.tenant_id
                 WHERE ecp.employee_id = e.id AND ecp.tenant_id = e.tenant_id
              ),
              '[]'::json
            ) AS companies
       FROM employee e
      WHERE e.id = $1 AND e.tenant_id = $2`,
    [employeeId, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('NOT_FOUND', '员工不存在或不属于本租户');
  const summary: EmployeeSummary = {
    id: row.id,
    employeeNo: row.employee_no,
    name: row.name,
    status: row.status as EmployeeSummary['status'],
    isOwner: row.is_owner,
    phoneMasked: maskPhone(row.phone),
    companies: parseCompanies(row.companies),
  };
  return { ...summary, version: row.version };
}

function sendEntity(reply: FastifyReply, entity: Employee): void {
  reply.header('ETag', etagOf(entity.version)).status(200).send(entity);
}

/** 创建员工（platform.employee.create）：201 + 实体；危险动作，AI 默认禁止。 */
export async function createEmployee(ctx: EmployeeWriteContext): Promise<Employee> {
  const ACTION = 'platform.employee.create';
  const database = requireWriteDatabase(ctx, ACTION);
  const principal = requirePrincipal(ctx.request);
  assertHumanCredential(principal);

  if (!allowsScope(principal.scope, 'employee', 'create')) {
    throw new AppError('FORBIDDEN', '缺少 employee.create 权限');
  }

  const input = parseCreateBody(ctx.request.body);
  const summary: Record<string, unknown> = {
    name: input.name,
    isOwner: input.isOwner ?? false,
    companyIds: dedupeIds(input.companyIds),
    positionIds: dedupeIds(input.positionIds),
  };
  // UUIDv7 应用侧生成（D55③）：事务前生成，审计 objectId 从第一条记录就是本员工。
  const newEmployeeId = uuidv7();

  const entity = await withAudit(
    database,
    auditEventOf(ctx.request, principal, ACTION, newEmployeeId, summary),
    async (tx) => {
      const callerIsOwner = await loadCallerIsOwner(tx, principal.employeeId, principal.tenantId);
      if (input.isOwner === true && !callerIsOwner) {
        throw new AppError('FORBIDDEN', '仅老板可以创建老板账号', { reason: 'ONLY_OWNER_GRANTS_OWNER' });
      }

      await assertPhoneAvailable(tx, input.phone, principal.tenantId, undefined);
      await validateCompanies(tx, input.companyIds, principal.tenantId);
      await validatePositions(tx, input.positionIds, principal.tenantId);
      const employeeNo = await takeEmployeeNo(tx, principal.tenantId);
      const id = newEmployeeId;

      await tx.query(
        `INSERT INTO employee (id, tenant_id, employee_no, phone, name, is_owner, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          principal.tenantId,
          employeeNo,
          input.phone,
          input.name,
          input.isOwner ?? false,
          principal.employeeId,
        ],
      );
      await insertBindings(tx, id, principal.tenantId, input.companyIds, input.positionIds);

      summary.employeeNo = employeeNo;
      return loadEmployeeEntity(tx, id, principal.tenantId);
    },
  );

  summary.employeeId = entity.id;
  ctx.reply.status(201).send(entity);
  return entity;
}

/** 修改员工（platform.employee.update）：If-Match 强制；改 isOwner 仅限人类且仅老板。 */
export async function updateEmployee(ctx: EmployeeWriteContext): Promise<Employee> {
  const ACTION = 'platform.employee.update';
  const database = requireWriteDatabase(ctx, ACTION);
  const principal = requirePrincipal(ctx.request);

  if (!allowsScope(principal.scope, 'employee', 'update')) {
    throw new AppError('FORBIDDEN', '缺少 employee.update 权限');
  }

  const id = parseIdParam(ctx.request, ACTION);
  const input = parseUpdateBody(ctx.request.body);
  const expectedVersion = requireIfMatchVersion(ctx.request);
  const summary: Record<string, unknown> = { employeeId: id, fields: Object.keys(input) };

  const entity = await withAudit(
    database,
    auditEventOf(ctx.request, principal, ACTION, id, summary),
    async (tx) => {
      const callerIsOwner = await loadCallerIsOwner(tx, principal.employeeId, principal.tenantId);
      const target = await loadTargetRow(tx, id, principal.tenantId);

      // 非老板不可改老板的资料（对齐 D50 边界精神；当前预设里只有老板有本权限）。
      if (target.is_owner && !callerIsOwner) {
        throw new AppError('FORBIDDEN', '不可修改老板账号', { reason: 'TARGET_IS_OWNER' });
      }

      // 契约：改 isOwner 属老板身份变更，必须由人类操作（字段级拦截，普通编辑对 AI 放行）。
      if (input.isOwner !== undefined) {
        if (principal.actorType === 'ai') {
          throw new AppError('AI_ACTION_FORBIDDEN', '老板标识只能由人类修改');
        }
        if (!callerIsOwner) {
          throw new AppError('FORBIDDEN', '仅老板可以变更老板标识', {
            reason: 'ONLY_OWNER_GRANTS_OWNER',
          });
        }
      }

      if (input.phone !== undefined && input.phone !== target.phone) {
        await assertPhoneAvailable(tx, input.phone, principal.tenantId, id);
      }

      const nextName = input.name ?? target.name;
      const nextPhone = input.phone ?? target.phone;
      const nextIsOwner = input.isOwner ?? target.is_owner;

      if (input.positionIds !== undefined || input.companyIds !== undefined) {
        // 两个维度独立全量替换：未提供的一维沿用现有绑定。
        const existing = await tx.query<{ company_id: string; position_id: string }>(
          `SELECT company_id, position_id FROM employee_company_position
            WHERE employee_id = $1 AND tenant_id = $2`,
          [id, principal.tenantId],
        );
        const existingPositionIds = [...new Set(existing.rows.map((row) => row.position_id))];
        const existingCompanyIds = [...new Set(existing.rows.map((row) => row.company_id))];
        const nextPositionIds = dedupeIds(input.positionIds ?? existingPositionIds);
        const nextCompanyIds = dedupeIds(input.companyIds ?? existingCompanyIds);
        await validateCompanies(tx, nextCompanyIds, principal.tenantId);
        await validatePositions(tx, nextPositionIds, principal.tenantId);
        await tx.query(
          `DELETE FROM employee_company_position
            WHERE employee_id = $1 AND tenant_id = $2`,
          [id, principal.tenantId],
        );
        await insertBindings(tx, id, principal.tenantId, nextCompanyIds, nextPositionIds);
        summary.companyIds = nextCompanyIds;
        summary.positionIds = nextPositionIds;
      }

      // 版本守卫兜并发：0 行 ⇒ 事务回滚，绑定替换一并撤销。
      const updated = await tx.query<{ version: number }>(
        `UPDATE employee
            SET name = $3, phone = $4, is_owner = $5, version = version + 1
          WHERE id = $1 AND tenant_id = $2 AND version = $6
          RETURNING version`,
        [id, principal.tenantId, nextName, nextPhone, nextIsOwner, expectedVersion],
      );
      if (updated.rows[0] === undefined) {
        throw new AppError('VERSION_CONFLICT', '员工已被并发修改，请重新读取后重试');
      }

      return loadEmployeeEntity(tx, id, principal.tenantId);
    },
  );

  summary.version = entity.version;
  sendEntity(ctx.reply, entity);
  return entity;
}

/**
 * 停用员工（platform.employee.disable）：软删除回实体；危险动作，AI 默认禁止。
 * 幂等：已停用再次停用直接成功（不再校验版本、不再自增，与 token.revoke 同口径）。
 * 最后一个在职老板不可停（防租户锁死）。
 */
export async function disableEmployee(ctx: EmployeeWriteContext): Promise<Employee> {
  const ACTION = 'platform.employee.disable';
  const database = requireWriteDatabase(ctx, ACTION);
  const principal = requirePrincipal(ctx.request);
  assertHumanCredential(principal);

  if (!allowsScope(principal.scope, 'employee', 'delete')) {
    throw new AppError('FORBIDDEN', '缺少 employee.delete 权限');
  }

  const id = parseIdParam(ctx.request, ACTION);
  const expectedVersion = requireIfMatchVersion(ctx.request);
  const summary: Record<string, unknown> = { employeeId: id };

  const entity = await withAudit(
    database,
    auditEventOf(ctx.request, principal, ACTION, id, summary),
    async (tx) => {
      const target = await loadTargetRow(tx, id, principal.tenantId);

      if (target.status === '停用') {
        // 幂等：已停用直接成功，不校验版本、不自增（客户端重试不应报冲突）。
        summary.idempotent = true;
        return loadEmployeeEntity(tx, id, principal.tenantId);
      }

      if (target.is_owner) {
        const others = await tx.query<{ count: string }>(
          `SELECT count(*) AS count FROM employee
            WHERE tenant_id = $1 AND is_owner AND status = '在职' AND id <> $2`,
          [principal.tenantId, id],
        );
        if (Number(others.rows[0]?.count ?? '0') === 0) {
          throw new AppError('FORBIDDEN', '不能停用最后一个在职老板', {
            reason: 'LAST_ACTIVE_OWNER',
          });
        }
      }

      const updated = await tx.query<{ version: number }>(
        `UPDATE employee
            SET status = '停用', disabled_at = now(), version = version + 1
          WHERE id = $1 AND tenant_id = $2 AND version = $3
          RETURNING version`,
        [id, principal.tenantId, expectedVersion],
      );
      if (updated.rows[0] === undefined) {
        throw new AppError('VERSION_CONFLICT', '员工已被并发修改，请重新读取后重试');
      }

      return loadEmployeeEntity(tx, id, principal.tenantId);
    },
  );

  summary.version = entity.version;
  sendEntity(ctx.reply, entity);
  return entity;
}
