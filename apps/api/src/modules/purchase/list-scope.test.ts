import type { PurchaseOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 采购单列表的 `?scope=mine|all`（D106）。
 *
 * 与 `sales/list-scope.test.ts` 同构：断言落在「返回几条、是哪一条、CSV 里有没有那张单号」，
 * 只看 200 的话，把 `handlerId` 拼成恒真条件也会绿。
 *
 * 身份选纯仓管赵刚：seed 里他有 `purchase.read` / `purchase.ship`，但**没有 `purchase.read_all`**
 * ——「有 read、无 read_all」这个组合成立，才测得出默认值按权限走。
 * 采购单的导出需要 `purchase.export`，仓管预设没有，故补一条 override（与 sales 补 export 同法）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 张明，老板：purchase 全量含 read_all
const WAREHOUSE_PHONE = '10000000004'; // 赵刚，纯仓管：purchase read/ship，无 read_all

const SUPPLIER_ID = '01900000-0000-7000-8000-000000007401';
const PRODUCT_ID = '01900000-0000-7000-8000-000000007411';

const LINE = {
  productId: PRODUCT_ID,
  qty: '1',
  unitPrice: '10',
  amount: '10',
};

interface PagedBody {
  items: PurchaseOrder[];
  total: number | null;
}

describe('采购单列表 scope=mine|all（D106）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let warehouseCookie: string;
  /** 经手人是赵刚（仓管本人）的单。 */
  let mineOrder: PurchaseOrder;
  /** 经手人是老板的单——仓管不该看到它。 */
  let othersOrder: PurchaseOrder;
  let sequence = 0;

  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-po-scope-${prefix}-${sequence}`;
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

  async function createOrder(handlerId: string): Promise<PurchaseOrder> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'x-request-id': nextRequestId('create'),
      },
      payload: {
        companyId: DEMO_IDS.companyId,
        supplierId: SUPPLIER_ID,
        handlerId,
        lines: [LINE],
        fees: [],
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as PurchaseOrder;
  }

  async function list(
    cookie: string,
    query: string,
  ): Promise<{ status: number; body: PagedBody & { code?: string } }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders?${query}`,
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
      url: `/api/v1/purchase-orders/export${query}`,
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
      `INSERT INTO supplier
         (id, tenant_id, company_id, supplier_no, name, supplied_materials)
       VALUES ($1, $2, $3, NULL, '范围采购供应商', '{}')
       ON CONFLICT (id) DO NOTHING`,
      [SUPPLIER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '范围采购商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    // 仓管预设没有 purchase.export；补一条以覆盖「能导出，但导出也只看自己的」。
    await test.database.query(
      `INSERT INTO employee_permission_override
         (tenant_id, employee_id, domain, action, granted, operator_id)
       VALUES ($1, $2, 'purchase', 'export', true, $3)`,
      [
        DEMO_IDS.tenantId,
        DEMO_IDS.warehouseEmployeeId,
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
    warehouseCookie = await login(WAREHOUSE_PHONE);

    mineOrder = await createOrder(DEMO_IDS.warehouseEmployeeId);
    othersOrder = await createOrder(DEMO_IDS.ownerEmployeeId);
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  const paged = 'page=1&pageSize=50';

  it('无 read_all 的人不传 scope → 只回自己经手的单', async () => {
    const response = await list(warehouseCookie, paged);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items.map((item) => item.id)).toEqual([mineOrder.id]);
  });

  it('无 read_all 的人传 scope=mine → 同样只回自己的单', async () => {
    const response = await list(warehouseCookie, `${paged}&scope=mine`);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items.map((item) => item.id)).toEqual([mineOrder.id]);
  });

  it('无 read_all 的人传 scope=all → 403，且不是空列表糊弄过去', async () => {
    const response = await list(warehouseCookie, `${paged}&scope=all`);
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

  it('导出与列表同口径：仓管不传 scope 只有自己的单，老板有两张', async () => {
    const warehouseCsv = await exportCsv(warehouseCookie);
    expect(warehouseCsv.status).toBe(200);
    expect(warehouseCsv.body).toContain(mineOrder.orderNo);
    expect(warehouseCsv.body).not.toContain(othersOrder.orderNo);

    const ownerCsv = await exportCsv(ownerCookie);
    expect(ownerCsv.status).toBe(200);
    expect(ownerCsv.body).toContain(mineOrder.orderNo);
    expect(ownerCsv.body).toContain(othersOrder.orderNo);
  });

  it('导出传 scope=all 无 read_all → 403', async () => {
    const response = await exportCsv(warehouseCookie, '?scope=all');
    expect(response.status).toBe(403);
    expect(response.code).toBe('FORBIDDEN');
  });
});
