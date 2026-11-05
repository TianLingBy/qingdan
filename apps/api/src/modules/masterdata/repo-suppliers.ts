import {
  AppError,
  encodeCursor,
  type CursorPayload,
  type Supplier,
  type SupplierCreateInput,
  type SupplierUpdateInput,
} from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 供应商数据访问层（D15 / D49）。
 *
 * - 隔离：所有查询都带 `tenant_id` + `company_id = ANY(可见公司集合)`，跨公司行等同不存在；
 * - 检索（D49）：`keyword` 只匹配 `name` / `contact_name` / `contact_phone`，
 *   **不按 `supplier_no` 检索**；
 * - 分页：与商品 / 客户一致的 keyset（按 uuidv7 `id DESC`）+ 不透明游标；
 * - 供货物料：`text[]` 经驱动返回数组，这里兜底空数组；条目上限由应用层契约校验；
 * - 写：版本不匹配由 repo 抛 `VERSION_CONFLICT`，查不到返回 `null`（由用例映射 404）。
 *
 * repo 只接收调用方已开好的事务（`tx`）：create / update / delete 需要与审计同事务（D51 / D55⑤）。
 */

export interface SupplierRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface SupplierListQuery {
  readonly companyId?: string;
  readonly status?: Supplier['status'];
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 创建输入 = 契约创建体 + 用例生成的 uuid（审计需要提前知道 objectId）。 */
export type SupplierInsertInput = SupplierCreateInput & { readonly id: string };

export interface SupplierPage {
  readonly items: Supplier[];
  readonly nextCursor: string | null;
}

interface SupplierRow {
  id: string;
  tenant_id: string;
  company_id: string;
  supplier_no: string | null;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  supplied_materials: string[] | null;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = `s.id,
  s.tenant_id,
  s.company_id,
  s.supplier_no,
  s.name,
  s.contact_name,
  s.contact_phone,
  s.supplied_materials,
  s.status,
  s.version,
  s.created_at,
  s.updated_at`;

/** INSERT 不能带表别名，RETURNING 用无前缀列清单。 */
const RETURNING_COLUMNS = COLUMNS.replaceAll('s.', '');

/** 乐观锁列白名单：契约字段 → 表列；不拼用户输入，避免注入。 */
const UPDATE_COLUMNS: ReadonlyArray<{
  readonly key: keyof SupplierUpdateInput;
  readonly column: string;
}> = [
  { key: 'supplierNo', column: 'supplier_no' },
  { key: 'name', column: 'name' },
  { key: 'contactName', column: 'contact_name' },
  { key: 'contactPhone', column: 'contact_phone' },
  { key: 'suppliedMaterials', column: 'supplied_materials' },
  { key: 'status', column: 'status' },
];

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapRow(row: SupplierRow): Supplier {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    supplierNo: row.supplier_no,
    name: row.name,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    suppliedMaterials: row.supplied_materials ?? [],
    status: row.status as Supplier['status'],
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

/** LIKE / ILIKE 模式串：转义用户输入里的 `\`、`%`、`_`，避免把关键词当通配符。 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

async function queryRow(
  ctx: SupplierRepoContext,
  id: string,
): Promise<SupplierRow | null> {
  const result = await ctx.tx.query<SupplierRow>(
    `SELECT ${COLUMNS}
       FROM supplier s
      WHERE s.id = $1::uuid
        AND s.tenant_id = $2
        AND s.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  return result.rows[0] ?? null;
}

/**
 * 供应商列表：租户 + 可见公司内，按 keyword（名称/联系人/联系电话）与状态过滤，游标分页。
 * 显式点不可见公司时返回空列表（范围过滤优先，不越权也不报错），与商品 / 客户一致。
 */
export async function listSuppliers(
  ctx: SupplierRepoContext,
  query: SupplierListQuery,
): Promise<SupplierPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['s.tenant_id = $1', 's.company_id = ANY($2::uuid[])'];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`s.company_id = $${params.length}::uuid`);
  }

