import {
  AppError,
  type ContactCreateInput,
  type ContactUpdateInput,
} from '@qingdan/contracts';
import type { SqlClient } from '../../platform/db/client.js';

/**
 * 对接人数据访问层（#306 / 设计文档 §十一）。
 *
 * - 三张表同构（`customer_contact` / `supplier_contact` / `processor_contact`），
 *   差异只有归属列名与档案表名，所以用 `CONTACT_SPECS` 描述后共用一套 SQL 拼装；
 * - 隔离：所有查询都带 `tenant_id` + `company_id = ANY(可见公司集合)`，跨公司行等同不存在；
 * - **主对接人唯一**：靠迁移里的部分唯一索引兜底，但这里先显式查一次，命中时给
 *   409 `STATE_CONFLICT`（比翻 23505 更好读；索引仍然保留，防并发插入）；
 * - **软停用**：`delete` 只把 `status` 置「停用」，行不删——历史单据的
 *   `*_contact_id` 引用与姓名仍可读；
 * - 老字段兼容：主对接人写入后同步档案的 `contact_name` / `contact_phone`（加工厂只有
 *   `contact_name`，见 0007）。
 */

export const CONTACT_KINDS = ['customer', 'supplier', 'processor'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

interface ContactKindSpec {
  /** 对接人子表。 */
  readonly table: string;
  /** 档案表。 */
  readonly ownerTable: string;
  /** 对接人子表里的归属列。 */
  readonly ownerColumn: string;
  /** 契约里的归属字段名。 */
  readonly ownerIdField: string;
  /** 档案表是否还有 `contact_phone`（加工厂没有，0007）。 */
  readonly hasLegacyPhone: boolean;
  /** 单据表与单据上的档案引用列（用于 summary 聚合）。 */
  readonly orderTable: string;
  readonly orderOwnerColumn: string;
  /**
   * 单据表上的「这次是谁来下单」列（迁移 `20261118060000_masterdata_contacts.sql`
   * 第 195-211 行加的三个可空引用）。
   *
   * 为什么同形却要逐域写死列名：三张单据表都是 `<域>_contact_id`，但 `<域>`
   * 与 `ownerColumn` 的前缀并不一致（`ownerColumn` 是 `customer_id`，
   * 而单据上的列是 `customer_contact_id`），拿 `ownerColumn` 去拼会拼出
   * `customer_id_contact_id` 这种根本不存在的列，且只有到 SQL 执行时才报错。
   */
  readonly orderContactColumn: string;
  readonly label: string;
}

export const CONTACT_SPECS: Readonly<Record<ContactKind, ContactKindSpec>> = {
  customer: {
    table: 'customer_contact',
    ownerTable: 'customer',
    ownerColumn: 'customer_id',
    ownerIdField: 'customerId',
    hasLegacyPhone: true,
    orderTable: 'sales_order',
    orderOwnerColumn: 'customer_id',
    orderContactColumn: 'customer_contact_id',
    label: '客户',
  },
  supplier: {
    table: 'supplier_contact',
    ownerTable: 'supplier',
    ownerColumn: 'supplier_id',
    ownerIdField: 'supplierId',
    hasLegacyPhone: true,
    orderTable: 'purchase_order',
    orderOwnerColumn: 'supplier_id',
    orderContactColumn: 'supplier_contact_id',
    label: '供应商',
  },
  processor: {
    table: 'processor_contact',
    ownerTable: 'processor',
    ownerColumn: 'processor_id',
    ownerIdField: 'processorId',
    hasLegacyPhone: false,
    orderTable: 'processing_order',
    orderOwnerColumn: 'processor_id',
    orderContactColumn: 'processor_contact_id',
    label: '加工厂',
  },
};

export interface ContactRepoContext {
  readonly tx: SqlClient;
  readonly tenantId: string;
  /** 调用者可见公司集合（D15）；空数组表示什么都看不到。 */
  readonly companyIds: readonly string[];
}

/** 对接人行（三张表同构，归属列统一别名成 `owner_id`）。 */
export interface ContactRow {
  id: string;
  tenant_id: string;
  company_id: string;
  owner_id: string;
  name: string;
  phone: string | null;
  title: string | null;
  is_primary: boolean;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ContactRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly title: string | null;
  readonly isPrimary: boolean;
  readonly status: '启用' | '停用';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ContactInsertInput = ContactCreateInput & { readonly id: string };

export interface ContactSummaryRow {
  order_count: number;
  total_amount: string | number | null;
  last_order_at: Date | string | null;
  recent_orders: unknown;
  contacts: unknown;
}

export interface ContactSummaryData {
  readonly orderCount: number;
  readonly totalAmount: string | null;
  readonly lastOrderAt: string | null;
  readonly recentOrders: ReadonlyArray<{
    readonly id: string;
    readonly orderNo: string;
    readonly status: string;
    readonly totalAmount: string;
    readonly createdAt: string;
    /** 下单时的对接人；老单据没有记对接人时为 null。 */
    readonly contactId: string | null;
    readonly contactName: string | null;
  }>;
  readonly contacts: readonly ContactRecord[];
}

function columns(spec: ContactKindSpec): string {
  return `k.id,
  k.tenant_id,
  k.company_id,
  k.${spec.ownerColumn} AS owner_id,
  k.name,
  k.phone,
  k.title,
  k.is_primary,
  k.status,
  k.version,
  k.created_at,
  k.updated_at`;
}

/** INSERT 不能带表别名，RETURNING 用无前缀列清单。 */
function returningColumns(spec: ContactKindSpec): string {
  return `id,
  tenant_id,
  company_id,
  ${spec.ownerColumn} AS owner_id,
  name,
  phone,
  title,
  is_primary,
  status,
  version,
  created_at,
  updated_at`;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string | null): string | null {
  return value === null ? null : toDate(value).toISOString();
}

function mapRow(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    companyId: row.company_id,
    ownerId: row.owner_id,
    name: row.name,
    phone: row.phone,
    title: row.title,
    isPrimary: row.is_primary,
    status: row.status as '启用' | '停用',
    version: row.version,
    createdAt: toDate(row.created_at).toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
  };
}

/** 23505 唯一冲突 → 409（同一档案下重名 / 并发抢主对接人）。 */
function rethrowDuplicate(error: unknown): never {
  const code = (error as { code?: unknown }).code;
  if (code === '23505') {
    throw new AppError('STATE_CONFLICT', '对接人重名，或该档案已有主对接人', {
      reason: 'DUPLICATE_CONTACT',
    });
  }
  throw error;
}

/**
 * 档案存在性 + 可见性检查：返回档案所属公司（给后续 SQL 定位用）。
 * 跨公司 / 不存在都返回 null，由用例统一映射 404。
 */
export async function findOwnerCompany(
  ctx: ContactRepoContext,
  kind: ContactKind,
  ownerId: string,
): Promise<string | null> {
  const spec = CONTACT_SPECS[kind];
  const result = await ctx.tx.query<{ company_id: string }>(
    `SELECT o.company_id
       FROM ${spec.ownerTable} o
      WHERE o.id = $1::uuid
        AND o.tenant_id = $2
        AND o.company_id = ANY($3::uuid[])`,
    [ownerId, ctx.tenantId, [...ctx.companyIds]],
  );
  return result.rows[0]?.company_id ?? null;
}

/** 对接人列表：主对接人排最前，其余按创建时间。 */
export async function listContacts(
  ctx: ContactRepoContext,
  kind: ContactKind,
  ownerId: string,
  companyId: string,
): Promise<ContactRecord[]> {
  const spec = CONTACT_SPECS[kind];
  const result = await ctx.tx.query<ContactRow>(
    `SELECT ${columns(spec)}
       FROM ${spec.table} k
      WHERE k.tenant_id = $1
        AND k.company_id = $2::uuid
        AND k.${spec.ownerColumn} = $3::uuid
      ORDER BY k.is_primary DESC, k.created_at, k.id`,
    [ctx.tenantId, companyId, ownerId],
  );
  return result.rows.map(mapRow);
}

export async function getContact(
  ctx: ContactRepoContext,
  kind: ContactKind,
  contactId: string,
): Promise<ContactRecord | null> {
  const spec = CONTACT_SPECS[kind];
  const result = await ctx.tx.query<ContactRow>(
    `SELECT ${columns(spec)}
       FROM ${spec.table} k
      WHERE k.id = $1::uuid
        AND k.tenant_id = $2
        AND k.company_id = ANY($3::uuid[])`,
    [contactId, ctx.tenantId, [...ctx.companyIds]],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** 该档案当前的主对接人（`excludeId` 用于修改时排除自己）。 */
async function findPrimaryId(
  ctx: ContactRepoContext,
  kind: ContactKind,
  ownerId: string,
  companyId: string,
  excludeId: string | null,
): Promise<string | null> {
  const spec = CONTACT_SPECS[kind];
  const result = await ctx.tx.query<{ id: string }>(
    `SELECT k.id
       FROM ${spec.table} k
      WHERE k.tenant_id = $1
        AND k.company_id = $2::uuid
        AND k.${spec.ownerColumn} = $3::uuid
        AND k.is_primary
        AND ($4::uuid IS NULL OR k.id <> $4::uuid)
      LIMIT 1`,
    [ctx.tenantId, companyId, ownerId, excludeId],
  );
  return result.rows[0]?.id ?? null;
}

/** 主对接人变更后同步老字段（兼容旧读端；加工厂没有 contact_phone）。 */
async function syncLegacyColumns(
  ctx: ContactRepoContext,
  kind: ContactKind,
  ownerId: string,
  companyId: string,
  contact: ContactRecord,
): Promise<void> {
  const spec = CONTACT_SPECS[kind];
  if (spec.hasLegacyPhone) {
    await ctx.tx.query(
      `UPDATE ${spec.ownerTable}
          SET contact_name = $1,
              contact_phone = $2
        WHERE id = $3::uuid
          AND tenant_id = $4
          AND company_id = $5::uuid`,
      [contact.name, contact.phone, ownerId, ctx.tenantId, companyId],
    );
    return;
  }
  await ctx.tx.query(
    `UPDATE ${spec.ownerTable}
        SET contact_name = $1
      WHERE id = $2::uuid
        AND tenant_id = $3
        AND company_id = $4::uuid`,
    [contact.name, ownerId, ctx.tenantId, companyId],
  );
}

/** 新增对接人；`isPrimary` 为真时要求当前没有主对接人（有则 409，需先降级旧的）。 */
export async function insertContact(
  ctx: ContactRepoContext,
  kind: ContactKind,
  ownerId: string,
  companyId: string,
  input: ContactInsertInput,
): Promise<ContactRecord> {
  const spec = CONTACT_SPECS[kind];
  const isPrimary = input.isPrimary ?? false;
  if (isPrimary) {
    const existing = await findPrimaryId(ctx, kind, ownerId, companyId, null);
    if (existing !== null) {
      throw new AppError('STATE_CONFLICT', `该${spec.label}已有主对接人，请先取消原主对接人`, {
        reason: 'PRIMARY_EXISTS',
        primaryContactId: existing,
      });
    }
  }

  const result = await ctx.tx
    .query<ContactRow>(
      `INSERT INTO ${spec.table}
         (id, tenant_id, company_id, ${spec.ownerColumn}, name, phone, title, is_primary)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8)
       RETURNING ${returningColumns(spec)}`,
      [
        input.id,
        ctx.tenantId,
        companyId,
        ownerId,
        input.name,
        input.phone ?? null,
        input.title ?? null,
        isPrimary,
      ],
    )
    .catch(rethrowDuplicate);

  const contact = mapRow(result.rows[0]!);
  if (contact.isPrimary) await syncLegacyColumns(ctx, kind, ownerId, companyId, contact);
  return contact;
}

/**
 * 修改对接人：乐观锁 `version`。
 * 查不到（含跨公司）→ null；版本不匹配 → `VERSION_CONFLICT`；
 * 提升为主对接人但档案已有别的 → 409 `STATE_CONFLICT`。
 */
export async function updateContact(
  ctx: ContactRepoContext,
  kind: ContactKind,
  contactId: string,
  input: ContactUpdateInput,
  expectedVersion: number,
): Promise<ContactRecord | null> {
  const spec = CONTACT_SPECS[kind];
  const current = await getContact(ctx, kind, contactId);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '对接人版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }
  if (input.isPrimary === true) {
    const existing = await findPrimaryId(ctx, kind, current.ownerId, current.companyId, contactId);
    if (existing !== null) {
      throw new AppError('STATE_CONFLICT', `该${spec.label}已有主对接人，请先取消原主对接人`, {
        reason: 'PRIMARY_EXISTS',
        primaryContactId: existing,
      });
    }
  }

  const params: unknown[] = [contactId, ctx.tenantId, [...ctx.companyIds]];
  const sets: string[] = [];
  const put = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.name !== undefined) put('name', input.name);
  if (input.phone !== undefined) put('phone', input.phone);
  if (input.title !== undefined) put('title', input.title);
  if (input.isPrimary !== undefined) put('is_primary', input.isPrimary);
  if (input.status !== undefined) put('status', input.status);
  if (sets.length === 0) throw new AppError('VALIDATION_FAILED', '至少修改一个字段');

  params.push(expectedVersion);
  const result = await ctx.tx
    .query<ContactRow>(
      `UPDATE ${spec.table} k
          SET ${sets.join(', ')},
              version = k.version + 1
        WHERE k.id = $1::uuid
          AND k.tenant_id = $2
          AND k.company_id = ANY($3::uuid[])
          AND k.version = $${params.length}
        RETURNING ${columns(spec)}`,
      params,
    )
    .catch(rethrowDuplicate);
  const row = result.rows[0];
  if (!row) {
    throw new AppError('VERSION_CONFLICT', '对接人已被并发修改，请重新读取后重试');
  }

  const updated = mapRow(row);
  if (updated.isPrimary) {
    await syncLegacyColumns(ctx, kind, updated.ownerId, updated.companyId, updated);
  }
  return updated;
}

/**
 * 「删除」对接人 = **软停用**：`status` 置「停用」，行保留。
 *
 * 为什么不做物理删：单据上 `*_contact_id` 是 `ON DELETE RESTRICT` 引用，
 * 删行会让历史单读不到「这次是谁来下的单」；软停用既满足用户「删掉这个人」的语义，
 * 又保住历史可读（设计文档 §11 也明确停用对接人仍在列表灰显、历史单可看）。
 */
export async function deactivateContact(
  ctx: ContactRepoContext,
  kind: ContactKind,
  contactId: string,
  expectedVersion: number,
): Promise<ContactRecord | null> {
  const spec = CONTACT_SPECS[kind];
  const current = await getContact(ctx, kind, contactId);
  if (!current) return null;
  if (current.version !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', '对接人版本与 If-Match 不一致，请重新读取后重试', {
      expected: expectedVersion,
      current: current.version,
    });
  }

  const result = await ctx.tx.query<ContactRow>(
    `UPDATE ${spec.table} k
        SET status = '停用',
            version = k.version + 1
      WHERE k.id = $1::uuid
        AND k.tenant_id = $2
        AND k.company_id = ANY($3::uuid[])
        AND k.version = $4
      RETURNING ${columns(spec)}`,
    [contactId, ctx.tenantId, [...ctx.companyIds], expectedVersion],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('VERSION_CONFLICT', '对接人已被并发修改，请重新读取后重试');
  }
  return mapRow(row);
}

