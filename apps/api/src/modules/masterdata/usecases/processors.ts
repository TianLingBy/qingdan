import {
  AppError,
  ProcessorCreateInputSchema,
  ProcessorListQuerySchema,
  ProcessorQuoteCreateInputSchema,
  ProcessorQuoteListQuerySchema,
  ProcessorUpdateInputSchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  etagOf,
  type CursorPayload,
  type Processor,
  type ProcessorCreateInput,
  type ProcessorQuote,
  type ProcessorQuoteCreateInput,
  type ProcessorUpdateInput,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import * as repo from '../repo-processors.js';

/**
 * 加工厂 + 报价记录用例（D15 / D49 / D51 / D52① / D54② / D64）。
 *
 * - 权限：`processor.read|create|update|delete`（走认证层现算好的 `principal.scope`）；
 * - 公司隔离（D15）：读改删由 repo 带可见公司集合，跨公司等同不存在；创建显式校验归属公司；
 * - 审计（D51 / D54②）：加工厂 create / update / delete、报价 create 与业务同事务写；普通读不写；
 * - 编号（D49）：processorNo 自由文本、可空，本层不做唯一性校验；
 * - 报价（D64④）：只增不改——本文件不导出 update / delete 用例；
 * - 比价（D64③）：listQuotes 按 processName + 日期区间过滤，repo 按 unitPrice 升序返回；
 *   契约没有 sort 字段，排序由过滤条件（带 processName）自动启用，不额外加契约参数；
 * - 单价（D54）：decimal 字符串原样进出，不转 number；
 * - 停用是危险动作（D52① / D54⑥）：AI 凭证默认拒绝，照 platform 现有 `assertHumanCredential` 写法。
 */

const PROCESSOR_OBJECT_TYPE = 'processor';
const QUOTE_OBJECT_TYPE = 'processor_quote';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 写操作的审计事件需要在事务内回填 companyId / 变更摘要（同 customers / products / suppliers）。 */
type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface ProcessorContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface ProcessorWriteContext extends ProcessorContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly status?: Processor['status'];
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

interface ParsedQuoteListQuery {
  readonly processorId?: string;
  readonly processName?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: ProcessorContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, { operationId });
  }
  return database;
}

/** scope = domain.action（D50/D52）；权限引擎已在认证层合并岗位基线 ⊕ 个人覆盖 ∩ token scope。 */
function requireScope(
  principal: Principal,
  action: 'read' | 'create' | 'update' | 'delete',
): void {
  if (!allowsScope(principal.scope, 'processor', action)) {
    throw new AppError('FORBIDDEN', `缺少 processor.${action} 权限`);
  }
}

/** D15：创建必须落在调用者可见公司集合内（服务端判定，前端传参不能放大）。 */
function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该加工厂所属公司无权限', { companyId });
  }
}

/** AI 不得直接执行危险动作（D52① / D54⑥）；与 platform 现有危险动作处理一致。 */
function assertHumanCredential(principal: Principal): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接停用加工厂，需人类审批');
  }
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function decodePageCursor(raw: string | undefined): CursorPayload | undefined {
  if (raw === undefined) return undefined;
  const cursor = decodeCursor(raw);
  if (!UUID_RE.test(cursor.id)) {
    throw new AppError('VALIDATION_FAILED', 'cursor 内容不合法', { field: 'cursor' });
  }
  return cursor;
}

function parseListQuery(request: FastifyRequest): ParsedListQuery {
  const parsed = ProcessorListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', { issues: issuesOf(parsed.error) });
  }
  return {
    companyId: parsed.data.companyId,
    status: parsed.data.status,
    keyword: parsed.data.keyword,
    cursor: decodePageCursor(parsed.data.cursor),
    limit: clampLimit(parsed.data.limit),
  };
}

function parseQuoteListQuery(request: FastifyRequest): ParsedQuoteListQuery {
  const parsed = ProcessorQuoteListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', { issues: issuesOf(parsed.error) });
  }
  return {
    processorId: parsed.data.processorId,
    processName: parsed.data.processName,
    from: parsed.data.from,
    to: parsed.data.to,
    cursor: decodePageCursor(parsed.data.cursor),
    limit: clampLimit(parsed.data.limit),
  };
}

