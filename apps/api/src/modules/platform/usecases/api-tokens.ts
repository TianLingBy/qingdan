import { createHash, randomBytes } from 'node:crypto';
import {
  AppError,
  PageQuerySchema,
  ScopeMatrixSchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  encodeCursor,
  scopeIsSubset,
  type ApiToken,
  type ApiTokenCreated,
  type CursorPayload,
  type ScopeMatrix,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { recordAudit, withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import type { Database } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';

/**
 * API Token 用例（D52 / D52.1 / D54）。
 *
 * - create：scope 必须是创建人当前生效权限的子集，超出 **直接 403**，不静默裁剪（D52.1①）；
 *   明文令牌只返回一次，库里只存 sha256 与 8 位前缀；写操作与审计同事务（D51 / D55⑤）。
 * - read：敏感读必记审计（D54②），游标分页、按 id 倒序、租户内，响应不含 hash / 明文。
 * - revoke：强 ETag `"<version>"`；缺 If-Match → 428，不匹配 → 409；重复撤销幂等成功。
 */

const CREATE_ACTION = 'platform.token.create';
const READ_ACTION = 'platform.token.read';
const REVOKE_ACTION = 'platform.token.revoke';
const OBJECT_TYPE = 'api_token';
const TOKEN_SECRET_BYTES = 32;
const TOKEN_PREFIX_LENGTH = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApiTokenContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface ApiTokenCreateContext extends ApiTokenContext {
  readonly reply: FastifyReply;
}

export interface ApiTokenRevokeContext extends ApiTokenContext {
  readonly reply: FastifyReply;
}

interface ApiTokenRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  name: string;
  scope: unknown;
  expires_at: Date | string | null;
  ip_allowlist: string[] | null;
  last_used_at: Date | string | null;
  status: string;
  version: number;
  created_by: string;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

interface CreatedTokenRow {
  created_at: Date | string;
}

interface RevokeRow {
  employee_id: string;
  status: string;
  version: number;
}

interface CreateTokenInput {
  readonly name: string;
  readonly employeeId: string;
  readonly scope: ScopeMatrix;
  readonly expiresAt: Date | null;
  readonly ipAllowlist: string[];
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string | null): string | null {
  return value === null ? null : toDate(value).toISOString();
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: ApiTokenContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, { operationId });
  }
  return database;
}

/** AI 凭证不得创建 / 撤销 Token（契约 `ai.policy = forbid`，D54⑥）。 */
function assertHumanCredential(principal: Principal): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接创建或撤销 API Token');
  }
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseScope(raw: unknown): ScopeMatrix {
  const parsed = ScopeMatrixSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'scope 不合法', {
      field: 'scope',
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

function parseCreateBody(body: unknown): CreateTokenInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象');
  }
  const record = body as Record<string, unknown>;

  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name.length === 0 || name.length > 64) {
    throw new AppError('VALIDATION_FAILED', 'name 必须为 1–64 个字符', { field: 'name' });
  }

  if (typeof record.employeeId !== 'string' || !UUID_RE.test(record.employeeId)) {
    throw new AppError('VALIDATION_FAILED', 'employeeId 必须是合法 uuid', { field: 'employeeId' });
  }

  const scope = parseScope(record.scope);

  let expiresAt: Date | null = null;
  if (record.expiresAt !== undefined && record.expiresAt !== null) {
    if (typeof record.expiresAt !== 'string') {
      throw new AppError('VALIDATION_FAILED', 'expiresAt 必须是 ISO 8601 字符串或 null', {
        field: 'expiresAt',
      });
    }
    const parsed = new Date(record.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError('VALIDATION_FAILED', 'expiresAt 不是合法时间', { field: 'expiresAt' });
    }
    expiresAt = parsed;
  }

  let ipAllowlist: string[] = [];
  if (record.ipAllowlist !== undefined && record.ipAllowlist !== null) {
    if (
      !Array.isArray(record.ipAllowlist) ||
      !record.ipAllowlist.every((entry) => typeof entry === 'string')
    ) {
      throw new AppError('VALIDATION_FAILED', 'ipAllowlist 必须是字符串数组', {
        field: 'ipAllowlist',
      });
    }
    ipAllowlist = [...record.ipAllowlist];
  }

  return { name, employeeId: record.employeeId, scope, expiresAt, ipAllowlist };
}

