import {
  AppError,
  encodeCursor,
  type CursorPayload,
  type Product,
  type ProductCreateInput,
  type ProductUpdateInput,
} from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 商品数据访问层（D15 / D49 / D54）。
 *
 * - 隔离：所有查询都带 `tenant_id` + `company_id = ANY(可见公司集合)`，跨公司行等同不存在；
 * - 检索（D49）：`keyword` 只匹配 `name` / `aliases`，**不按 `product_no` 检索**；
 * - 分页：与 api-tokens / employees 一致的 keyset（按 uuidv7 `id DESC`）+ 不透明游标；
 * - 金额：`numeric(18,6)` 经驱动返回字符串，这里统一 `String()`，绝不转 number（D54）；
 * - 写：版本不匹配由 repo 抛 `VERSION_CONFLICT`，查不到返回 `null`（由用例映射 404）。
 *
 * repo 只接收调用方已开好的事务（`tx`）：create / update / delete 需要与审计同事务（D51 / D55⑤）。
 */

export interface ProductRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface ProductListQuery {
  readonly companyId?: string;
  readonly status?: Product['status'];
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 创建输入 = 契约创建体 + 用例生成的 uuid（审计需要提前知道 objectId）。 */
export type ProductInsertInput = ProductCreateInput & { readonly id: string };

export interface ProductPage {
  readonly items: Product[];
  readonly nextCursor: string | null;
}

interface ProductRow {
  id: string;
  tenant_id: string;
  company_id: string;
  product_no: string | null;
  name: string;
  aliases: string[] | null;
  specification: string | null;
  unit: string;
  status: string;
  default_sale_price: string | number | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = `p.id,
  p.tenant_id,
  p.company_id,
  p.product_no,
  p.name,
  p.aliases,
  p.specification,
  p.unit,
  p.status,
  p.default_sale_price,
  p.version,
  p.created_at,
  p.updated_at`;

/** INSERT 不能带表别名，RETURNING 用无前缀列清单。 */
const RETURNING_COLUMNS = COLUMNS.replaceAll('p.', '');

/** 乐观锁列白名单：契约字段 → 表列；不拼用户输入，避免注入。 */
const UPDATE_COLUMNS: ReadonlyArray<{
  readonly key: keyof ProductUpdateInput;
  readonly column: string;
}> = [
  { key: 'productNo', column: 'product_no' },
  { key: 'name', column: 'name' },
  { key: 'aliases', column: 'aliases' },
  { key: 'specification', column: 'specification' },
  { key: 'unit', column: 'unit' },
  { key: 'status', column: 'status' },
  { key: 'defaultSalePrice', column: 'default_sale_price' },
];

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapRow(row: ProductRow): Product {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    productNo: row.product_no,
    name: row.name,
    aliases: row.aliases ?? [],
    specification: row.specification,
    unit: row.unit,
    status: row.status as Product['status'],
    // D54：金额保持 decimal 字符串；驱动对 numeric 一般已回 string，这里兜底。
    defaultSalePrice: row.default_sale_price === null ? null : String(row.default_sale_price),
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
  ctx: ProductRepoContext,
  id: string,
): Promise<ProductRow | null> {
  const result = await ctx.tx.query<ProductRow>(
    `SELECT ${COLUMNS}
       FROM product p
      WHERE p.id = $1::uuid
        AND p.tenant_id = $2
        AND p.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  return result.rows[0] ?? null;
}

/**
 * 商品列表：租户 + 可见公司内，按 keyword（名称/别名）与状态过滤，游标分页。
 * 显式点不可见公司时返回空列表（范围过滤优先，不越权也不报错），与 employees 一致。
 */
export async function listProducts(
  ctx: ProductRepoContext,
  query: ProductListQuery,
): Promise<ProductPage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['p.tenant_id = $1', 'p.company_id = ANY($2::uuid[])'];

  if (query.companyId !== undefined) {
    params.push(query.companyId);
    where.push(`p.company_id = $${params.length}::uuid`);
  }

  if (query.status !== undefined) {
    params.push(query.status);
    where.push(`p.status = $${params.length}`);
  }

  if (query.keyword !== undefined) {
    params.push(likePattern(query.keyword));
    const keywordParam = `$${params.length}`;
    // D49：只匹配名称 / 别名，product_no 不参与检索。
    where.push(`(
      p.name ILIKE ${keywordParam} ESCAPE '\\'
      OR EXISTS (
        SELECT 1
          FROM unnest(p.aliases) AS alias(value)
         WHERE alias.value ILIKE ${keywordParam} ESCAPE '\\'
      )
    )`);
  }

  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`p.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);

  const result = await ctx.tx.query<ProductRow>(
    `SELECT ${COLUMNS}
       FROM product p
      WHERE ${where.join('\n        AND ')}
      ORDER BY p.id DESC
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

/** 商品详情：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getProduct(ctx: ProductRepoContext, id: string): Promise<Product | null> {
  const row = await queryRow(ctx, id);
  return row ? mapRow(row) : null;
}

/** 新增商品：`id` 由用例生成（同事务审计要先拿到 objectId）。 */
export async function insertProduct(
  ctx: ProductRepoContext,
  input: ProductInsertInput,
): Promise<Product> {
  const result = await ctx.tx.query<ProductRow>(
    `INSERT INTO product
       (id, tenant_id, company_id, product_no, name, aliases, specification,
        unit, status, default_sale_price)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${RETURNING_COLUMNS}`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.productNo ?? null,
      input.name,
      input.aliases ?? [],
      input.specification ?? null,
      input.unit,
      input.status ?? '启用',
      input.defaultSalePrice ?? null,
    ],
  );
  return mapRow(result.rows[0]!);
}

/**
 * 修改商品：乐观锁 `version`。
 * 查不到（含跨公司）→ null；版本不匹配 / 并发抢先 → `VERSION_CONFLICT`。
 */
export async function updateProduct(
  ctx: ProductRepoContext,
  id: string,
  input: ProductUpdateInput,
  expectedVersion: number,
): Promise<Product | null> {
  const current = await queryRow(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '商品版本与 If-Match 不一致，请重新读取后重试', {
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
  const result = await ctx.tx.query<ProductRow>(
    `UPDATE product p
        SET ${sets.join(', ')},
            version = p.version + 1
      WHERE p.id = $1::uuid
        AND p.tenant_id = $2
        AND p.company_id = ANY($3::uuid[])
        AND p.version = $${params.length}
      RETURNING ${COLUMNS}`,
    params,
  );
  const row = result.rows[0];
  if (!row) {
    // 读取后到 UPDATE 之间被并发改过版本。
    throw new AppError('VERSION_CONFLICT', '商品已被并发修改，请重新读取后重试');
  }
  return mapRow(row);
}

/**
 * 停用商品（软删除，D62⑤）：只把 `status` 置「停用」并递增版本，**不物理删除**。
 * 查不到（含跨公司）→ null；版本不匹配 → `VERSION_CONFLICT`。
 */
export async function softDeleteProduct(
  ctx: ProductRepoContext,
  id: string,
  expectedVersion: number,
): Promise<Product | null> {
  const current = await queryRow(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '商品版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }

  const result = await ctx.tx.query<ProductRow>(
    `UPDATE product p
        SET status = '停用',
            version = p.version + 1
      WHERE p.id = $1::uuid
        AND p.tenant_id = $2
        AND p.company_id = ANY($3::uuid[])
        AND p.version = $4
      RETURNING ${COLUMNS}`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('VERSION_CONFLICT', '商品已被并发修改，请重新读取后重试');
  }
  return mapRow(row);
}
