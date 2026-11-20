import type { ProcessingOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 加工单列表的 `?scope=mine|all`（D106）。
 *
 * 与 `sales/list-scope.test.ts` 同构：断言「返回几条、是哪一条」，
 * 若 `handlerId` 没拼进 SQL，这里会看到两张单而不是一张。
 *
 * 身份选纯仓管赵刚：seed 里他有 `processing.read` / `processing.update`，
 * 但**没有 `processing.read_all`** —— 正好构成「有 read、无 read_all」。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 张明，老板：processing 全量含 read_all
const WAREHOUSE_PHONE = '10000000004'; // 赵刚，纯仓管：processing read/update，无 read_all

const PROCESSOR_ID = '01900000-0000-7000-8000-000000008401';
const PRODUCT_ID = '01900000-0000-7000-8000-000000008411';
const BATCH_ID = '01900000-0000-7000-8000-000000008421';

const FEE = {
  feeName: '加工费',
  qty: '1',
  unitPrice: '50',
  amount: '50',
  remark: null,
};

interface CursorBody {
  items: ProcessingOrder[];
  nextCursor: string | null;
}

describe('加工单列表 scope=mine|all（D106）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let warehouseCookie: string;
  /** 经手人是赵刚（仓管本人）的单。 */
  let mineOrder: ProcessingOrder;
  /** 经手人是老板的单——仓管不该看到它。 */
  let othersOrder: ProcessingOrder;
  let sequence = 0;

  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-processing-scope-${prefix}-${sequence}`;
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

  async function createOrder(handlerId: string): Promise<ProcessingOrder> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/processing-orders',
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'x-request-id': nextRequestId('create'),
      },
      payload: {
        companyId: DEMO_IDS.companyId,
        processorId: PROCESSOR_ID,
        outputProductId: PRODUCT_ID,
        handlerId,
        materialBatchIds: [{ batchId: BATCH_ID, qty: '100.000000' }],
        inputQty: '100',
        auxMaterials: '纸箱',
        fees: [FEE],
        attributionDoc: null,
        lossQty: null,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as ProcessingOrder;
  }

  async function list(
    cookie: string,
    query: string,
  ): Promise<{ status: number; body: CursorBody & { code?: string } }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/processing-orders?${query}`,
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
      `INSERT INTO processor
         (id, tenant_id, company_id, processor_no, name, contact_name)
       VALUES ($1, $2, $3, NULL, '范围加工厂', '王五')
       ON CONFLICT (id) DO NOTHING`,
      [PROCESSOR_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '范围加工成品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'D106-B', '8', '1000', '0', '0', '0', $5)
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
    warehouseCookie = await login(WAREHOUSE_PHONE);

    mineOrder = await createOrder(DEMO_IDS.warehouseEmployeeId);
    othersOrder = await createOrder(DEMO_IDS.ownerEmployeeId);
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  // 加工单列表只有游标分页（契约 PageQuerySchema），没有 page/pageSize 与 total。
  const paged = 'limit=50';

  it('无 read_all 的人不传 scope → 只回自己经手的单', async () => {
    const response = await list(warehouseCookie, paged);
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.id)).toEqual([mineOrder.id]);
  });

  it('无 read_all 的人传 scope=mine → 同样只回自己的单', async () => {
    const response = await list(warehouseCookie, `${paged}&scope=mine`);
    expect(response.status).toBe(200);
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
