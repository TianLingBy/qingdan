import {
  AppError,
  ContactSummaryQuerySchema,
  ContactCreateInputSchema,
  ContactUpdateInputSchema,
  allowsScope,
  etagOf,
  type ContactCreateInput,
  type ContactUpdateInput,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { maskPhone } from '../../platform/usecases/employees.js';
import * as repo from '../repo-contacts.js';

/**
 * 对接人用例（#306 / 设计文档 §十一；D92 补句：对接人是档案从属数据，不单独立域）。
 *
 * - 权限：三个域各自复用既有动作 —— 读 `customer.read`，增删改 `customer.create|update|delete`；
 *   供应商 / 加工厂同构。**不新增任何 domain / action**；
 * - 公司隔离（D15）：读写都由 repo 带可见公司集合，跨公司等同不存在（404）；
 * - 审计（D51）：create / update / delete 与业务同事务写，objectType 记 `<域>_contact`；
 * - **删除 = 软停用**：用户语义是「删掉这个对接人」，实现是 `UPDATE status='停用'`
 *   （见 `repo.deactivateContact`），历史单据引用与姓名仍可读；
 * - 列表手机号脱敏（复用员工列表的 `maskPhone`：前 3 + `****` + 后 4），详情回完整；
 * - 汇总（§十二）：一条 SQL 聚合；**`totalAmount` 需要 `view_price`，无权限时键不出现**
 *   （不是 null、不是 0 —— 用条件展开而不是赋 undefined，避免 JSON 里留键）。
 */

type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface ContactContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface ContactWriteContext extends ContactContext {
  readonly reply: FastifyReply;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function requireDatabase(ctx: ContactContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, { operationId });
  }
  return database;
}

function requireScope(principal: Principal, kind: repo.ContactKind, action: 'read' | 'create' | 'update' | 'delete'): void {
  if (!allowsScope(principal.scope, kind, action)) {
    throw new AppError('FORBIDDEN', `缺少 ${kind}.${action} 权限`);
  }
}

/** AI 不得直接执行危险动作（D52① / D54⑥）：停用对接人与删除客户同款。 */
function assertHumanCredential(principal: Principal, label: string): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', `AI 不得直接停用${label}对接人，需人类审批`);
  }
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseUuidParam(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  const raw = params[name];
  const value = typeof raw === 'string' ? raw : '';
  if (!UUID_RE.test(value)) {
    throw new AppError('VALIDATION_FAILED', `${name} 必须是合法 uuid`, { field: name });
  }
  return value;
}

function parseCreateInput(body: unknown): ContactCreateInput {
  const parsed = ContactCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

function parseUpdateInput(body: unknown): ContactUpdateInput {
  const parsed = ContactUpdateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

/** 强 ETag `"<version>"`；缺失 → 428，格式非法 → 409（与客户写接口一致）。 */
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

function repoContext(tx: SqlClient, principal: Principal): repo.ContactRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
}

/** 对接人 → 响应体：归属档案字段按域改名（customerId / supplierId / processorId）。 */
function presentContact(
  kind: repo.ContactKind,
  contact: repo.ContactRecord,
): Record<string, unknown> {
  const { ownerId, ...rest } = contact;
  return { ...rest, [repo.CONTACT_SPECS[kind].ownerIdField]: ownerId };
}

/** 列表口径：去掉完整手机号，只回 `phoneMasked`（前 3 + `****` + 后 4）。 */
function presentContactMasked(
  kind: repo.ContactKind,
  contact: repo.ContactRecord,
): Record<string, unknown> {
  const { ownerId, phone, ...rest } = contact;
  return {
    ...rest,
    [repo.CONTACT_SPECS[kind].ownerIdField]: ownerId,
    phoneMasked: phone === null ? null : maskPhone(phone),
  };
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  kind: repo.ContactKind,
  action: string,
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
    objectType: `${kind}_contact`,
    objectId,
    changeSummary,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: headerValue(request, 'user-agent') ?? null,
    reason: request.auditReason,
  };
}