/**
 * 档案汇总：**一条 SQL** 拿全「单数 / 累计金额 / 最后一单时间 / 最近 10 单 / 对接人」。
 *
 * - `status <> '已取消'` 且只统计本公司（D15）；
 * - 用两个 CTE + 标量子查询拼成单条语句，禁止在循环里补查（N+1）；
 * - `withAmount = false`（无 `view_price`）时金额列照常聚合，但**由用例决定不放进响应**。
 */
export async function aggregateSummary(
  ctx: ContactRepoContext,
  kind: ContactKind,
  ownerId: string,
  companyId: string,
): Promise<ContactSummaryData> {
  const spec = CONTACT_SPECS[kind];
  const result = await ctx.tx.query<ContactSummaryRow>(
    `WITH scoped AS (
       SELECT o.id, o.order_no, o.status, o.total_amount, o.created_at,
              o.${spec.orderContactColumn} AS contact_id
         FROM ${spec.orderTable} o
        WHERE o.tenant_id = $1
          AND o.company_id = $2::uuid
          AND o.${spec.orderOwnerColumn} = $3::uuid
          AND o.status <> '已取消'
     ),
     recent AS (
       SELECT s.*, c.name AS contact_name
         FROM scoped s
         LEFT JOIN ${spec.table} c
                ON c.id = s.contact_id
               AND c.tenant_id = $1
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 10
     )
     SELECT (SELECT COUNT(*)::int FROM scoped) AS order_count,
            (SELECT trim_scale(COALESCE(SUM(total_amount), 0)) FROM scoped) AS total_amount,
            (SELECT MAX(created_at) FROM scoped) AS last_order_at,
            COALESCE(
              (SELECT json_agg(r ORDER BY r.created_at DESC, r.id DESC) FROM recent r),
              '[]'::json
            ) AS recent_orders,
            COALESCE(
              (SELECT json_agg(
                        json_build_object(
                          'id', k.id,
                          'tenant_id', k.tenant_id,
                          'company_id', k.company_id,
                          'owner_id', k.${spec.ownerColumn},
                          'name', k.name,
                          'phone', k.phone,
                          'title', k.title,
                          'is_primary', k.is_primary,
                          'status', k.status,
                          'version', k.version,
                          'created_at', k.created_at,
                          'updated_at', k.updated_at
                        )
                        ORDER BY k.is_primary DESC, k.created_at, k.id
                      )
                 FROM ${spec.table} k
                WHERE k.tenant_id = $1
                  AND k.company_id = $2::uuid
                  AND k.${spec.ownerColumn} = $3::uuid),
              '[]'::json
            ) AS contacts`,
    [ctx.tenantId, companyId, ownerId],
  );

  const row = result.rows[0]!;
  const recentOrders = (row.recent_orders as RawOrderJson[]).map((order) => ({
    id: order.id,
    orderNo: order.order_no,
    status: order.status,
    totalAmount: String(order.total_amount),
    createdAt: toDate(order.created_at).toISOString(),
    contactId: order.contact_id ?? null,
    contactName: order.contact_name ?? null,
  }));
  const contacts = (row.contacts as ContactRow[]).map((contact) => mapRow(contact));

  return {
    orderCount: Number(row.order_count),
    totalAmount: row.total_amount === null ? null : String(row.total_amount),
    lastOrderAt: toIso(row.last_order_at),
    recentOrders,
    contacts,
  };
}

