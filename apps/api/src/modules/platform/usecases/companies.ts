import {
  AppError,
  CompanyCreateInputSchema,
  CompanyListQuerySchema,
  CompanyUpdateInputSchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  encodeCursor,
  etagOf,
  type Company,
  type CursorPayload,
} from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';

/**
 * 公司管理用例（platform.company.list / create / update，契约 companies.ts，2026-11-05 M1）。
 *
 * 口径（契约注释为准）：
 * - 公司码 4 位、租户内顺序递增、由服务端自动发放（D16）：取号走 `number_sequence`
 *   原子自增（与工号 D48 同一套机制，scope_key='company_code'，上限 9999，禁止回绕）；
 *   入参不接收 code（strict），更新也不可改公司码；
 * - 列表普通读不记审计（D54②），需 `company.read`；
 * - 写操作 100% 审计（D51），objectType='company'；新建公司 AI 默认禁止（D54⑥）；
 * - update 强制 If-Match 强 ETag（D60③），版本守卫兜并发；
 * - 本用例在模块内实现取号 SQL、不动 `platform/numbering` 内核（那里只有单据号 / 工号）。
 */

const OBJECT_TYPE = 'company';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 公司码取号的计数键（租户级、不按月重置：公司码是永久递增的隔离标识）。 */
const COMPANY_CODE_SCOPE_KEY = 'company_code';
const COMPANY_CODE_MAX = 9999;

interface CompanyRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CompanyContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
  readonly reply?: FastifyReply;
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

