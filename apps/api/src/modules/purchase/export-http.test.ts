import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 采购单列表导出 HTTP 行为（`purchase.order.export` / D96 / #342）。
 *
 * 覆盖父单一句话能验收的四件事：
 * - 没 `purchase.export` → 403（**不许**返回空 CSV 冒充「没有数据」）；
 * - 有权限 → 200 + `text/csv; charset=utf-8` + attachment 文件名；
 * - 导出条数 = 同筛选条件下列表的条数，且 keyword 真的在过滤（不是全表）；
 * - 超过 `EXPORT_MAX_ROWS` → 422 提示缩小范围，**绝不静默截断**。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 老板：含 purchase.export + view_price
const SALES_PHONE = '10000000003'; // 销售：无 purchase 任何权限

const SUPPLIER_A_ID = '01900000-0000-7000-8000-000000006401';
const SUPPLIER_B_ID = '01900000-0000-7000-8000-000000006402';
const PRODUCT_ID = '01900000-0000-7000-8000-000000006411';
const SUPPLIER_A_NAME = '导出采购供应商甲';
const SUPPLIER_B_NAME = '导出采购供应商乙';

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

describe('采购单列表导出 CSV（HTTP）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  const createdOrderNos: string[] = [];

  async function createOrder(
    requestId: string,
    supplierId: string,
    lineQty: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        companyId: DEMO_IDS.companyId,
        supplierId,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [{ productId: PRODUCT_ID, qty: lineQty, unitPrice: '15', amount: '0' }],
        fees: [],
      },
    });
    expect(response.statusCode).toBe(201);
    const order = response.json() as { orderNo: string };
    createdOrderNos.push(order.orderNo);
    return order.orderNo;
  }

  async function exportCsv(cookie: string, requestId: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders/export${query}`,
      headers: readHeaders(cookie, requestId),
    });
  }

  function bodyRows(body: string): string[] {
    // 第 0 个字符是 BOM，split 后首行会带 BOM，先切掉再按行过滤空行。
    return body.slice(1).split('\r\n').filter(Boolean);
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO supplier (id, tenant_id, company_id, supplier_no, name)
       VALUES ($1, $2, $3, NULL, $4), ($5, $2, $3, NULL, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        SUPPLIER_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        SUPPLIER_A_NAME,
        SUPPLIER_B_ID,
        SUPPLIER_B_NAME,
      ],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '导出采购测试商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-pexp-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-pexp-login-sales');

    await createOrder('req-pexp-create-a', SUPPLIER_A_ID, '2');
    await createOrder('req-pexp-create-b', SUPPLIER_B_ID, '3');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('无 purchase.export → 403，且不回空 CSV', async () => {
    const response = await exportCsv(salesCookie, 'req-pexp-no-scope');
    expect(response.statusCode).toBe(403);
    expect(String(response.headers['content-type'])).toContain('application/json');
    expect(response.body).not.toContain(UTF8_BOM);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('有权限 → 200 + text/csv + attachment 文件名 + BOM', async () => {
    const response = await exportCsv(ownerCookie, 'req-pexp-ok');
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/csv');
    const disposition = String(response.headers['content-disposition']);
    expect(disposition.startsWith(`attachment; filename*=UTF-8''`)).toBe(true);
    expect(decodeURIComponent(disposition.split("UTF-8''")[1]!)).toMatch(
      /^采购单-\d{8}\.csv$/,
    );
    expect(response.body.charCodeAt(0)).toBe(0xfeff);
  });

  it('导出行数 = 同条件下列表条数（表头 + N 行）', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders?companyId=${DEMO_IDS.companyId}`,
      headers: readHeaders(ownerCookie, 'req-pexp-list'),
    });
    expect(list.statusCode).toBe(200);
    const total = (list.json() as { items: unknown[] }).items.length;

    const response = await exportCsv(
      ownerCookie,
      'req-pexp-count',
      `?companyId=${DEMO_IDS.companyId}`,
    );
    expect(response.statusCode).toBe(200);
    const rows = bodyRows(response.body);
    expect(rows).toHaveLength(total + 1);
    expect(rows[0]).toBe('单号,日期,供应商,状态,经办人,数量合计,金额合计');
  });

  it('带 keyword 时导出被过滤（不是全表）', async () => {
    const response = await exportCsv(
      ownerCookie,
      'req-pexp-keyword',
      `?keyword=${encodeURIComponent(SUPPLIER_A_NAME)}`,
    );
    expect(response.statusCode).toBe(200);
    const rows = bodyRows(response.body);
    expect(rows).toHaveLength(2); // 表头 + 供应商甲那 1 张
    expect(rows[1]).toContain(SUPPLIER_A_NAME);
    for (const row of rows.slice(1)) {
      expect(row).not.toContain(SUPPLIER_B_NAME);
    }
  });

  it('带 cursor / limit 等分页参数 → 422（导出就是全量）', async () => {
    const response = await exportCsv(ownerCookie, 'req-pexp-paging', '?limit=10');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('写了一条 action=export 的审计，changeSummary 只记摘要 + 行数', async () => {
    const audit = await test.database.query<{
      action: string;
      object_type: string;
      changes: { rowCount?: number; keyword?: string | null };
      result: string;
    }>(
      `SELECT action, object_type, changes, result
         FROM audit_log
        WHERE action = 'export' AND object_type = 'purchase_order'
        ORDER BY occurred_at DESC
        LIMIT 1`,
    );
    expect(audit.rows[0]).toMatchObject({
      action: 'export',
      object_type: 'purchase_order',
      result: 'success',
    });
    expect(typeof audit.rows[0]!.changes.rowCount).toBe('number');
    // 审计只记摘要，不落单据明细。
    expect(audit.rows[0]!.changes).not.toHaveProperty('rows');
  });

  it('超过 EXPORT_MAX_ROWS → 422 且提示缩小范围（不静默截断）', async () => {
    // 造 50001 张单（EXPORT_MAX_ROWS + 1）。放最后一个用例：它会把列表撑爆。
    await test.database.query(
      `INSERT INTO purchase_order
         (id, tenant_id, company_id, order_no, supplier_id, handler_id, status)
       SELECT gen_random_uuid(), $1, $2, 'BULK-' || g, $3, $4, '进行中'
         FROM generate_series(1, 50001) AS g`,
      [DEMO_IDS.tenantId, DEMO_IDS.companyId, SUPPLIER_B_ID, DEMO_IDS.ownerEmployeeId],
    );

    const response = await exportCsv(ownerCookie, 'req-pexp-overflow');
    expect(response.statusCode).toBe(422);
    const body = response.json() as { code: string; message: string };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.message).toContain('请缩小筛选条件');
    expect(body.message).toContain('50000');
  });
});
