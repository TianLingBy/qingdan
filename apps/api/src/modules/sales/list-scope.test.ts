import type { SalesOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 销售单列表的 `?scope=mine|all`（D106）。
 *
 * 这条用例要验的不是「参数能被解析」——契约测试已经管了——而是
 * **scope 真的折算成了 SQL 里的 `handler_id` 条件**，以及「默认值按权限走」：
 *
 * - 没有 `sales.read_all` 的人（销售王芳）：不传 scope 只回自己经手的单，
 *   显式 `scope=all` 直接 403（不能因为传了个参数就越权）；
 * - 有 `sales.read_all` 的人（老板）：不传 scope 回全部，
 *   但显式 `scope=mine` 仍然要筛成「只有自己经手的」——否则权限成了单向开关；
 * - 导出与列表同口径：列表只看自己的、导出能导全部，就是绕过。
 *
 * 断言全部落在「返回几条、是哪一条、CSV 里有没有那张单号」上；
 * 只看 status 200 的话，把 handlerId 拼错成恒真条件也会绿。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 张明，老板：sales 全量含 read_all
const SALES_PHONE = '10000000003'; // 王芳，岗位「销售」：sales read/create/update/view_price，无 read_all

const CUSTOMER_ID = '01900000-0000-7000-8000-000000005201';
const PRODUCT_ID = '01900000-0000-7000-8000-000000005211';
const BATCH_ID = '01900000-0000-7000-8000-000000005221';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_ID],
  qty: '1',
  unitPrice: '10',
  amount: '10',
};

interface PagedBody {
  items: SalesOrder[];
  total: number | null;
}

describe('销售单列表 scope=mine|all（D106）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  /** 经手人是王芳（销售本人）的单。 */
  let mineOrder: SalesOrder;
  /** 经手人是老板的单——销售不该看到它。 */
  let othersOrder: SalesOrder;
  let sequence = 0;

  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-scope-${prefix}-${sequence}`;
  }

  async function login(phone: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': nextRequestId('login') },
      payload: { phone, code: '000000' },
    });
    expect(response.statusCode).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0]!;
  }

  async function createOrder(handlerId: string): Promise<SalesOrder> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'x-request-id': nextRequestId('create'),
      },
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId: CUSTOMER_ID,
        handlerId,
        lines: [LINE],
        fees: [],
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as SalesOrder;
  }

  async function list(
    cookie: string,
    query: string,
  ): Promise<{ status: number; body: PagedBody & { code?: string } }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sales-orders?${query}`,
      headers: { cookie, 'x-request-id': nextRequestId('list') },
    });
    return {
      status: response.statusCode,
      body: response.json() as PagedBody & { code?: string },
    };
  }

  async function exportCsv(
    cookie: string,
    query = '',
  ): Promise<{ status: number; body: string; code?: string }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sales-orders/export${query}`,
      headers: { cookie, 'x-request-id': nextRequestId('export') },
    });
    const isCsv = String(response.headers['content-type']).includes('text/csv');
    return {
      status: response.statusCode,
      body: response.body,
      ...(isCsv ? {} : { code: (response.json() as { code?: string }).code }),
    };
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer (id, tenant_id, company_id, customer_no, name)
       VALUES ($1, $2, $3, NULL, '范围客户')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '范围商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'D106-A', '10', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
    // 销售岗位默认没有 export；补一条以覆盖「能导出，但导出也只看自己的」。
    await test.database.query(
      `INSERT INTO employee_permission_override
         (tenant_id, employee_id, domain, action, granted, operator_id)
       VALUES ($1, $2, 'sales', 'export', true, $3)`,
      [
        DEMO_IDS.tenantId,
        DEMO_IDS.salesEmployeeId,
        DEMO_IDS.ownerEmployeeId,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();

    ownerCookie = await login(OWNER_PHONE);
    salesCookie = await login(SALES_PHONE);

    mineOrder = await createOrder(DEMO_IDS.salesEmployeeId);
    othersOrder = await createOrder(DEMO_IDS.ownerEmployeeId);
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  const paged = 'page=1&pageSize=50';

  it('无 read_all 的人不传 scope → 只回自己经手的单', async () => {
    const response = await list(salesCookie, paged);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items.map((item) => item.id)).toEqual([mineOrder.id]);
  });

  it('无 read_all 的人传 scope=mine → 同样只回自己的单', async () => {
    const response = await list(salesCookie, `${paged}&scope=mine`);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items.map((item) => item.id)).toEqual([mineOrder.id]);
  });

  it('无 read_all 的人传 scope=all → 403，且不是空列表糊弄过去', async () => {
    const response = await list(salesCookie, `${paged}&scope=all`);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('有 read_all 的人不传 scope → 回全部', async () => {
    const response = await list(ownerCookie, paged);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items.map((item) => item.id).sort()).toEqual(
      [mineOrder.id, othersOrder.id].sort(),
    );
  });

  it('有 read_all 的人传 scope=mine → 仍筛成只有自己经手的单', async () => {
    const response = await list(ownerCookie, `${paged}&scope=mine`);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items.map((item) => item.id)).toEqual([othersOrder.id]);
  });

  /**
   * 绕过通道：列表只看自己的，导出却能导全部。
   *
   * 导出 schema 里也带 `scope`（`SalesOrderExportQuerySchema` 继承 `SalesOrderFilterFields`），
   * 所以这条必须和列表同口径：默认按权限算，显式 all 无权限要 403。
   */
  it('导出与列表同口径：销售的导出只有自己的单，老板的导出有两张', async () => {
    const salesCsv = await exportCsv(salesCookie);
    expect(salesCsv.status).toBe(200);
    expect(salesCsv.body).toContain(mineOrder.orderNo);
    expect(salesCsv.body).not.toContain(othersOrder.orderNo);

    const ownerCsv = await exportCsv(ownerCookie);
    expect(ownerCsv.status).toBe(200);
    expect(ownerCsv.body).toContain(mineOrder.orderNo);
    expect(ownerCsv.body).toContain(othersOrder.orderNo);
  });

  it('导出传 scope=all 无 read_all → 403', async () => {
    const response = await exportCsv(salesCookie, '?scope=all');
    expect(response.status).toBe(403);
    expect(response.code).toBe('FORBIDDEN');
  });

  it('导出传 scope=mine（有 read_all 的老板）→ 只剩自己的单', async () => {
    const response = await exportCsv(ownerCookie, '?scope=mine');
    expect(response.status).toBe(200);
    expect(response.body).toContain(othersOrder.orderNo);
    expect(response.body).not.toContain(mineOrder.orderNo);
  });
});
