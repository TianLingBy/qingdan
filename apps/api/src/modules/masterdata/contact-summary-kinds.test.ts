import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 三类档案汇总（#427）：`aggregateSummary()` 过去把金额列写死成 `o.total_amount`，
 * 而加工厂走的是 `processing_order` 表——那张表没有 `total_amount`，只有 `fee_amount`，
 * 于是 `GET /processors/{id}/summary` 在真库上 100% 报 42703（column does not exist）。
 *
 * 这里对 supplier / processor 两个 kind 各点一次 HTTP：CI 此前只测了 customer，所以这 bug 漏了。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';

const SUPPLIER_ID = '01900000-0000-7000-8000-000000006101';
const PROCESSOR_ID = '01900000-0000-7000-8000-000000006102';
const PRODUCT_ID = '01900000-0000-7000-8000-000000006111';
const BATCH_ID = '01900000-0000-7000-8000-000000006121';

/** 加工单只有一笔费用 50 元 → `fee_amount = 50`，汇总的累计金额应当是 50。 */
const FEE = { feeName: '加工费', qty: '1', unitPrice: '50', amount: '50', remark: null };

describe('档案汇总：供应商 / 加工厂（#427）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let sequence = 0;
  const nextRequestId = (prefix: string) => `req-summary-kind-${prefix}-${(sequence += 1)}`;

  async function summaryOf(kind: 'suppliers' | 'processors', id: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/${kind}/${id}/summary`,
      headers: { cookie: ownerCookie, 'x-request-id': nextRequestId('summary') },
    });
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);

    await test.database.query(
      `INSERT INTO supplier (id, tenant_id, company_id, supplier_no, name, supplied_materials)
       VALUES ($1, $2, $3, NULL, '汇总用例供应商', '{}')
       ON CONFLICT (id) DO NOTHING`,
      [SUPPLIER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO processor (id, tenant_id, company_id, processor_no, name, contact_name)
       VALUES ($1, $2, $3, NULL, '汇总用例加工厂', '王五')
       ON CONFLICT (id) DO NOTHING`,
      [PROCESSOR_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '汇总用例材料', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'B-SUMMARY-001', '8', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [BATCH_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, PRODUCT_ID, DEMO_IDS.ownerEmployeeId],
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
      headers: { 'x-request-id': 'req-summary-kind-login' },
      payload: { phone: OWNER_PHONE, code: '000000' },
    });
    expect(login.statusCode).toBe(200);
    ownerCookie = String(login.headers['set-cookie']).split(';')[0]!;
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('加工厂汇总：没有单据时 200，累计金额为 0', async () => {
    const response = await summaryOf('processors', PROCESSOR_ID);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { orderCount: number; totalAmount: string | null };
    expect(body.orderCount).toBe(0);
    expect(body.totalAmount).toBe('0');
  });

  it('加工厂汇总的累计金额取 fee_amount（加工费），不是 total_amount', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/processing-orders',
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'x-request-id': nextRequestId('processing-order'),
      },
      payload: {
        companyId: DEMO_IDS.companyId,
        processorId: PROCESSOR_ID,
        outputProductId: PRODUCT_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        materialBatchIds: [{ batchId: BATCH_ID, qty: '10.000000' }],
        inputQty: '10',
        auxMaterials: null,
        fees: [FEE],
        attributionDoc: null,
        lossQty: null,
      },
    });
    expect(created.statusCode).toBe(201);

    const response = await summaryOf('processors', PROCESSOR_ID);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      orderCount: number;
      totalAmount: string;
      recentOrders: { totalAmount: string }[];
    };
    expect(body.orderCount).toBe(1);
    expect(body.totalAmount).toBe('50');
    expect(body.recentOrders[0]!.totalAmount).toBe('50');
  });

  it('供应商汇总：没有单据时 200，累计金额为 0', async () => {
    const response = await summaryOf('suppliers', SUPPLIER_ID);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { orderCount: number; totalAmount: string | null };
    expect(body.orderCount).toBe(0);
    expect(body.totalAmount).toBe('0');
  });
});
