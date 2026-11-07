import {
  AppError,
  encodeCursor,
  type CursorPayload,
  type Customer,
  type CustomerCreateInput,
  type CustomerUpdateInput,
} from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 客户数据访问层（D15 / D49 / D63）。
 *
 * - 隔离：所有查询都带 `tenant_id` + `company_id = ANY(可见公司集合)`，跨公司行等同不存在；
 * - 检索（D49）：`keyword` 只匹配 `name` / `contact_name` / `contact_phone`，
 *   **不按 `customer_no` 检索**；
 * - 分页：与商品一致的 keyset（按 uuidv7 `id DESC`）+ 不透明游标；
 * - 账期（D63）：`credit_term_days` 为整数天、可空，0 = 现结；
 * - 写：版本不匹配由 repo 抛 `VERSION_CONFLICT`，查不到返回 `null`（由用例映射 404）。
 *
 * repo 只接收调用方已开好的事务（`tx`）：create / update / delete 需要与审计同事务（D51 / D55⑤）。
 */

export interface CustomerRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface CustomerListQuery {
  readonly companyId?: string;
  readonly status?: Customer['status'];
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 创建输入 = 契约创建体 + 用例生成的 uuid（审计需要提前知道 objectId）。 */
export type CustomerInsertInput = CustomerCreateInput & { readonly id: string };

export interface CustomerPage {
  readonly items: Customer[];
  readonly nextCursor: string | null;
}

interface CustomerRow {
  id: string;
  tenant_id: string;
  company_id: string;
  customer_no: string | null;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  credit_term_days: number | null;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = `c.id,
  c.tenant_id,
  c.company_id,
  c.customer_no,
  c.name,
  c.contact_name,
  c.contact_phone,
  c.credit_term_days,
  c.status,
  c.version,
  c.created_at,
  c.updated_at`;

/** INSERT 不能带表别名，RETURNING 用无前缀列清单。 */
const RETURNING_COLUMNS = COLUMNS.replaceAll('c.', '');

/** 乐观锁列白名单：契约字段 → 表列；不拼用户输入，避免注入。 */
const UPDATE_COLUMNS: ReadonlyArray<{
  readonly key: keyof CustomerUpdateInput;
  readonly column: string;
}> = [
  { key: 'customerNo', column: 'customer_no' },
  { key: 'name', column: 'name' },
  { key: 'contactName', column: 'contact_name' },
  { key: 'contactPhone', column: 'contact_phone' },
  { key: 'creditTermDays', column: 'credit_term_days' },
  { key: 'status', column: 'status' },
];

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapRow(row: CustomerRow): Customer {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    customerNo: row.customer_no,
    name: row.name,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    creditTermDays: row.credit_term_days,
    status: row.status as Customer['status'],
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
  ctx: CustomerRepoContext,
  id: string,
): Promise<CustomerRow | null> {
  const result = await ctx.tx.query<CustomerRow>(
    `SELECT ${COLUMNS}
       FROM customer c
      WHERE c.id = $1::uuid
        AND c.tenant_id = $2
        AND c.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  return result.rows[0] ?? null;
}

/**
 * 客户列表：租户 + 可见公司内，按 keyword（名称/联系人/联系电话）与状态过滤，游标分页。
 * 显式点不可见公司时返回空列表（范围过滤优先，不越权也不报错），与商品一致。
 */
export async function listCustomers(
  ctx: CustomerRepoContext,
  query: CustomerListQuery,
): Promise<CustomerPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['c.tenant_id = $1', 'c.company_id = ANY($2::uuid[])'];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`c.company_id = $${params.length}::uuid`);
  }

  if (query.status !== undefined) {
    params.push(query.status);
    where.push(`c.status = $${params.length}`);
  }

  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    const keywordParam = `$${params.length}`;
    // D49：只匹配名称 / 联系人 / 联系电话，customer_no 不参与检索。
    where.push(`(
      c.name ILIKE ${keywordParam} ESCAPE '\\'
      OR c.contact_name ILIKE ${keywordParam} ESCAPE '\\'
      OR c.contact_phone ILIKE ${keywordParam} ESCAPE '\\'
    )`);
  }

  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`c.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);

  const result = await ctx.tx.query<CustomerRow>(
    `SELECT ${COLUMNS}
       FROM customer c
      WHERE ${where.join('\n        AND ')}
      ORDER BY c.id DESC
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

/** 客户详情：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getCustomer(ctx: CustomerRepoContext, id: string): Promise<Customer | null> {
  const row = await queryRow(ctx, id);
  return row ? mapRow(row) : null;
}

/** 新增客户：`id` 由用例生成（同事务审计要先拿到 objectId）。 */
export async function insertCustomer(
  ctx: CustomerRepoContext,
  input: CustomerInsertInput,
): Promise<Customer> {
  const result = await ctx.tx.query<CustomerRow>(
    `INSERT INTO customer
       (id, tenant_id, company_id, customer_no, name, contact_name,
        contact_phone, credit_term_days, status)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9)
     RETURNING ${RETURNING_COLUMNS}`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.customerNo ?? null,
      input.name,
      input.contactName ?? null,
      input.contactPhone ?? null,
      input.creditTermDays ?? null,
      input.status ?? '启用',
    ],
  );
  return mapRow(result.rows[0]!);
}

/**
 * 修改客户：乐观锁 `version`。
 * 查不到（含跨公司）→ null；版本不匹配 / 并发抢先 → `VERSION_CONFLICT`。
 */
export async function updateCustomer(
  ctx: CustomerRepoContext,
  id: string,
  input: CustomerUpdateInput,
  expectedVersion: number,
): Promise<Customer | null> {
  const current = await queryRow(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '客户版本与 If-Match 不一致，请重新读取后重试', {
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
  const result = await ctx.tx.query<CustomerRow>(
    `UPDATE customer c
        SET ${sets.join(', ')},
            version = c.version + 1
      WHERE c.id = $1::uuid
        AND c.tenant_id = $2
        AND c.company_id = ANY($3::uuid[])
        AND c.version = $${params.length}
      RETURNING ${COLUMNS}`,
    params,
  );
  const row = result.rows[0];
  if (!row) {
    // 读取后到 UPDATE 之间被并发改过版本。
    throw new AppError('VERSION_CONFLICT', '客户已被并发修改，请重新读取后重试');
  }
  return mapRow(row);
}

/**
 * 停用客户（软删除）：只把 `status` 置「停用」并递增版本，**不物理删除**。
 * 查不到（含跨公司）→ null；版本不匹配 → `VERSION_CONFLICT`。
 */
export async function softDeleteCustomer(
  ctx: CustomerRepoContext,
  id: string,
  expectedVersion: number,
): Promise<Customer | null> {
  const current = await queryRow(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '客户版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }

  const result = await ctx.tx.query<CustomerRow>(
    `UPDATE customer c
        SET status = '停用',
            version = c.version + 1
      WHERE c.id = $1::uuid
        AND c.tenant_id = $2
        AND c.company_id = ANY($3::uuid[])
        AND c.version = $4
      RETURNING ${COLUMNS}`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('VERSION_CONFLICT', '客户已被并发修改，请重新读取后重试');
  }
  return mapRow(row);
}