function parseIfMatchVersion(request: FastifyRequest): number {
  const raw = headerValue(request, 'if-match');
  if (raw === undefined || raw.trim() === '') {
    throw new AppError('PRECONDITION_REQUIRED', '撤销 Token 必须携带 If-Match（强 ETag "<version>"）');
  }
  const match = /^"([0-9]+)"$/.exec(raw.trim());
  if (!match) {
    throw new AppError('VERSION_CONFLICT', 'If-Match 格式不合法，应为强 ETag "<version>"', {
      ifMatch: raw,
    });
  }
  return Number(match[1]);
}

function parsePageQuery(request: FastifyRequest): { cursor?: CursorPayload; limit: number } {
  const parsed = PageQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '分页参数不合法', {
      issues: issuesOf(parsed.error),
    });
  }
  let cursor: CursorPayload | undefined;
  if (parsed.data.cursor !== undefined) {
    cursor = decodeCursor(parsed.data.cursor);
    if (!UUID_RE.test(cursor.id)) {
      throw new AppError('VALIDATION_FAILED', 'cursor 内容不合法', { field: 'cursor' });
    }
  }
  return { cursor, limit: clampLimit(parsed.data.limit) };
}

function normalizeScope(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function mapTokenRow(row: ApiTokenRow): ApiToken {
  const scope = ScopeMatrixSchema.safeParse(normalizeScope(row.scope));
  if (!scope.success) {
    throw new AppError('INTERNAL_ERROR', 'API Token scope 数据不合法', { tokenId: row.id });
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    employeeId: row.employee_id,
    name: row.name,
    scope: scope.data,
    expiresAt: toIso(row.expires_at),
    ipAllowlist: row.ip_allowlist ?? [],
    lastUsedAt: toIso(row.last_used_at),
    status: row.status as ApiToken['status'],
    version: row.version,
    createdBy: row.created_by,
    revokedAt: toIso(row.revoked_at),
    createdAt: toDate(row.created_at).toISOString(),
  };
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  action: string,
  objectId: string | null,
  changeSummary?: Record<string, unknown>,
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
    changeSummary: changeSummary ?? null,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: headerValue(request, 'user-agent') ?? null,
    reason: request.auditReason,
  };
}

function tokenSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 创建 Token：201 + 一次性明文 + 同事务审计。 */
export async function createApiToken(ctx: ApiTokenCreateContext): Promise<ApiTokenCreated> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, CREATE_ACTION);
  assertHumanCredential(principal);

  const input = parseCreateBody(ctx.request.body);

  // 代建需要 api_integration.create；本人建自己的 Token 不受此限。
  if (
    input.employeeId !== principal.employeeId &&
    !allowsScope(principal.scope, 'api_integration', 'create')
  ) {
    throw new AppError('FORBIDDEN', '只有本人或拥有 api_integration.create 权限的人可以代建 Token');
  }

  // D52.1①：scope 必须是创建人当前生效权限的子集，超出直接拒绝，绝不静默裁剪。
  if (!scopeIsSubset(input.scope, principal.scope)) {
    throw new AppError('FORBIDDEN', '请求的 scope 超出创建人当前生效权限', {
      requested: input.scope,
    });
  }

  const id = uuidv7();
  const secret = randomBytes(TOKEN_SECRET_BYTES).toString('hex');
  const auditEvent = auditEventOf(ctx.request, principal, CREATE_ACTION, id, {
    name: input.name,
    employeeId: input.employeeId,
    scope: input.scope,
  });

  const createdAt = await withAudit(database, auditEvent, async (tx) => {
    // 目标员工必须同租户且在「在职」；RLS 之外再显式带 tenant_id，避免越权代建。
    const employee = await tx.query<{ status: string }>(
      'SELECT status FROM employee WHERE id = $1 AND tenant_id = $2',
      [input.employeeId, principal.tenantId],
    );
    const target = employee.rows[0];
    if (!target) throw new AppError('NOT_FOUND', '目标员工不存在');
    if (target.status !== '在职') {
      throw new AppError('FORBIDDEN', '目标员工不在职，不能为其创建 Token');
    }

    const inserted = await tx.query<CreatedTokenRow>(
      `INSERT INTO api_token
         (id, tenant_id, employee_id, name, scope, token_hash, token_prefix,
          expires_at, ip_allowlist, status, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 'active', $10)
       RETURNING created_at`,
      [
        id,
        principal.tenantId,
        input.employeeId,
        input.name,
        JSON.stringify(input.scope),
        tokenSecretHash(secret),
        secret.slice(0, TOKEN_PREFIX_LENGTH),
        input.expiresAt,
        input.ipAllowlist,
        principal.employeeId,
      ],
    );
    return inserted.rows[0]!.created_at;
  });

  ctx.reply.status(201);
  return {
    id,
    tenantId: principal.tenantId,
    employeeId: input.employeeId,
    name: input.name,
    scope: input.scope,
    expiresAt: input.expiresAt === null ? null : input.expiresAt.toISOString(),
    ipAllowlist: input.ipAllowlist,
    lastUsedAt: null,
    status: 'active',
    version: 1,
    createdBy: principal.employeeId,
    revokedAt: null,
    createdAt: toDate(createdAt).toISOString(),
    secret,
  };
}