  if (query.status !== undefined) {
    params.push(query.status);
    where.push(`s.status = $${params.length}`);
  }

  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    const keywordParam = `$${params.length}`;
    // D49：只匹配名称 / 联系人 / 联系电话，supplier_no 不参与检索。
    where.push(`(
      s.name ILIKE ${keywordParam} ESCAPE '\\'
      OR s.contact_name ILIKE ${keywordParam} ESCAPE '\\'
      OR s.contact_phone ILIKE ${keywordParam} ESCAPE '\\'
    )`);
  }

  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`s.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);

  const result = await ctx.tx.query<SupplierRow>(
    `SELECT ${COLUMNS}
       FROM supplier s
      WHERE ${where.join('\n        AND ')}
      ORDER BY s.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const items = pageRows.map(mapRow);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return { items, nextCursor };
}

/** 供应商详情：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getSupplier(ctx: SupplierRepoContext, id: string): Promise<Supplier | null> {
  const row = await queryRow(ctx, id);
  return row ? mapRow(row) : null;
}

/** 新增供应商：`id` 由用例生成（同事务审计要先拿到 objectId）。 */
export async function insertSupplier(
  ctx: SupplierRepoContext,
  input: SupplierInsertInput,
): Promise<Supplier> {
  const result = await ctx.tx.query<SupplierRow>(
    `INSERT INTO supplier
       (id, tenant_id, company_id, supplier_no, name, contact_name,
        contact_phone, supplied_materials, status)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9)
     RETURNING ${RETURNING_COLUMNS}`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.supplierNo ?? null,
      input.name,
      input.contactName ?? null,
      input.contactPhone ?? null,
      input.suppliedMaterials ?? [],
      input.status ?? '启用',
    ],
  );
  return mapRow(result.rows[0]!);
}

/**
 * 修改供应商：乐观锁 `version`。
 * 查不到（含跨公司）→ null；版本不匹配 / 并发抢先 → `VERSION_CONFLICT`。
 */
export async function updateSupplier(
  ctx: SupplierRepoContext,
  id: string,
  input: SupplierUpdateInput,
  expectedVersion: number,
): Promise<Supplier | null> {
  const current = await queryRow(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '供应商版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }

  const params: unknown[] = [id, ctx.tenantId, [...ctx.companyIds]];
  const sets: string[] = [];
  for (const { key, column } of UPDATE_COLUMNS) {
    const value = input[key];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) {
    throw new AppError('VALIDATION_FAILED', '至少修改一个字段');
  }

  params.push(expectedVersion);
  const result = await ctx.tx.query<SupplierRow>(
    `UPDATE supplier s
        SET ${sets.join(', ')},
            version = s.version + 1
      WHERE s.id = $1::uuid
        AND s.tenant_id = $2
        AND s.company_id = ANY($3::uuid[])
        AND s.version = $${params.length}
      RETURNING ${COLUMNS}`,
    params,
  );
  const row = result.rows[0];
  if (!row) {
    // 读取后到 UPDATE 之间被并发改过版本。
    throw new AppError('VERSION_CONFLICT', '供应商已被并发修改，请重新读取后重试');
  }
  return mapRow(row);
}

/**
 * 停用供应商（软删除）：只把 `status` 置「停用」并递增版本，**不物理删除**。
 * 查不到（含跨公司）→ null；版本不匹配 → `VERSION_CONFLICT`。
 */
export async function softDeleteSupplier(
  ctx: SupplierRepoContext,
  id: string,
  expectedVersion: number,
): Promise<Supplier | null> {
  const current = await queryRow(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '供应商版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }

  const result = await ctx.tx.query<SupplierRow>(
    `UPDATE supplier s
        SET status = '停用',
            version = s.version + 1
      WHERE s.id = $1::uuid
        AND s.tenant_id = $2
        AND s.company_id = ANY($3::uuid[])
        AND s.version = $4
      RETURNING ${COLUMNS}`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('VERSION_CONFLICT', '供应商已被并发修改，请重新读取后重试');
  }
  return mapRow(row);
}