interface RawOrderJson {
  id: string;
  order_no: string;
  status: string;
  total_amount: string | number;
  created_at: string;
  contact_id: string | null;
  contact_name: string | null;
}
/** 按对接人分组的一行（`?groupBy=contact`）。 */
export interface ContactSummaryGroupData {
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly orderCount: number;
  readonly totalAmount: string | null;
  readonly lastOrderAt: string | null;
}

export interface ContactGroupRow {
  contact_id: string | null;
  contact_name: string | null;
  order_count: number | string;
  total_amount: string | number | null;
  last_order_at: Date | string | null;
}

/**
 * 按对接人把该公司下该档案的订单分组统计。
 *
 * `GROUP BY s.contact_id` 会把 `contact_id IS NULL` 的行天然归成一组——这正是要的：
 * 「当时没记对接人的那批单」必须单独成组出现，否则各分组的 orderCount 加起来
 * 小于 `aggregateSummary` 的总数，看的人会以为丢单。所以这里**不许**加
 * `WHERE contact_id IS NOT NULL` 之类的过滤。
 *
 * `ORDER BY order_count DESC, contact_id NULLS LAST`：主要看谁的单多；
 * 无对接人那组永远排最后（它是历史遗留，不是某个人的业绩）。
 *
 * 一条 SQL 出全部组，不在应用层循环补查（N+1）。
 */
