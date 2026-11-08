import type { PrintDocument, SalesOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 销售单列表导出（sales.order.export）。
 *
 * 口径：
 * - CSV + UTF-8 BOM，文件名为「销售单-<yyyyMMdd>.csv」；
 * - 有 `sales.view_price` → 金额列按两位小数导出；
 * - 无该权限 → 金额列留空，并有一行 CSV 注释说明（D27 / D79）；
 * - RFC4180：含逗号 / 引号的字段用双引号包裹、内部引号双写。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 老板：sales.export + view_price
const MANAGER_PHONE = '10000000002'; // 经理：默认无 view_price，测试里补 sales.export

const CUSTOMER_A_ID = '01900000-0000-7000-8000-000000008201';
const CUSTOMER_B_ID = '01900000-0000-7000-8000-000000008202';
const PRODUCT_ID = '01900000-0000-7000-8000-000000008211';
const BATCH_A_ID = '01900000-0000-7000-8000-000000008221';
const BATCH_B_ID = '01900000-0000-7000-8000-000000008222';

/** 含 ASCII 逗号与双引号，用于断言 RFC4180 转义。 */
const CUSTOMER_B_NAME = '导出,客户"二"';
const HEADER = '单号,日期,客户,状态,经办人,数量合计,金额合计';
const UTF8_BOM = String.fromCharCode(0xfeff);

function readHeaders(
  cookie: string,
  requestId: string,
): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(
  cookie: string,
  requestId: string,
): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId };
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

describe('销售单列表导出 CSV', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let orderA: SalesOrder;
  let orderB: SalesOrder;

  async function createOrder(
    requestId: string,
    customerId: string,
    lines: readonly Record<string, string | string[]>[],
  ): Promise<SalesOrder> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as SalesOrder;
  }

  async function exportCsv(cookie: string, requestId: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/sales-orders/export',
      headers: readHeaders(cookie, requestId),
    });
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, NULL, '导出客户一', '启用'),
              ($4, $2, $3, NULL, $5, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [
        CUSTOMER_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        CUSTOMER_B_ID,
        CUSTOMER_B_NAME,
      ],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '导出测试商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E-EXPORT-A', '10', '1000', '0', '0', '0', $6),
              ($5, $2, $3, $4, 'E-EXPORT-B', '5', '1000', '0', '0', '0', $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        BATCH_B_ID,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
    // 经理默认只有 sales.read，无 view_price；补一条 sales.export 以覆盖「能导出但不能看价」。
    await test.database.query(
      `INSERT INTO employee_permission_override
         (tenant_id, employee_id, domain, action, granted, operator_id)
       VALUES ($1, $2, 'sales', 'export', true, $3)`,
      [
        DEMO_IDS.tenantId,
        DEMO_IDS.managerEmployeeId,
        DEMO_IDS.ownerEmployeeId,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-export-login-owner');
    managerCookie = await login(
      app,
      MANAGER_PHONE,
      'req-export-login-manager',
    );

    orderA = await createOrder('req-export-create-a', CUSTOMER_A_ID, [
      {
        productId: PRODUCT_ID,
        batchIds: [BATCH_A_ID],
        qty: '2',
        unitPrice: '123.45',
        amount: '0',
      },
      {
        productId: PRODUCT_ID,
        batchIds: [BATCH_B_ID],
        qty: '1',
        unitPrice: '10',
        amount: '0',
      },
    ]);
    orderB = await createOrder('req-export-create-b', CUSTOMER_B_ID, [
      {
        productId: PRODUCT_ID,
        batchIds: [BATCH_A_ID],
        qty: '3',
        unitPrice: '10',
        amount: '0',
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('有 view_price：200 + text/csv + BOM + 表头与两行数据（金额两位小数）', async () => {
    const response = await exportCsv(ownerCookie, 'req-export-owner');
    expect(response.statusCode).toBe(200);

    const doc = response.json() as PrintDocument;
    expect(doc.contentType).toBe('text/csv');
    expect(doc.filename).toMatch(/^销售单-\d{8}\.csv$/);
    expect(doc.content.startsWith(UTF8_BOM)).toBe(true);

    const rows = doc.content.slice(1).split('\r\n').filter(Boolean);
    expect(rows[0]).toBe(HEADER);
    expect(rows).toHaveLength(3); // 表头 + 2 张单

    expect(doc.content).toContain(orderA.orderNo);
    expect(doc.content).toContain(orderB.orderNo);
    expect(doc.content).toContain('导出客户一');
    // orderA：2 + 1 = 3，金额 246.9 + 10 = 256.9 → 256.90
    expect(doc.content).toContain(',3,256.90');
    // orderB：3 × 10 = 30 → 30.00
    expect(doc.content).toContain(',3,30.00');

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result
         FROM audit_log
        WHERE action = 'export'
        ORDER BY occurred_at DESC
        LIMIT 1`,
    );
    expect(audit.rows[0]).toMatchObject({ action: 'export', result: 'success' });
  });

  it('无 view_price：200 + 金额列留空 + CSV 注释说明', async () => {
    const response = await exportCsv(managerCookie, 'req-export-manager');
    expect(response.statusCode).toBe(200);

    const doc = response.json() as PrintDocument;
    expect(doc.contentType).toBe('text/csv');

    const rows = doc.content.slice(1).split('\r\n').filter(Boolean);
    expect(rows[0]).toBe('# 当前账号无看价权限，金额列已留空');
    expect(rows[1]).toBe(HEADER);
    expect(rows.slice(2)).toHaveLength(2);
    for (const row of rows.slice(2)) {
      expect(row.endsWith(',')).toBe(true); // 最后一列（金额合计）为空
    }
    expect(doc.content).not.toContain('256.90');
    expect(doc.content).not.toContain('30.00');
  });

  it('含逗号 / 引号的客户名：引号包裹且内部引号双写', async () => {
    const response = await exportCsv(ownerCookie, 'req-export-escape');
    expect(response.statusCode).toBe(200);

    const doc = response.json() as PrintDocument;
    expect(doc.content).toContain('"导出,客户""二"""');
  });
});