function parseProcessorId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id' });
  }
  return id;
}

function parseCreateInput(body: unknown): ProcessorCreateInput {
  const parsed = ProcessorCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

function parseUpdateInput(body: unknown): ProcessorUpdateInput {
  const parsed = ProcessorUpdateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

function parseQuoteCreateInput(body: unknown): ProcessorQuoteCreateInput {
  const parsed = ProcessorQuoteCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  if (!UUID_RE.test(parsed.data.processorId)) {
    throw new AppError('VALIDATION_FAILED', 'processorId 必须是合法 uuid', {
      field: 'processorId',
    });
  }
  return parsed.data;
}

/** 强 ETag `"<version>"`；缺失 → 428，格式非法 → 409（与 api-tokens revoke 一致）。 */
function parseIfMatchVersion(request: FastifyRequest): number {
  const raw = headerValue(request, 'if-match');
  if (raw === undefined || raw.trim() === '') {
    throw new AppError('PRECONDITION_REQUIRED', '该操作必须携带 If-Match（强 ETag "<version>"）');
  }
  const match = /^"([0-9]+)"$/.exec(raw.trim());
  if (!match) {
    throw new AppError('VERSION_CONFLICT', 'If-Match 格式不合法，应为强 ETag "<version>"', {
      ifMatch: raw,
    });
  }
  return Number(match[1]);
}

function repoContext(tx: SqlClient, principal: Principal): repo.ProcessorRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  action: string,
  objectType: string,
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
    action,
    objectType,
    objectId,
    changeSummary,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: headerValue(request, 'user-agent') ?? null,
    reason: request.auditReason,
  };
}

/**
 * 加工厂列表（普通读，不记审计 D54②）。
 * `keyword` 只匹配名称/联系人（D49）；不可见公司一律返回空列表。
 */
export async function listProcessors(
  ctx: ProcessorContext,
): Promise<{ items: Processor[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processor.list.read');
  requireScope(principal, 'read');

  const query = parseListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listProcessors(repoContext(tx, principal), query),
  );
}

/** 加工厂详情（普通读，不记审计）；跨公司 / 不存在统一 404。 */
export async function getProcessor(ctx: ProcessorContext): Promise<Processor> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processor.detail.read');
  requireScope(principal, 'read');

  const id = parseProcessorId(ctx.request);
  const processor = await withTenant(database, principal.tenantId, (tx) =>
    repo.getProcessor(repoContext(tx, principal), id),
  );
  if (!processor) throw new AppError('NOT_FOUND', '加工厂不存在');

  return processor;
}

/** 新增加工厂：201 + 同事务审计（D51）。 */
export async function createProcessor(ctx: ProcessorWriteContext): Promise<Processor> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processor.create');
  requireScope(principal, 'create');

  const input = parseCreateInput(ctx.request.body);
  assertCompanyVisible(principal, input.companyId);

  const id = uuidv7();
  const audit = auditEventOf(
    ctx.request,
    principal,
    'processor.create',
    PROCESSOR_OBJECT_TYPE,
    id,
    {
      companyId: input.companyId,
      name: input.name,
      processorNo: input.processorNo ?? null,
      contactName: input.contactName ?? null,
      status: input.status ?? '启用',
    },
  );
  // 归属公司在写入前已确定；update / delete 则在事务里回填。
  audit.companyId = input.companyId;

  const processor = await withAudit(database, audit, (tx) =>
    repo.insertProcessor(repoContext(tx, principal), { ...input, id }),
  );

  ctx.reply.status(201);
  return processor;
}