export async function aggregateByContact(
  ctx: ContactRepoContext,
  kind: ContactKind,
  ownerId: string,
  companyId: string,
): Promise<readonly ContactSummaryGroupData[]> {
  const spec = CONTACT_SPECS[kind];
  const result = await ctx.tx.query<ContactGroupRow>(
    `WITH scoped AS (
       SELECT o.${spec.orderContactColumn} AS contact_id,
              o.total_amount,
              o.created_at
         FROM ${spec.orderTable} o
        WHERE o.tenant_id = $1
          AND o.company_id = $2::uuid
          AND o.${spec.orderOwnerColumn} = $3::uuid
          AND o.status <> '已取消'
     )
     SELECT s.contact_id,
            c.name AS contact_name,
            COUNT(*)::int AS order_count,
            trim_scale(COALESCE(SUM(s.total_amount), 0)) AS total_amount,
            MAX(s.created_at) AS last_order_at
       FROM scoped s
       LEFT JOIN ${spec.table} c
              ON c.id = s.contact_id
             AND c.tenant_id = $1
      GROUP BY s.contact_id, c.name
      ORDER BY COUNT(*) DESC, s.contact_id NULLS LAST`,
    [ctx.tenantId, companyId, ownerId],
  );

  return result.rows.map((row) => ({
    contactId: row.contact_id,
    contactName: row.contact_name,
    orderCount: Number(row.order_count),
    totalAmount: row.total_amount === null ? null : String(row.total_amount),
    lastOrderAt: toIso(row.last_order_at),
  }));
}