import {
  AppError,
  encodeCursor,
  type CursorPayload,
  type Processor,
  type ProcessorCreateInput,
  type ProcessorQuote,
  type ProcessorQuoteCreateInput,
  type ProcessorUpdateInput,
} from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 加工厂 + 加工厂报价记录数据访问层（D15 / D49 / D64）。
 *
 * - 隔离：所有查询都带 `tenant_id` + `company_id = ANY(可见公司集合)`，跨公司行等同不存在；
 * - 检索（D49）：加工厂 `keyword` 只匹配 `name` / `contact_name`，**不按 `processor_no` 检索**；
 * - 分页：加工厂与普通报价列表沿用 keyset（按 uuidv7 `id DESC`）+ 不透明游标；
 * - 报价（D64④）：**只提供 list / insert**，不提供 update / delete——历史价即成本依据，
 *   repo 故意不实现这两个方法，避免被上层误接；
 * - 比价（D64③）：`processName` 过滤时按 `unit_price ASC` 排序（跨加工厂比价），
 *   日期区间 `from` / `to` 两端都包含；
 * - 单价（D54）：`numeric(18,6)` 以 decimal 字符串进出，不转 number；
 * - 写：版本不匹配由 repo 抛 `VERSION_CONFLICT`，查不到返回 `null`（由用例映射 404）。
 *
 * repo 只接收调用方已开好的事务（`tx`）：create / update / delete 需要与审计同事务（D51 / D55⑤）。
 */

export interface ProcessorRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