/** 档案不存在 / 不在可见公司 → 404（与档案详情同一口径）。 */
async function ownerCompanyOr404(
  ctx: ContactContext,
  principal: Principal,
  database: Database,
  kind: repo.ContactKind,
  ownerId: string,
): Promise<string> {
  const companyId = await withTenant(database, principal.tenantId, (tx) =>
    repo.findOwnerCompany(repoContext(tx, principal), kind, ownerId),
  );
  if (companyId === null) {
    throw new AppError('NOT_FOUND', `${repo.CONTACT_SPECS[kind].label}不存在`);
  }
  return companyId;
}

/** 对接人列表（普通读，不记审计 D54②）。 */
export async function listContacts(
  ctx: ContactContext,
  kind: repo.ContactKind,
): Promise<Array<Record<string, unknown>>> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, `${kind}.contact.list`);
  requireScope(principal, kind, 'read');

  const ownerId = parseUuidParam(ctx.request, 'id');
  const companyId = await ownerCompanyOr404(ctx, principal, database, kind, ownerId);
  const contacts = await withTenant(database, principal.tenantId, (tx) =>
    repo.listContacts(repoContext(tx, principal), kind, ownerId, companyId),
  );
  return contacts.map((contact) => presentContactMasked(kind, contact));
}

/** 新增对接人：201 + 同事务审计（D51）。 */
export async function createContact(
  ctx: ContactWriteContext,
  kind: repo.ContactKind,
): Promise<Record<string, unknown>> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, `${kind}.contact.create`);
  requireScope(principal, kind, 'create');

  const ownerId = parseUuidParam(ctx.request, 'id');
  const input = parseCreateInput(ctx.request.body);
  const companyId = await ownerCompanyOr404(ctx, principal, database, kind, ownerId);

  const id = uuidv7();
  const audit = auditEventOf(ctx.request, principal, kind, `${kind}.contact.create`, id, {
    name: input.name,
    isPrimary: input.isPrimary ?? false,
  });
  audit.companyId = companyId;

  const contact = await withAudit(database, audit, (tx) =>
    repo.insertContact(repoContext(tx, principal), kind, ownerId, companyId, { ...input, id }),
  );

  ctx.reply.status(201);
  ctx.reply.header('ETag', etagOf(contact.version));
  return presentContact(kind, contact);
}

/** 修改对接人：If-Match 强 ETag；成功后回新 ETag，并同事务记审计（D51）。 */
export async function updateContact(
  ctx: ContactWriteContext,
  kind: repo.ContactKind,
): Promise<Record<string, unknown>> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, `${kind}.contact.update`);
  requireScope(principal, kind, 'update');

  const contactId = parseUuidParam(ctx.request, 'contactId');
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const input = parseUpdateInput(ctx.request.body);

  const audit = auditEventOf(ctx.request, principal, kind, `${kind}.contact.update`, contactId, {
    changedFields: Object.keys(input),
  });

  const contact = await withAudit(database, audit, async (tx) => {
    const updated = await repo.updateContact(
      repoContext(tx, principal),
      kind,
      contactId,
      input,
      expectedVersion,
    );
    if (!updated) throw new AppError('NOT_FOUND', '对接人不存在');
    audit.companyId = updated.companyId;
    return updated;
  });

  ctx.reply.header('ETag', etagOf(contact.version));
  return presentContact(kind, contact);
}

/**
 * 「删除」对接人 —— **实现是软停用**（`status='停用'`）。
 *
 * 契约里 action 仍是 `delete`：用户点的是「删除这个对接人」，权限点也该是 `delete`；
 * 但行不能删——单据上的 `*_contact_id` 是 ON DELETE RESTRICT 引用，删了历史单就读不到
 * 「这次是谁来下的单」。所以这里只翻状态，回被停用的实体快照 + 新 ETag。
 * 危险动作：AI 凭证默认拒绝（D52① / D54⑥）。
 */
