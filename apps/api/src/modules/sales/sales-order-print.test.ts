import type { PrintDocument, SalesOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * E 单打印（sales.order.print，客户联）。
 *
 * 口径：
 * - 返回自包含 HTML（`PrintDocumentSchema`），文件名为「销售单-<单号>.html」；
 * - 有 `sales.view_price` → 金额正常渲染；
 * - 无该权限 → 金额为「—」，且响应正文里不出现真实金额（D27 / D79）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 老板：sales 含 view_price
const MANAGER_PHONE = '10000000002'; // 经理：sales 只有 read，无 view_price

const CUSTOMER_ID = '01900000-0000-7000-8000-000000008101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000008111';
const BATCH_ID = '01900000-0000-7000-8000-000000008121';

/** 明细 2 × 123.45 = 246.9；费用 3.5；合计 250.4（都足够独特，避免误判）。 */
const LINE_AMOUNT = '246.9';
const FEE_AMOUNT = '3.5';
const TOTAL_AMOUNT = '250.4';

function readHeaders(
  cookie: string,
  requestId: string,
): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(
  cookie: string,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie,
    origin: PUBLIC_BASE_URL,
    'x-request-id': requestId,
    ...extra,
  };
}

async function login(
  app: FastifyInstance,
  phone: string,
  requestId: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

describe('E 单打印（客户联）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let order: SalesOrder;

  async function print(cookie: string, requestId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/sales-orders/${order.id}/print`,
      headers: readHeaders(cookie, requestId),
    });
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, NULL, '打印测试客户', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '打印测试商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E-PRINT-A', '10', '100', '0', '0', '0', $5)
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
    ownerCookie = await login(app, OWNER_PHONE, 'req-print-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-print-login-manager');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: writeHeaders(ownerCookie, 'req-print-create'),
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId: CUSTOMER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds: [BATCH_ID],
            qty: '2',
            unitPrice: '123.45',
            amount: '0',
          },
        ],
        fees: [
          {
            feeName: '运费',
            qty: '1',
            unitPrice: FEE_AMOUNT,
            amount: '0',
            remark: null,
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    order = created.json() as SalesOrder;

    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${order.id}/complete`,
      headers: writeHeaders(ownerCookie, 'req-print-complete', {
        'if-match': `"${order.version}"`,
      }),
    });
    expect(completed.statusCode).toBe(200);
    order = completed.json() as SalesOrder;
    expect(order.status).toBe('已完成');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('有 view_price：200 + HTML 含单号与金额文本', async () => {
    const response = await print(ownerCookie, 'req-print-owner');
    expect(response.statusCode).toBe(200);

    const doc = response.json() as PrintDocument;
    expect(doc.contentType).toBe('text/html');
    expect(doc.filename).toBe(`销售单-${order.orderNo}.html`);
    expect(doc.content).toContain('销售单（客户联）');
    expect(doc.content).toContain('演示公司');
    expect(doc.content).toContain(order.orderNo);
    expect(doc.content).toContain(LINE_AMOUNT);
    expect(doc.content).toContain(FEE_AMOUNT);
    expect(doc.content).toContain(TOTAL_AMOUNT);
    expect(doc.content).toContain('客户联');
    // 商品名 / 批次号经 D70 端口取回，不再渲染 uuid 前 8 位。
    expect(doc.content).toContain('打印测试商品');
    expect(doc.content).toContain('E-PRINT-A');
  });

  it('无 view_price：200 + 金额渲染「—」，正文不含真实金额', async () => {
    const response = await print(managerCookie, 'req-print-manager');
    expect(response.statusCode).toBe(200);

    const doc = response.json() as PrintDocument;
    expect(doc.content).toContain(order.orderNo);
    expect(doc.content).toContain('—');
    expect(doc.content).not.toContain(LINE_AMOUNT);
    expect(doc.content).not.toContain(FEE_AMOUNT);
    expect(doc.content).not.toContain(TOTAL_AMOUNT);
  });
});
