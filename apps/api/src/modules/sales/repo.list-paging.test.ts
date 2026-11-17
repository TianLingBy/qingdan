import { encodeCursor, type SalesOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 销售单列表的页码分页与排序（D95 / #341）。
 *
 * 重点不只是「新功能能用」，还有「老的游标流程一行没变」：
 * 老前端只发 `?limit=N` 与 `?cursor=...`，它的 nextCursor 必须照旧可续翻，
 * 新加的 total / page / pageSize 对它只能是 null。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';

const CUSTOMER_ID = '01900000-0000-7000-8000-000000004201';
const PRODUCT_ID = '01900000-0000-7000-8000-000000004211';
const BATCH_A_ID = '01900000-0000-7000-8000-000000004221';
const BATCH_B_ID = '01900000-0000-7000-8000-000000004222';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_A_ID, BATCH_B_ID],
  qty: '2',
  unitPrice: '15',
  amount: '30',
};

const FEE = { feeName: '运费', qty: '1', unitPrice: '5', amount: '5', remark: null };

interface PagedBody {
  items: SalesOrder[];
  total: number | null;
  page: number | null;
  pageSize: number | null;
  nextCursor: string | null;
}

describe('销售单列表页码分页与排序（D95）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let cookie: string;
  let createdIds: string[] = [];
  let sequence = 0;

  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-paging-${prefix}-${sequence}`;
  }

  async function list(url: string): Promise<{ status: number; body: PagedBody }> {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { cookie, 'x-request-id': nextRequestId('list') },
    });
    return { status: response.statusCode, body: response.json() as PagedBody };
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer (id, tenant_id, company_id, customer_no, name)
       VALUES ($1, $2, $3, NULL, '分页客户')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '分页商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'D95-A', '10', '1000', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'D95-B', '20', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
        BATCH_B_ID,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': nextRequestId('login') },
      payload: { phone: OWNER_PHONE, code: '000000' },
    });
    expect(login.statusCode).toBe(200);
    cookie = String(login.headers['set-cookie']).split(';')[0]!;

    // 开 6 张单：4 张够验证翻页，6 张让「第 3 页只有 2 条」也能覆盖到。
    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sales-orders',
        headers: { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': nextRequestId('create') },
        payload: {
          companyId: DEMO_IDS.companyId,
          customerId: CUSTOMER_ID,
          handlerId: DEMO_IDS.ownerEmployeeId,
          lines: [LINE],
          fees: [FEE],
        },
      });
      expect(response.statusCode).toBe(201);
      createdIds.push((response.json() as SalesOrder).id);
    }
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  const base = `/api/v1/sales-orders?customerId=${CUSTOMER_ID}`;

  it('老的游标流程不变：?limit=2 仍给出可续翻的 nextCursor，新字段为 null', async () => {
    const first = await list(`${base}&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.total).toBeNull();
    expect(first.body.page).toBeNull();
    expect(first.body.pageSize).toBeNull();
    expect(first.body.nextCursor).not.toBeNull();

    const second = await list(
      `${base}&limit=2&cursor=${encodeURIComponent(String(first.body.nextCursor))}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.total).toBeNull();
    const firstIds = first.body.items.map((item) => item.id);
    const secondIds = second.body.items.map((item) => item.id);
    expect(secondIds).toHaveLength(2);
    // 两页之间不许重叠：重叠就是「游标比较写错了」。
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('page 与 cursor 同时给 → 422，details.field 指向 page', async () => {
    const cursor = encodeCursor({
      createdAt: new Date().toISOString(),
      id: createdIds[0]!,
    });
    const response = await app.inject({
      method: 'GET',
      url: `${base}&page=1&cursor=${encodeURIComponent(cursor)}`,
      headers: { cookie, 'x-request-id': nextRequestId('both') },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { code: string; details?: { field?: string } };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details?.field).toBe('page');
  });

  it('page=1/2 两页拼起来 = 一次性取 4 条，不漏不重', async () => {
    const one = await list(`${base}&page=1&pageSize=2`);
    const two = await list(`${base}&page=2&pageSize=2`);
    const whole = await list(`${base}&limit=4`);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);

    const paged = [...one.body.items, ...two.body.items].map((item) => item.id);
    expect(paged).toHaveLength(4);
    // 页码模式默认序是 created_at DESC, id DESC，与游标模式的 id DESC 对齐；
    // 用集合比对，避免同一毫秒内开单时两种序的细节差异盖住真正要验的「不漏不重」。
    expect(new Set(paged).size).toBe(4);
    expect([...paged].sort()).toEqual(whole.body.items.map((item) => item.id).sort());
  });

  it('total 不随页变化', async () => {
    const first = await list(`${base}&page=1&pageSize=2`);
    const third = await list(`${base}&page=3&pageSize=2`);
    expect(first.body.total).toBe(6);
    expect(third.body.total).toBe(6);
    expect(third.body.items).toHaveLength(2);
  });

  it('page=999 越界 → 200 + 空 items + 真实 total', async () => {
    const beyond = await list(`${base}&page=999&pageSize=2`);
    expect(beyond.status).toBe(200);
    expect(beyond.body.items).toEqual([]);
    expect(beyond.body.total).toBe(6);
    expect(beyond.body.page).toBe(999);
  });

  it('未登记在排序白名单里的字段 → 422', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${base}&sort=occurredAt`,
      headers: { cookie, 'x-request-id': nextRequestId('bad-sort') },
    });
    // 契约先于 SQL 拦下：白名单是 z.enum，非法键在入参校验就 422，根本到不了 buildOrderBy。
    expect(response.statusCode).toBe(422);
    expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('sort=createdAt&order=asc 按时间正序，且同值行次序稳定', async () => {
    const first = await list(`${base}&page=1&pageSize=6&sort=createdAt&order=asc`);
    const again = await list(`${base}&page=1&pageSize=6&sort=createdAt&order=asc`);
    expect(first.status).toBe(200);
    const times = first.body.items.map((item) => Date.parse(item.createdAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // 同一份数据连查两次必须完全同序，否则叠上 OFFSET 会漏行 / 重复行。
    expect(again.body.items.map((item) => item.id)).toEqual(
      first.body.items.map((item) => item.id),
    );
  });
});