/** 修改加工厂：If-Match 强 ETag；成功后回新 ETag，并同事务记审计（D51）。 */
export async function updateProcessor(ctx: ProcessorWriteContext): Promise<Processor> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processor.update');
  requireScope(principal, 'update');

  const id = parseProcessorId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const input = parseUpdateInput(ctx.request.body);

  const audit = auditEventOf(
    ctx.request,
    principal,
    'processor.update',
    PROCESSOR_OBJECT_TYPE,
    id,
    { changedFields: Object.keys(input) },
  );

  const processor = await withAudit(database, audit, async (tx) => {
    const updated = await repo.updateProcessor(
      repoContext(tx, principal),
      id,
      input,
      expectedVersion,
    );
    if (!updated) throw new AppError('NOT_FOUND', '加工厂不存在');
    // 审计事件在 work 之后才序列化，这里回填归属公司。
    audit.companyId = updated.companyId;
    return updated;
  });

  ctx.reply.header('ETag', etagOf(processor.version));
  return processor;
}

/**
 * 停用加工厂（软删除）：只置 `status='停用'`，不物理删除。
 * 危险动作：AI 凭证默认拒绝（D52① / D54⑥）；If-Match 强 ETag；成功后回新 ETag。
 */
export async function deleteProcessor(ctx: ProcessorWriteContext): Promise<Processor> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processor.delete');
  requireScope(principal, 'delete');
  assertHumanCredential(principal);

  const id = parseProcessorId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const audit = auditEventOf(
    ctx.request,
    principal,
    'processor.delete',
    PROCESSOR_OBJECT_TYPE,
    id,
    { afterStatus: '停用' },
  );

  const processor = await withAudit(database, audit, async (tx) => {
    const updated = await repo.softDeleteProcessor(
      repoContext(tx, principal),
      id,
      expectedVersion,
    );
    if (!updated) throw new AppError('NOT_FOUND', '加工厂不存在');
    audit.companyId = updated.companyId;
    audit.changeSummary = { afterStatus: updated.status };
    return updated;
  });

  ctx.reply.header('ETag', etagOf(processor.version));
  return processor;
}

/**
 * 报价记录列表（普通读，不记审计 D54②；D64③ 比价）。
 * `processName` + `from` / `to` 跨加工厂过滤；带 `processName` 时 repo 按单价升序返回。
 */
export async function listQuotes(
  ctx: ProcessorContext,
): Promise<{ items: ProcessorQuote[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processor.quote.read');
  requireScope(principal, 'read');

  const query = parseQuoteListQuery(ctx.request);

  return withTenant(database, principal.tenantId, (tx) =>
    repo.listQuotes(repoContext(tx, principal), query),
  );
}

/**
 * 新增报价记录（D64④：只增不改）：201 + 同事务审计（D51）。
 *
 * 跨公司校验：加工厂必须对调用者可见（否则 404，不泄露存在性），
 * 且报价的 `companyId` 必须与加工厂归属公司一致（否则 422）。
 */
export async function createQuote(ctx: ProcessorWriteContext): Promise<ProcessorQuote> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'processor.quote.create');
  requireScope(principal, 'create');

  const input = parseQuoteCreateInput(ctx.request.body);
  assertCompanyVisible(principal, input.companyId);

  const id = uuidv7();
  const audit = auditEventOf(
    ctx.request,
    principal,
    'processor.quote.create',
    QUOTE_OBJECT_TYPE,
    id,
    {
      companyId: input.companyId,
      processorId: input.processorId,
      quoteDate: input.quoteDate,
      processName: input.processName,
      unitPrice: input.unitPrice,
      remark: input.remark ?? null,
    },
  );
  audit.companyId = input.companyId;

  const quote = await withAudit(database, audit, async (tx) => {
    const ctxRepo = repoContext(tx, principal);
    const processor = await repo.getProcessor(ctxRepo, input.processorId);
    if (!processor) {
      throw new AppError('NOT_FOUND', '加工厂不存在');
    }
    if (processor.companyId !== input.companyId) {
      throw new AppError('VALIDATION_FAILED', '报价归属公司与加工厂不一致', {
        field: 'companyId',
        processorId: input.processorId,
      });
    }
    return repo.insertQuote(ctxRepo, { ...input, id });
  });

  ctx.reply.status(201);
  return quote;
}
