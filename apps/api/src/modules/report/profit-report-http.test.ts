import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import {
  registerServices,
  resetServices,
  type ProcessingLossAggregateSource,
} from '../../platform/services/registry.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

const PUBLIC_BASE_URL = 'https://qingdan.example';
const SETTLEMENT_ID = '01900000-0000-7000-8000-000000006101';

async function login(app: FastifyInstance, phone: string, requestId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

describe('profit report HTTP 编排（#97）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO settlement_order
         (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
          status, total_sale_amount, total_cost_amount, gross_profit, gross_margin_rate,
          related_loss_amount, related_loss_amount_snapshot, net_profit,
          commission_rate_snapshot, commission_amount, settled_at)
       VALUES ($1, $2, $3, 'C-REPORT-HTTP', 'E', $1,
               '已结算', '1000', '700', '300', '0',
               '0', '0', '300', '0', '0', '2026-03-10T02:00:00Z')`,
      [SETTLEMENT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-report-http',
    });
    await app.ready();

    const processing: ProcessingLossAggregateSource = {
      aggregateFullLoss: async () => ({
        lossAmount: '30',
        orders: [
          {
            processingOrderId: '01900000-0000-7000-8000-000000006201',
            processingOrderNo: 'B-0001-20260310-0001',
            lossAmount: '30',
            attributed: false,
          },
        ],
      }),
    };
    registerServices({ processingLossAggregate: processing });

    ownerCookie = await login(app, '10000000001', 'req-report-http-owner');
    managerCookie = await login(app, '10000000002', 'req-report-http-manager');
  });

  afterAll(async () => {
    resetServices();
    await app.close();
    await test.database.close();
  });

  it('真实 settlement 聚合 + processing 端口编排，返回净毛利', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/profit?periodStart=2026-03-01&periodEnd=2026-03-31',
      headers: { cookie: ownerCookie, 'x-request-id': 'req-report-http-profit' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      grossProfit: '300',
      fullLossAmount: '30',
      netProfit: '270',
      unattributedLoss: null,
      unattributedLossAvailable: false,
      settledOrderCount: 1,
    });
  });

  it('无 profit_report.view_price 时金额为 null，计数仍可见', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/profit?periodStart=2026-03-01&periodEnd=2026-03-31',
      headers: { cookie: managerCookie, 'x-request-id': 'req-report-http-masked' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      grossProfit: null,
      fullLossAmount: null,
      netProfit: null,
      settledOrderCount: 1,
    });
  });

  it('损失下钻走 processing 端口并按看价权限脱敏', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/profit/losses?periodStart=2026-03-01&periodEnd=2026-03-31',
      headers: { cookie: managerCookie, 'x-request-id': 'req-report-http-losses' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          processingOrderId: '01900000-0000-7000-8000-000000006201',
          processingOrderNo: 'B-0001-20260310-0001',
          lossAmount: null,
          attributed: false,
        },
      ],
    });
  });
});
