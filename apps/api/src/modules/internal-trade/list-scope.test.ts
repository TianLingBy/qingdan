import type { InternalTradeOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 内部交易单列表的 `?scope=mine|all`（D106）。
 *
 * 与 `sales/list-scope.test.ts` 同构：断言「返回几条、是哪一条」，
 * `handlerId` 没拼进 SQL 时这里会看到两张而不是一张。
 *
 * 身份选王芳（seed 的「销售+仓管」岗位）：她有 `internal_trade.read`，
 * 但**没有 `internal_trade.read_all`** —— 「有 read、无 read_all」成立，
 * 默认值才测得出是按权限走而不是按参数走。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 张明，老板：internal_trade 全量含 read_all
const SALES_PHONE = '10000000003'; // 王芳，销售+仓管：internal_trade read，无 read_all

const TO_COMPANY_ID = '01900000-0000-7000-8000-000000009401';
const PRODUCT_ID = '01900000-0000-7000-8000-000000009411';
const BATCH_ID = '01900000-0000-7000-8000-000000009421';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_ID],
  qty: '1',
  unitPrice: '10',
  amount: '999',
};

interface CursorBody {
  items: InternalTradeOrder[];
  nextCursor: string | null;
}

describe('内部交易单列表 scope=mine|all（D106）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  /** 经手人是王芳（销售本人）的单。 */
  let mineOrder: InternalTradeOrder;
  /** 经手人是老板的单——销售不该看到它。 */
  let othersOrder: InternalTradeOrder;
  let sequence = 0;

  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-internal-scope-${prefix}-${sequence}`;
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

  async function createOrder(handlerId: string): Promise<InternalTradeOrder> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/internal-trade-orders',
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'x-request-id': nextRequestId('create'),
      },
      payload: {
        fromCompanyId: DEMO_IDS.companyId,
        toCompanyId: TO_COMPANY_ID,
        handlerId,
        lines: [LINE],
        internalPrice: '10.5',
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as InternalTradeOrder;
  }

  async function list(
    cookie: string,
    query: string,
  ): Promise<{ status: number; body: CursorBody & { code?: string } }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/internal-trade-orders?${query}`,
      headers: { cookie, 'x-request-id': nextRequestId('list') },
    });
    return {
      status: response.statusCode,
      body: response.json() as CursorBody & { code?: string },
    };
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '范围接收公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [TO_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO product (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '范围调拨商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'D106-N', '10', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
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

  // N 单列表只有游标分页（契约 PageQuerySchema），没有 page/pageSize 与 total。
  const paged = 'limit=50';

  it('无 read_all 的人不传 scope → 只回自己经手的单', async () => {
    const response = await list(salesCookie, paged);
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.id)).toEqual([mineOrder.id]);
  });

  it('无 read_all 的人传 scope=mine → 同样只回自己的单', async () => {
    const response = await list(salesCookie, `${paged}&scope=mine`);
    expect(response.status).toBe(200);
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
    expect(response.body.items.map((item) => item.id).sort()).toEqual(
      [mineOrder.id, othersOrder.id].sort(),
    );
  });

  it('有 read_all 的人传 scope=mine → 仍筛成只有自己经手的单', async () => {
    const response = await list(ownerCookie, `${paged}&scope=mine`);
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.id)).toEqual([othersOrder.id]);
  });
});