export interface ProcessorListQuery {
  readonly companyId?: string;
  readonly status?: Processor['status'];
  readonly keyword?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 报价列表过滤（D64③）：工序 + 日期区间跨加工厂比价。 */
export interface ProcessorQuoteListQuery {
  readonly processorId?: string;
  readonly processName?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: CursorPayload;
  readonly limit: number;
}

/** 创建输入 = 契约创建体 + 用例生成的 uuid（审计需要提前知道 objectId）。 */
export type ProcessorInsertInput = ProcessorCreateInput & { readonly id: string };
export type ProcessorQuoteInsertInput = ProcessorQuoteCreateInput & { readonly id: string };

export interface ProcessorPage {
  readonly items: Processor[];
  readonly nextCursor: string | null;
}

export interface ProcessorQuotePage {
  readonly items: ProcessorQuote[];
  readonly nextCursor: string | null;
}

interface ProcessorRow {
  id: string;
  tenant_id: string;
  company_id: string;
  processor_no: string | null;
  name: string;
  contact_name: string | null;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProcessorQuoteRow {
  id: string;
  tenant_id: string;
  company_id: string;
  processor_id: string;
  quote_date: Date | string;
  process_name: string;
  unit_price: string | number;
  remark: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const PROCESSOR_COLUMNS = `p.id,
  p.tenant_id,
  p.company_id,
  p.processor_no,
  p.name,
  p.contact_name,
  p.status,
  p.version,
  p.created_at,
  p.updated_at`;

/** INSERT 不能带表别名，RETURNING 用无前缀列清单。 */
const PROCESSOR_RETURNING_COLUMNS = PROCESSOR_COLUMNS.replaceAll('p.', '');

const QUOTE_COLUMNS = `q.id,
  q.tenant_id,
  q.company_id,
  q.processor_id,
  -- date / numeric 显式转 text：避免驱动把 date 解析成 Date（时区偏移改日）或把
  -- decimal 转成 number（D54 要求字符串原样透传）。
  q.quote_date::text AS quote_date,
  q.process_name,
  q.unit_price::text AS unit_price,
  q.remark,
  q.version,
  q.created_at,
  q.updated_at`;

const QUOTE_RETURNING_COLUMNS = QUOTE_COLUMNS.replaceAll('q.', '');

/** 乐观锁列白名单：契约字段 → 表列；不拼用户输入，避免注入。 */
const UPDATE_COLUMNS: ReadonlyArray<{
  readonly key: keyof ProcessorUpdateInput;
  readonly column: string;
}> = [
  { key: 'processorNo', column: 'processor_no' },
  { key: 'name', column: 'name' },
  { key: 'contactName', column: 'contact_name' },
  { key: 'status', column: 'status' },
];

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** date 列统一输出 `yyyy-mm-dd`（驱动可能返回 Date 或字符串）。 */
function toDateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function mapProcessorRow(row: ProcessorRow): Processor {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    processorNo: row.processor_no,
    name: row.name,
    contactName: row.contact_name,
    status: row.status as Processor['status'],
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

function mapQuoteRow(row: ProcessorQuoteRow): ProcessorQuote {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    processorId: row.processor_id,
    quoteDate: toDateOnly(row.quote_date),
    processName: row.process_name,
    // D54：decimal 字符串原样透传，不做 Number 转换（numeric(18,6) 保 6 位小数）。
    unitPrice: String(row.unit_price),
    remark: row.remark,
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

/** LIKE / ILIKE 模式串：转义用户输入里的 `\`、`%`、`_`，避免把关键词当通配符。 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

async function queryProcessorRow(
  ctx: ProcessorRepoContext,
  id: string,
): Promise<ProcessorRow | null> {
  const result = await ctx.tx.query<ProcessorRow>(
    `SELECT ${PROCESSOR_COLUMNS}
       FROM processor p
      WHERE p.id = $1::uuid
        AND p.tenant_id = $2
        AND p.company_id = ANY($3::uuid[])`,
    [id, ctx.tenantId, [...ctx.companyIds]],
  );
  return result.rows[0] ?? null;
}

/**
 * 加工厂列表：租户 + 可见公司内，按 keyword（名称/联系人）与状态过滤，游标分页。
 * 显式点不可见公司时返回空列表（范围过滤优先，不越权也不报错），与商品 / 客户 / 供应商一致。
 */
export async function listProcessors(
  ctx: ProcessorRepoContext,
  query: ProcessorListQuery,
): Promise<ProcessorPage> {
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
    // D49：只匹配名称 / 联系人，processor_no 不参与检索。
    where.push(`(
      p.name ILIKE ${keywordParam} ESCAPE '\\'
      OR p.contact_name ILIKE ${keywordParam} ESCAPE '\\'
    )`);
  }

  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    where.push(`p.id < $${params.length}::uuid`);
  }

  params.push(query.limit + 1);

  const result = await ctx.tx.query<ProcessorRow>(
    `SELECT ${PROCESSOR_COLUMNS}
       FROM processor p
      WHERE ${where.join('\n        AND ')}
      ORDER BY p.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const items = pageRows.map(mapProcessorRow);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return { items, nextCursor };
}

/** 加工厂详情：租户 + 可见公司内；查不到（含跨公司）返回 null。 */
export async function getProcessor(
  ctx: ProcessorRepoContext,
  id: string,
): Promise<Processor | null> {
  const row = await queryProcessorRow(ctx, id);
  return row ? mapProcessorRow(row) : null;
}

/** 新增加工厂：`id` 由用例生成（同事务审计要先拿到 objectId）。 */
export async function insertProcessor(
  ctx: ProcessorRepoContext,
  input: ProcessorInsertInput,
): Promise<Processor> {
  const result = await ctx.tx.query<ProcessorRow>(
    `INSERT INTO processor
       (id, tenant_id, company_id, processor_no, name, contact_name, status)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)
     RETURNING ${PROCESSOR_RETURNING_COLUMNS}`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.processorNo ?? null,
      input.name,
      input.contactName ?? null,
      input.status ?? '启用',
    ],
  );
  return mapProcessorRow(result.rows[0]!);
}

/**
 * 修改加工厂：乐观锁 `version`。
 * 查不到（含跨公司）→ null；版本不匹配 / 并发抢先 → `VERSION_CONFLICT`。
 */
export async function updateProcessor(
  ctx: ProcessorRepoContext,
  id: string,
  input: ProcessorUpdateInput,
  expectedVersion: number,
): Promise<Processor | null> {
  const current = await queryProcessorRow(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '加工厂版本与 If-Match 不一致，请重新读取后重试', {
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
  const result = await ctx.tx.query<ProcessorRow>(
    `UPDATE processor p
        SET ${sets.join(', ')},
            version = p.version + 1
      WHERE p.id = $1::uuid
        AND p.tenant_id = $2
        AND p.company_id = ANY($3::uuid[])
        AND p.version = $${params.length}
      RETURNING ${PROCESSOR_COLUMNS}`,
    params,
  );
  const row = result.rows[0];
  if (!row) {
    // 读取后到 UPDATE 之间被并发改过版本。
    throw new AppError('VERSION_CONFLICT', '加工厂已被并发修改，请重新读取后重试');
  }
  return mapProcessorRow(row);
}

/**
 * 停用加工厂（软删除）：只把 `status` 置「停用」并递增版本，**不物理删除**。
 * 查不到（含跨公司）→ null；版本不匹配 → `VERSION_CONFLICT`。
 */
export async function softDeleteProcessor(
  ctx: ProcessorRepoContext,
  id: string,
  expectedVersion: number,
): Promise<Processor | null> {
  const current = await queryProcessorRow(ctx, id);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '加工厂版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }

  const result = await ctx.tx.query<ProcessorRow>(
    `UPDATE processor p
        SET status = '停用',
            version = p.version + 1
      WHERE p.id = $1::uuid
        AND p.tenant_id = $2
        AND p.company_id = ANY($3::uuid[])
        AND p.version = $4
      RETURNING ${PROCESSOR_COLUMNS}`,
    [id, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('VERSION_CONFLICT', '加工厂已被并发修改，请重新读取后重试');
  }
  return mapProcessorRow(row);
}

/**
 * 报价记录列表（D64③）：租户 + 可见公司内，可按加工厂 / 工序 / 日期区间过滤。
 *
 * 比价场景（带 `processName`）按 `unit_price ASC` 排序，跨加工厂直接看谁便宜；
 * 普通列表按 uuidv7 `id DESC`。两种排序各自用匹配的 keyset 续页：
 * - 普通列表：`id < cursor.id`；
 * - 比价列表：契约游标只承载 `id`，因此在同一条 SQL 里用游标 id 回查该行
 *   `(unit_price, quote_date, id)` 作为排序游标，按 `(price ASC, date DESC, id DESC)`
 *   严格续页——否则按价格排序却用 id 过滤会跳行 / 重复。
 */
export async function listQuotes(
  ctx: ProcessorRepoContext,
  query: ProcessorQuoteListQuery,
): Promise<ProcessorQuotePage> {
  const params: unknown[] = [ctx.tenantId, [...ctx.companyIds]];
  const where: string[] = ['q.tenant_id = $1', 'q.company_id = ANY($2::uuid[])'];
  const compareByPrice = query.processName !== undefined;

  if (query.processorId !== undefined) {
    params.push(query.processorId);
    where.push(`q.processor_id = $${params.length}::uuid`);
  }

  if (query.processName !== undefined) {
    params.push(query.processName);
    where.push(`q.process_name = $${params.length}`);
  }

  if (query.from !== undefined) {
    params.push(query.from);
    where.push(`q.quote_date >= $${params.length}::date`);
  }

  if (query.to !== undefined) {
    params.push(query.to);
    where.push(`q.quote_date <= $${params.length}::date`);
  }

  // 比价排序的续页游标：从游标 id 回查排序键（报价只增不改，游标行必然仍在）。
  let cursorCte = '';
  let fromClause = 'processor_quote q';
  if (query.cursor !== undefined) {
    params.push(query.cursor.id);
    const cursorParam = `$${params.length}`;
    if (compareByPrice) {
      cursorCte = `WITH cursor_row AS (
        SELECT c.unit_price, c.quote_date, c.id
          FROM processor_quote c
         WHERE c.id = ${cursorParam}::uuid
           AND c.tenant_id = $1
           AND c.company_id = ANY($2::uuid[])
      )`;
      fromClause = 'processor_quote q, cursor_row c';
      where.push(`(
        q.unit_price > c.unit_price
        OR (q.unit_price = c.unit_price AND q.quote_date < c.quote_date)
        OR (q.unit_price = c.unit_price AND q.quote_date = c.quote_date AND q.id < c.id)
      )`);
    } else {
      where.push(`q.id < ${cursorParam}::uuid`);
    }
  }

  params.push(query.limit + 1);

  // D64③：同一工序的比价按单价升序（便宜的先看到）；其余列表按插入顺序倒序。
  const orderBy = compareByPrice
    ? 'q.unit_price ASC, q.quote_date DESC, q.id DESC'
    : 'q.id DESC';

  const result = await ctx.tx.query<ProcessorQuoteRow>(
    `${cursorCte}
     SELECT ${QUOTE_COLUMNS}
       FROM ${fromClause}
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${orderBy}
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const items = pageRows.map(mapQuoteRow);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return { items, nextCursor };
}

/**
 * 新增报价记录（D64④：只增）。
 * `companyId` 与加工厂归属公司的匹配由用例在同一事务内校验，本层只负责落表。
 */
export async function insertQuote(
  ctx: ProcessorRepoContext,
  input: ProcessorQuoteInsertInput,
): Promise<ProcessorQuote> {
  const result = await ctx.tx.query<ProcessorQuoteRow>(
    `INSERT INTO processor_quote
       (id, tenant_id, company_id, processor_id, quote_date, process_name, unit_price, remark)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::date, $6, $7::numeric, $8)
     RETURNING ${QUOTE_RETURNING_COLUMNS}`,
    [
      input.id,
      ctx.tenantId,
      input.companyId,
      input.processorId,
      input.quoteDate,
      input.processName,
      input.unitPrice,
      input.remark ?? null,
    ],
  );
  return mapQuoteRow(result.rows[0]!);
}