export async function deleteContact(
  ctx: ContactWriteContext,
  kind: repo.ContactKind,
): Promise<Record<string, unknown>> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, `${kind}.contact.delete`);
  requireScope(principal, kind, 'delete');
  assertHumanCredential(principal, repo.CONTACT_SPECS[kind].label);

  const contactId = parseUuidParam(ctx.request, 'contactId');
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const audit = auditEventOf(ctx.request, principal, kind, `${kind}.contact.delete`, contactId, {
    deactivated: true,
  });

  const contact = await withAudit(database, audit, async (tx) => {
    const deactivated = await repo.deactivateContact(
      repoContext(tx, principal),
      kind,
      contactId,
      expectedVersion,
    );
    if (!deactivated) throw new AppError('NOT_FOUND', '对接人不存在');
    audit.companyId = deactivated.companyId;
    audit.changeSummary = { deactivated: true, name: deactivated.name, status: deactivated.status };
    return deactivated;
  });

  ctx.reply.header('ETag', etagOf(contact.version));
  return presentContact(kind, contact);
}

/**
 * 档案汇总（§十二）：单数 / 累计金额 / 最后一单时间 / 最近 10 单 / 对接人。
 *
 * - 只统计本公司、`status <> '已取消'`；
 * - 一条 SQL 聚合（`repo.aggregateSummary`），没有循环查询；
 * - `totalAmount` 与每条 `recentOrders[].totalAmount` 需要 `view_price`：
 *   **无权限时键不出现**（条件展开，而不是写 null / 0）。
 */
export async function getSummary(
  ctx: ContactContext,
  kind: repo.ContactKind,
): Promise<Record<string, unknown>> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, `${kind}.summary.read`);
  requireScope(principal, kind, 'read');

  const ownerId = parseUuidParam(ctx.request, 'id');
  const companyId = await ownerCompanyOr404(ctx, principal, database, kind, ownerId);
  // `?groupBy=contact` 时才多跑一次按对接人聚合。放在同一个事务里，两次聚合
  // 看到的是同一快照——否则并发下单会让「分项之和 ≠ 总数」，而这条正是分组的
  // 唯一用途（拿分项去核对总数）。
  // 用契约 schema 解析而不是直接摸 `request.query.groupBy`：`request.query` 在这里
  // 的类型是 `{}`，直接下标访问要写类型断言；而 safeParse 顺带把非法值挡成 422。
  const summaryQuery = ContactSummaryQuerySchema.safeParse(ctx.request.query);
  if (!summaryQuery.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数不合法', {
      issues: summaryQuery.error.issues,
    });
  }
  const wantGroups = summaryQuery.data.groupBy === 'contact';
  const summary = await withTenant(database, principal.tenantId, async (tx) => {
    const context = repoContext(tx, principal);
    const detail = await repo.aggregateSummary(context, kind, ownerId, companyId);
    const groups = wantGroups
      ? await repo.aggregateByContact(context, kind, ownerId, companyId)
      : null;
    return { detail, groups };
  });
  const detail = summary.detail;
  const groups = summary.groups;

  const withAmount = allowsScope(principal.scope, kind, 'view_price');
  return {
    orderCount: detail.orderCount,
    ...(withAmount ? { totalAmount: detail.totalAmount ?? '0' } : {}),
    lastOrderAt: detail.lastOrderAt,
    recentOrders: detail.recentOrders.map((order) => ({
      id: order.id,
      orderNo: order.orderNo,
      status: order.status,
      ...(withAmount ? { totalAmount: order.totalAmount } : {}),
      createdAt: order.createdAt,
      contactId: order.contactId,
      contactName: order.contactName,
    })),
    contacts: detail.contacts.map((contact) => presentContact(kind, contact)),
    ...(groups === null
      ? {}
      : {
          contactGroups: groups.map((group) => ({
            contactId: group.contactId,
            contactName: group.contactName,
            orderCount: group.orderCount,
            ...(withAmount ? { totalAmount: group.totalAmount ?? '0' } : {}),
            lastOrderAt: group.lastOrderAt,
          })),
        }),
  };
}
