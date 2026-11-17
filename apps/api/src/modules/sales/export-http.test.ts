import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 销售单列表导出的补充验收（`sales.order.export` / D96 / #342）。
 *
 * `sales-order-export.test.ts` 已经覆盖金额列、BOM、RFC4180 与 AI 403；
 * 这里只补三件它在旧 JSON 信封时代没测、改成原生 CSV 后必须锁住的事：
 * - 没 `sales.export` → 403（不回空 CSV 冒充「没数据」）；
 * - keyword 真的在过滤；
 * - 客户名以 `=` 开头时导出带单引号前缀（公式注入防护的端到端证明）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 老板：sales.export + view_price
const SALES_PHONE = '10000000003'; // 销售：无 sales.export

const CUSTOMER_A_ID = '01900000-0000-7000-8000-000000009201';
const CUSTOMER_B_ID = '01900000-0000-7000-8000-000000009202';
const PRODUCT_ID = '01900000-0000-7000-8000-000000009211';
const BATCH_ID = '01900000-0000-7000-8000-000000009221';

const CUSTOMER_A_NAME = '导出销售客户甲';
/** 故意写成 Excel 公式形态：不转义的话，谁点开这个文件谁被执行。 */
const CUSTOMER_B_NAME = "=cmd|'/c calc'!A1";

const UTF8_BOM = String.fromCharCode(0xfeff);

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(cookie: string, requestId: string): Record<string, string> {
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

describe('销售单列表导出 CSV（HTTP 硬化）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  let orderANo: string;

  async function createOrder(
    requestId: string,
    customerId: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds: [BATCH_ID],
            qty: '2',
            unitPrice: '10',
            amount: '0',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { orderNo: string }).orderNo;
  }

  async function exportCsv(cookie: string, requestId: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/sales-orders/export${query}`,
      headers: readHeaders(cookie, requestId),
    });
  }

  function bodyRows(body: string): string[] {
    return body.slice(1).split('\r\n').filter(Boolean);
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO customer (id, tenant_id, company_id, customer_no, name)
       VALUES ($1, $2, $3, NULL, $4), ($5, $2, $3, NULL, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        CUSTOMER_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        CUSTOMER_A_NAME,
        CUSTOMER_B_ID,
        CUSTOMER_B_NAME,
      ],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '导出硬化测试商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'EXP-HARD-BATCH', '5', '1000', '0', '0', '0', $5)
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
    ownerCookie = await login(app, OWNER_PHONE, 'req-sexp-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-sexp-login-sales');

    orderANo = await createOrder('req-sexp-create-a', CUSTOMER_A_ID);
    await createOrder('req-sexp-create-b', CUSTOMER_B_ID);
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('无 sales.export → 403，不回空 CSV', async () => {
    const response = await exportCsv(salesCookie, 'req-sexp-no-scope');
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(UTF8_BOM);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('导出行数 = 同条件下列表条数', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/sales-orders?companyId=${DEMO_IDS.companyId}`,
      headers: readHeaders(ownerCookie, 'req-sexp-list'),
    });
    expect(list.statusCode).toBe(200);
    const total = (list.json() as { items: unknown[] }).items.length;

    const response = await exportCsv(
      ownerCookie,
      'req-sexp-count',
      `?companyId=${DEMO_IDS.companyId}`,
    );
    expect(response.statusCode).toBe(200);
    expect(bodyRows(response.body)).toHaveLength(total + 1);
  });

  it('带 keyword 时导出被过滤（不是全表）', async () => {
    const response = await exportCsv(
      ownerCookie,
      'req-sexp-keyword',
      `?keyword=${encodeURIComponent('客户甲')}`,
    );
    expect(response.statusCode).toBe(200);
    const rows = bodyRows(response.body);
    expect(rows).toHaveLength(2); // 表头 + 客户甲那 1 张
    expect(rows[1]).toContain(orderANo);
    for (const row of rows.slice(1)) {
      expect(row).not.toContain('客户乙');
    }
  });

  it('客户名以 = 开头 → 导出带单引号前缀（公式注入防护端到端）', async () => {
    const response = await exportCsv(ownerCookie, 'req-sexp-formula');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`'${CUSTOMER_B_NAME}`);
    // 不允许出现「裸的」公式：行里出现 ,= 或行首 = 就说明没转义。
    expect(response.body).not.toContain(`,${CUSTOMER_B_NAME}`);
  });
});