function requireDatabase(ctx: CompanyContext, action: string): Database {
  if (!ctx.database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${action} 不可用`, { operationId: action });
  }
  return ctx.database;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** If-Match 强制（契约 requiresIfMatch=true）：缺失 → 428；格式非法 → 409。 */
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

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapRow(row: CompanyRow): Company {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
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

function sendEntity(reply: FastifyReply, entity: Company): void {
  reply.header('ETag', etagOf(entity.version)).status(200).send(entity);
}

async function loadCompanyEntity(tx: SqlClient, id: string, tenantId: string): Promise<Company> {
  const result = await tx.query<CompanyRow>(
    `SELECT id, tenant_id, code, name, version, created_at, updated_at
       FROM company WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('NOT_FOUND', '公司不存在或不属于本租户');
  return mapRow(row);
}

/**
 * D16 公司码：4 位、租户内顺序递增、服务端自动发放。
 * 与工号（D48）同一套「单行原子自增」机制；容量耗尽显式失败、禁止回绕。
 * 这里不动 numbering 内核，SQL 与 `takeEmployeeNo` 保持同一形状。
 *
 * 前置对账：序列行缺失时（存量公司不经取号创建，如 seed / 历史数据），
 * 先用现有最大公司码初始化，避免从 0001 起号撞 `company_tenant_code_key`。
 * 初始化用 ON CONFLICT DO NOTHING，与后续原子自增在并发下依然安全。
 */
async function takeCompanyCode(tx: SqlClient, tenantId: string): Promise<string> {
  await tx.query(
    `INSERT INTO number_sequence (tenant_id, scope_key, last_value)
     SELECT tenant_id, $2, max(code::int)
       FROM company
      WHERE tenant_id = $1
      GROUP BY tenant_id
     ON CONFLICT (tenant_id, scope_key) DO NOTHING`,
    [tenantId, COMPANY_CODE_SCOPE_KEY],
  );
  const result = await tx.query<{ last_value: number }>(
    `INSERT INTO number_sequence (tenant_id, scope_key, last_value)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, scope_key) DO UPDATE
       SET last_value = number_sequence.last_value + 1,
           updated_at = now()
       WHERE number_sequence.last_value < $3
     RETURNING last_value`,
    [tenantId, COMPANY_CODE_SCOPE_KEY, COMPANY_CODE_MAX],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('VALIDATION_FAILED', `公司码已用满 ${COMPANY_CODE_MAX}，需扩容后再建公司`, {
      tenantId,
      scopeKey: COMPANY_CODE_SCOPE_KEY,
    });
  }
  return String(Number(row.last_value)).padStart(4, '0');
}

/** 公司列表：租户内全量（scope=company.read 把关），cursor 分页按 id 倒序。 */
export async function listCompanies(
  ctx: CompanyContext,
): Promise<{ items: Company[]; nextCursor: string | null }> {
  const ACTION = 'platform.company.list';
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, ACTION);

  if (!allowsScope(principal.scope, 'company', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 company.read 权限');
  }

  const parsed = CompanyListQuerySchema.safeParse(ctx.request.query);
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
  const limit = clampLimit(parsed.data.limit);

  const rows = await withTenant(database, principal.tenantId, async (tx) => {
    const params: unknown[] = [principal.tenantId];
    const where: string[] = ['tenant_id = $1'];
    if (cursor !== undefined) {
      params.push(cursor.id);
      where.push(`id < $${params.length}::uuid`);
    }
    params.push(limit + 1);
    const result = await tx.query<CompanyRow>(
      `SELECT id, tenant_id, code, name, version, created_at, updated_at
         FROM company
        WHERE ${where.join('\n          AND ')}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(mapRow);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: toDate(last.created_at).toISOString(), id: last.id })
      : null;

  // D54②：普通读不记审计。
  return { items, nextCursor };
}

/** 新建公司：公司码 D16 自动发放；AI 默认禁止；201 + 实体 + 审计。 */
export async function createCompany(ctx: CompanyContext): Promise<Company> {
  const ACTION = 'platform.company.create';
  const database = requireDatabase(ctx, ACTION);
  const principal = requirePrincipal(ctx.request);

  // 契约 ai.policy=forbid（D54⑥）：新建公司属高影响动作，AI 不得执行。
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接新建公司');
  }
  if (!allowsScope(principal.scope, 'company', 'create')) {
    throw new AppError('FORBIDDEN', '缺少 company.create 权限');
  }

  const parsed = CompanyCreateInputSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '创建公司入参不合法', { issues: issuesOf(parsed.error) });
  }
  const summary: Record<string, unknown> = { name: parsed.data.name };
  // UUIDv7 应用侧生成（D55③）：审计 objectId 从第一条记录就是本公司。
  const newCompanyId = uuidv7();

  const entity = await withAudit(
    database,
    auditEventOf(ctx.request, principal, ACTION, newCompanyId, summary),
    async (tx) => {
      const code = await takeCompanyCode(tx, principal.tenantId);
      await tx.query(
        `INSERT INTO company (id, tenant_id, name, code)
         VALUES ($1, $2, $3, $4)`,
        [newCompanyId, principal.tenantId, parsed.data.name, code],
      );
      summary.code = code;
      return loadCompanyEntity(tx, newCompanyId, principal.tenantId);
    },
  );

  summary.companyId = entity.id;
  if (ctx.reply) ctx.reply.status(201).send(entity);
  return entity;
}

/** 修改公司名称：If-Match 强制；公司码不可改（strict 拒绝）；200 + 实体 + 审计。 */
export async function updateCompany(ctx: CompanyContext): Promise<Company> {
  const ACTION = 'platform.company.update';
  const database = requireDatabase(ctx, ACTION);
  const principal = requirePrincipal(ctx.request);

  if (!allowsScope(principal.scope, 'company', 'update')) {
    throw new AppError('FORBIDDEN', '缺少 company.update 权限');
  }

  const params = ctx.request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id', operationId: ACTION });
  }

  const parsed = CompanyUpdateInputSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '修改公司入参不合法', { issues: issuesOf(parsed.error) });
  }
  const expectedVersion = requireIfMatchVersion(ctx.request);
  const summary: Record<string, unknown> = { companyId: id, fields: Object.keys(parsed.data) };

  const entity = await withAudit(
    database,
    auditEventOf(ctx.request, principal, ACTION, id, summary),
    async (tx) => {
      // 版本守卫兜并发：0 行 ⇒ 公司不存在 / 非本租户 / 已被并发修改，事务回滚。
      // 公司不存在与版本冲突在这里可区分（先查存在性，避免 404 被误报成 409）。
      const existing = await tx.query<{ version: number }>(
        'SELECT version FROM company WHERE id = $1 AND tenant_id = $2',
        [id, principal.tenantId],
      );
      if (existing.rows[0] === undefined) {
        throw new AppError('NOT_FOUND', '公司不存在或不属于本租户');
      }

      const updated = await tx.query<{ version: number; updated_at: Date | string }>(
        `UPDATE company
            SET name = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND version = $4
          RETURNING version, updated_at`,
        [id, principal.tenantId, parsed.data.name, expectedVersion],
      );
      if (updated.rows[0] === undefined) {
        throw new AppError('VERSION_CONFLICT', '公司已被并发修改，请重新读取后重试');
      }

      return loadCompanyEntity(tx, id, principal.tenantId);
    },
  );

  summary.version = entity.version;
  if (ctx.reply) sendEntity(ctx.reply, entity);
  return entity;
}
