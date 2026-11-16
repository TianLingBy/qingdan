import type { PrintDocument, ProcessingOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 加工单打印（processing.order.print，发厂联）。
 *
 * 口径：
 * - 返回自包含 HTML（`PrintDocumentSchema`），文件名为「加工单-<单号>.html」；
 * - 含标题、公司名、单号、加工厂、材料批次、产出与费用明细；
 * - 可空字段（辅料 / 损耗量 / 可售量 / 归属单）渲染「—」；
 * - 有 `processing.view_price` → 费用单价 / 金额正常渲染；
 * - 无该权限 → 单价 / 金额为「—」，正文不出现真实价格；数量 / 批次号照常输出（D27）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 老板：processing 含 read + view_price
const MANAGER_PHONE = '10000000002'; // 经理：processing 只有 read，无 view_price
const SALES_PHONE = '10000000003'; // 销售：processing 连 read 都没有

const PROCESSOR_ID = '01900000-0000-7000-8000-000000009101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000009111';
const BATCH_ID = '01900000-0000-7000-8000-000000009121';

const FEE = {
  feeName: '加工费',
  qty: '1',
  unitPrice: '50',
  amount: '50',
  remark: null,
};

/** 脱敏用例专用价格：数字足够独特，避免撞上单号 / 样式里的其它数字。 */
const PRICE_UNIT = '123.45';
const PRICE_AMOUNT = '246.9';
const PRICE_FEE = {
  feeName: '加工费',
  qty: '2',
  unitPrice: PRICE_UNIT,
  amount: PRICE_AMOUNT,
  remark: null,
};

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(
  cookie: string,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId, ...extra };
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

describe('加工单打印（发厂联）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let salesCookie: string;

  async function createOrder(
    requestId: string,
    payload: Record<string, unknown> = {},
  ): Promise<ProcessingOrder> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/processing-orders',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        companyId: DEMO_IDS.companyId,
        processorId: PROCESSOR_ID,
        outputProductId: PRODUCT_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        materialBatchIds: [{ batchId: BATCH_ID, qty: '100.000000' }],
        inputQty: '100',
        auxMaterials: '纸箱',
        fees: [FEE],
        attributionDoc: null,
        lossQty: '2',
        ...payload,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as ProcessingOrder;
  }

  async function print(cookie: string, order: ProcessingOrder, requestId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/processing-orders/${order.id}/print`,
      headers: readHeaders(cookie, requestId),
    });
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO processor
         (id, tenant_id, company_id, processor_no, name, contact_name)
       VALUES ($1, $2, $3, NULL, '发厂联加工厂', '王五')
       ON CONFLICT (id) DO NOTHING`,
      [PROCESSOR_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '打印材料', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'B-PRINT-001', '8', '1000', '0', '0', '0', $5)
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
    ownerCookie = await login(app, OWNER_PHONE, 'req-processing-print-login');
    managerCookie = await login(app, MANAGER_PHONE, 'req-processing-print-login-manager');
    salesCookie = await login(app, SALES_PHONE, 'req-processing-print-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('200 + HTML 含标题、公司名、单号、加工厂与费用', async () => {
    const order = await createOrder('req-processing-print-create');
    const response = await print(ownerCookie, order, 'req-processing-print-ok');
    expect(response.statusCode).toBe(200);

    const doc = response.json() as PrintDocument;
    expect(doc.contentType).toBe('text/html');
    expect(doc.filename).toBe(`加工单-${order.orderNo}.html`);
    expect(doc.content).toContain('加工单（发厂联）');
    expect(doc.content).toContain('演示公司');
    expect(doc.content).toContain(order.orderNo);
    expect(doc.content).toContain('发厂联加工厂');
    expect(doc.content).toContain(BATCH_ID);
    expect(doc.content).toContain('100.000000');
    expect(doc.content).toContain('加工费');
    expect(doc.content).toContain('发厂联');
  });

  it('auxMaterials 为空：辅料渲染「—」', async () => {
    const order = await createOrder('req-processing-print-create-null', {
      auxMaterials: null,
      lossQty: null,
    });
    const response = await print(ownerCookie, order, 'req-processing-print-null');
    expect(response.statusCode).toBe(200);

    const doc = response.json() as PrintDocument;
    expect(doc.filename).toBe(`加工单-${order.orderNo}.html`);
    expect(doc.content).toMatch(/<dt>辅料<\/dt><dd>—<\/dd>/);
  });

  it('有 processing.view_price：200 + 费用单价 / 金额正常渲染', async () => {
    const order = await createOrder('req-processing-print-create-price', {
      fees: [PRICE_FEE],
    });
    const response = await print(ownerCookie, order, 'req-processing-print-owner');
    expect(response.statusCode).toBe(200);

    const doc = response.json() as PrintDocument;
    expect(doc.content).toContain(PRICE_UNIT);
    expect(doc.content).toContain(PRICE_AMOUNT);
  });

  it('无 processing.view_price：200 + 单价 / 金额渲染「—」，正文不含真实价格', async () => {
    const order = await createOrder('req-processing-print-create-masked', {
      fees: [PRICE_FEE],
    });
    const response = await print(managerCookie, order, 'req-processing-print-manager');
    expect(response.statusCode).toBe(200);

    const doc = response.json() as PrintDocument;
    expect(doc.content).toContain(order.orderNo);
    // 单价列与金额列都变成占位符。
    expect(doc.content).toMatch(/<td class="num">—<\/td>/);
    expect(doc.content).not.toContain(PRICE_UNIT);
    expect(doc.content).not.toContain(PRICE_AMOUNT);
    // 数量 / 批次号 / 经手人不受影响：工厂对账要用。
    expect(doc.content).toContain('<td class="num">2</td>');
    expect(doc.content).toContain(BATCH_ID);
    expect(doc.content).toContain(DEMO_IDS.ownerEmployeeId);
  });

  it('连 processing.read 都没有：403 FORBIDDEN', async () => {
    const order = await createOrder('req-processing-print-create-forbidden');
    const response = await print(salesCookie, order, 'req-processing-print-sales');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});
