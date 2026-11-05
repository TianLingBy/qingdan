import {
  AppError,
  ProductCreateInputSchema,
  ProductListQuerySchema,
  ProductUpdateInputSchema,
  allowsScope,
  clampLimit,
  decodeCursor,
  etagOf,
  type CursorPayload,
  type Product,
  type ProductCreateInput,
  type ProductUpdateInput,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import * as repo from '../repo.js';

/**
 * 商品用例（D15 / D27 / D49 / D51 / D52① / D54）。
 *
 * - 权限：`product.read|create|update|delete`（走认证层现算好的 `principal.scope`，与 employees 同款）；
 * - 公司隔离（D15）：读改删由 repo 带可见公司集合，跨公司等同不存在；创建显式校验归属公司；
 * - 审计（D51 / D54②）：create / update / delete 与业务同事务写；普通读不写；
 * - 看价（D27）：无 `product.view_price` 时 `defaultSalePrice` 返回 `null`（保留字段）；
 *   写默认售价同样要求看价权限（契约 `product.update` 摘要）；
 * - 停用是危险动作（D52① / D54⑥）：AI 凭证默认拒绝，照 platform 现有 `assertHumanCredential` 写法；
 * - 金额一律 decimal 字符串，repo 侧不转 number（D54）。
 */

const OBJECT_TYPE = 'product';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 写操作的审计事件需要在事务内回填 companyId / 变更摘要（同 permission-overrides 的做法）。 */
type MutableAuditEvent = { -readonly [K in keyof AuditEvent]: AuditEvent[K] };

export interface ProductContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface ProductWriteContext extends ProductContext {
  readonly reply: FastifyReply;
}

interface ParsedListQuery {
  readonly companyId?: string;
  readonly status?: Product['status'];
  readonly keyword?: string;
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

function requireDatabase(ctx: ProductContext, operationId: string): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${operationId} 不可用`, { operationId });
  }
  return database;
}

/** scope = domain.action（D50/D52）；权限引擎已在认证层合并岗位基线 ⊕ 个人覆盖 ∩ token scope。 */
function requireScope(principal: Principal, action: 'read' | 'create' | 'update' | 'delete'): void {
  if (!allowsScope(principal.scope, 'product', action)) {
    throw new AppError('FORBIDDEN', `缺少 product.${action} 权限`);
  }
}

/** D27 / D4.1：无看价权限时金额字段必须回 null（保留键，不省略）。 */
function canViewPrice(principal: Principal): boolean {
  return allowsScope(principal.scope, 'product', 'view_price');
}

function maskPrice(product: Product, viewPrice: boolean): Product {
  return viewPrice ? product : { ...product, defaultSalePrice: null };
}

/** 写默认售价也需要看价权限；只报字段名，不回显金额。 */
function assertPriceWriteAllowed(principal: Principal, input: ProductCreateInput | ProductUpdateInput): void {
  if (input.defaultSalePrice !== undefined && !canViewPrice(principal)) {
    throw new AppError('FORBIDDEN', '写入默认售价需要 product.view_price 权限', {
      field: 'defaultSalePrice',
    });
  }
}

/** D15：创建必须落在调用者可见公司集合内（服务端判定，前端传参不能放大）。 */
function assertCompanyVisible(principal: Principal, companyId: string): void {
  if (!principal.companyIds.includes(companyId)) {
    throw new AppError('FORBIDDEN', '调用者对该商品所属公司无权限', { companyId });
  }
}

/** AI 不得直接执行危险动作（D52① / D54⑥）；与 platform 现有危险动作处理一致。 */
function assertHumanCredential(principal: Principal): void {
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得直接停用商品，需人类审批');
  }
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseListQuery(request: FastifyRequest): ParsedListQuery {
  const parsed = ProductListQuerySchema.safeParse(request.query);
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
    status: parsed.data.status,
    keyword: parsed.data.keyword,
    cursor,
    limit: clampLimit(parsed.data.limit),
  };
}

function parseProductId(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  const id = typeof params.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id' });
  }
  return id;
}

function parseCreateInput(body: unknown): ProductCreateInput {
  const parsed = ProductCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

function parseUpdateInput(body: unknown): ProductUpdateInput {
  const parsed = ProductUpdateInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
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

function repoContext(tx: SqlClient, principal: Principal): repo.ProductRepoContext {
  return { tx, tenantId: principal.tenantId, companyIds: principal.companyIds };
}

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
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

/**
 * 商品列表（普通读，不记审计 D54②）。
 * `keyword` 只匹配名称/别名（D49）；不可见公司一律返回空列表。
 */
export async function listProducts(
  ctx: ProductContext,
): Promise<{ items: Product[]; nextCursor: string | null }> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'product.list.read');
  requireScope(principal, 'read');

  const query = parseListQuery(ctx.request);
  const viewPrice = canViewPrice(principal);

  const page = await withTenant(database, principal.tenantId, (tx) =>
    repo.listProducts(repoContext(tx, principal), query),
  );

  return { items: page.items.map((product) => maskPrice(product, viewPrice)), nextCursor: page.nextCursor };
}

/** 商品详情（普通读，不记审计）；跨公司 / 不存在统一 404。 */
export async function getProduct(ctx: ProductContext): Promise<Product> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'product.detail.read');
  requireScope(principal, 'read');

  const id = parseProductId(ctx.request);
  const product = await withTenant(database, principal.tenantId, (tx) =>
    repo.getProduct(repoContext(tx, principal), id),
  );
  if (!product) throw new AppError('NOT_FOUND', '商品不存在');

  return maskPrice(product, canViewPrice(principal));
}

/** 新增商品：201 + 同事务审计（D51）。 */
export async function createProduct(ctx: ProductWriteContext): Promise<Product> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'product.create');
  requireScope(principal, 'create');

  const input = parseCreateInput(ctx.request.body);
  assertCompanyVisible(principal, input.companyId);
  assertPriceWriteAllowed(principal, input);

  const id = uuidv7();
  const audit = auditEventOf(ctx.request, principal, 'product.create', id, {
    companyId: input.companyId,
    name: input.name,
    productNo: input.productNo ?? null,
    unit: input.unit,
    status: input.status ?? '启用',
    aliases: input.aliases ?? [],
    hasDefaultSalePrice: input.defaultSalePrice !== undefined && input.defaultSalePrice !== null,
  });
  // 归属公司在写入前已确定；update / delete 则在事务里回填。
  audit.companyId = input.companyId;

  const product = await withAudit(database, audit, (tx) =>
    repo.insertProduct(repoContext(tx, principal), { ...input, id }),
  );

  ctx.reply.status(201);
  return maskPrice(product, canViewPrice(principal));
}

/** 修改商品：If-Match 强 ETag；成功后回新 ETag，并同事务记审计（D51）。 */
export async function updateProduct(ctx: ProductWriteContext): Promise<Product> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'product.update');
  requireScope(principal, 'update');

  const id = parseProductId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);
  const input = parseUpdateInput(ctx.request.body);
  assertPriceWriteAllowed(principal, input);

  const audit = auditEventOf(ctx.request, principal, 'product.update', id, {
    changedFields: Object.keys(input),
  });

  const product = await withAudit(database, audit, async (tx) => {
    const updated = await repo.updateProduct(repoContext(tx, principal), id, input, expectedVersion);
    if (!updated) throw new AppError('NOT_FOUND', '商品不存在');
    // 审计事件在 work 之后才序列化，这里回填归属公司。
    audit.companyId = updated.companyId;
    return updated;
  });

  ctx.reply.header('ETag', etagOf(product.version));
  return maskPrice(product, canViewPrice(principal));
}

/**
 * 停用商品（软删除，D62⑤）：只置 `status='停用'`，不物理删除。
 * 危险动作：AI 凭证默认拒绝（D52① / D54⑥）；If-Match 强 ETag；成功后回新 ETag。
 */
export async function deleteProduct(ctx: ProductWriteContext): Promise<Product> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'product.delete');
  requireScope(principal, 'delete');
  assertHumanCredential(principal);

  const id = parseProductId(ctx.request);
  const expectedVersion = parseIfMatchVersion(ctx.request);

  const audit = auditEventOf(ctx.request, principal, 'product.delete', id, {
    afterStatus: '停用',
  });

  const product = await withAudit(database, audit, async (tx) => {
    const updated = await repo.softDeleteProduct(repoContext(tx, principal), id, expectedVersion);
    if (!updated) throw new AppError('NOT_FOUND', '商品不存在');
    audit.companyId = updated.companyId;
    audit.changeSummary = { afterStatus: updated.status };
    return updated;
  });

  ctx.reply.header('ETag', etagOf(product.version));
  return maskPrice(product, canViewPrice(principal));
}