/** Token 列表：敏感读，租户内按 id 倒序，游标分页，不返回 hash / 明文。 */
export async function listApiTokens(ctx: ApiTokenContext): Promise<{
  items: ApiToken[];
  nextCursor: string | null;
}> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, READ_ACTION);
  if (!allowsScope(principal.scope, 'api_integration', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 api_integration.read 权限');
  }

  const { cursor, limit } = parsePageQuery(ctx.request);

  const rows = await database.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [principal.tenantId]);
    const params: unknown[] = [principal.tenantId];
    let where = 'tenant_id = $1';
    if (cursor) {
      params.push(cursor.id);
      where += ` AND id < $${params.length}::uuid`;
    }
    params.push(limit + 1);
    const result = await tx.query<ApiTokenRow>(
      `SELECT * FROM api_token
        WHERE ${where}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(mapTokenRow);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: toDate(last.created_at).toISOString(), id: last.id })
      : null;

  // D54②：看 Token 列表属敏感读，每次成功查询都记一条审计。
  await recordAudit(
    database,
    auditEventOf(ctx.request, principal, READ_ACTION, null, {
      limit,
      cursor: cursor ?? null,
      returned: items.length,
    }),
  );

  return { items, nextCursor };
}

/**
 * 撤销 Token：强 ETag `"<version>"`。
 * 缺失 → 428；格式错 / 版本不匹配 → 409；已撤销时幂等成功（仍记一条审计）。
 */
export async function revokeApiToken(ctx: ApiTokenRevokeContext): Promise<void> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, REVOKE_ACTION);
  assertHumanCredential(principal);

  const params = ctx.request.params as { id?: unknown };
  const tokenId = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(tokenId)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id' });
  }
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const auditEvent = auditEventOf(ctx.request, principal, REVOKE_ACTION, tokenId);

  await withAudit(database, auditEvent, async (tx) => {
    const found = await tx.query<RevokeRow>(
      'SELECT employee_id, status, version FROM api_token WHERE id = $1 AND tenant_id = $2',
      [tokenId, principal.tenantId],
    );
    const token = found.rows[0];
    if (!token) throw new AppError('NOT_FOUND', 'Token 不存在');

    // 本人可撤销自己的 Token；撤销他人的需要 api_integration.delete。
    if (
      token.employee_id !== principal.employeeId &&
      !allowsScope(principal.scope, 'api_integration', 'delete')
    ) {
      throw new AppError('FORBIDDEN', '只有本人或拥有 api_integration.delete 权限的人可以撤销 Token');
    }

    // 幂等：已撤销直接成功，不再校验版本（客户端重试同一 If-Match 不应报冲突）。
    if (token.status === 'revoked') return;

    if (token.version !== expectedVersion) {
      throw new AppError('VERSION_CONFLICT', 'Token 版本与 If-Match 不一致，请重新读取后重试', {
        expected: expectedVersion,
        current: token.version,
      });
    }

    const updated = await tx.query<{ id: string }>(
      `UPDATE api_token
          SET status = 'revoked',
              revoked_at = now(),
              version = version + 1
        WHERE id = $1 AND tenant_id = $2 AND version = $3
        RETURNING id`,
      [tokenId, principal.tenantId, expectedVersion],
    );
    if (updated.rows.length === 0) {
      throw new AppError('VERSION_CONFLICT', 'Token 已被并发修改，请重新读取后重试');
    }
  });

  ctx.reply.status(204).send();
}
