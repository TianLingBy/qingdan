import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 库存批次列表导出 HTTP 行为（`inventory.batch.export` / D96 / #342）。
 *
 * 注意权限点：库里没有 `inventory` 这个域，批次属于 `inventory_qty`，
 * 所以 scope 是 `inventory_qty.export`（与列表 `inventory_qty.read` 成对）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 老板：全动作
const SALES_PHONE = '10000000003'; // 销售：无 inventory_qty 任何权限

const PRODUCT_A_ID = '01900000-0000-7000-8000-000000007411';
const PRODUCT_B_ID = '01900000-0000-7000-8000-000000007412';
const BATCH_A_ID = '01900000-0000-7000-8000-000000007421';
const BATCH_B_ID = '01900000-0000-7000-8000-000000007422';
const BATCH_C_ID = '01900000-0000-7000-8000-000000007423';
const PRODUCT_A_NAME = '导出批次苹果';
const PRODUCT_B_NAME = '导出批次梨';

const UTF8_BOM = String.fromCharCode(0xfeff);
const HEADER =
  '批次号,商品编号,商品名称,锁定单价,入库数量,剩余数量,在途数量,待执行数量,可用数量,保管人,创建日期';

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
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

describe('库存批次列表导出 CSV（HTTP）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;

  async function exportCsv(cookie: string, requestId: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/inventory/batches/export${query}`,
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
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, 'EXP-001', $4, '{}', '件'),
              ($5, $2, $3, 'EXP-002', $6, '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [
        PRODUCT_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_A_NAME,
        PRODUCT_B_ID,
        PRODUCT_B_NAME,
      ],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $4, $5, $6, 'EXP-BATCH-A', '10', '100', '0', '0', '0', $7),
              ($2, $4, $5, $6, 'EXP-BATCH-B', '12.5', '50', '0', '0', '0', $7),
              ($3, $4, $5, $8, 'EXP-BATCH-C', '8', '30', '0', '0', '0', $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_A_ID,
        BATCH_B_ID,
        BATCH_C_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_A_ID,
        DEMO_IDS.ownerEmployeeId,
        PRODUCT_B_ID,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-iexp-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-iexp-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('无 inventory_qty.export → 403，不回空 CSV', async () => {
    const response = await exportCsv(salesCookie, 'req-iexp-no-scope');
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(UTF8_BOM);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('有权限 → 200 + text/csv + attachment 文件名 + BOM + 表头', async () => {
    const response = await exportCsv(ownerCookie, 'req-iexp-ok');
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/csv');
    const disposition = String(response.headers['content-disposition']);
    expect(disposition.startsWith(`attachment; filename*=UTF-8''`)).toBe(true);
    expect(decodeURIComponent(disposition.split("UTF-8''")[1]!)).toMatch(
      /^库存批次-\d{8}\.csv$/,
    );
    expect(response.body.charCodeAt(0)).toBe(0xfeff);
    expect(bodyRows(response.body)[0]).toBe(HEADER);
  });

  it('导出行数 = 同条件下列表条数', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/batches?companyId=${DEMO_IDS.companyId}`,
      headers: readHeaders(ownerCookie, 'req-iexp-list'),
    });
    expect(list.statusCode).toBe(200);
    const total = (list.json() as { items: unknown[] }).items.length;

    const response = await exportCsv(
      ownerCookie,
      'req-iexp-count',
      `?companyId=${DEMO_IDS.companyId}`,
    );
    expect(response.statusCode).toBe(200);
    expect(bodyRows(response.body)).toHaveLength(total + 1);
  });

  it('带 keyword 时导出被过滤（不是全表）', async () => {
    const response = await exportCsv(
      ownerCookie,
      'req-iexp-keyword',
      `?keyword=${encodeURIComponent(PRODUCT_B_NAME)}`,
    );
    expect(response.statusCode).toBe(200);
    const rows = bodyRows(response.body);
    expect(rows).toHaveLength(2); // 表头 + 商品乙的 1 个批次
    expect(rows[1]).toContain('EXP-BATCH-C');
    for (const row of rows.slice(1)) {
      expect(row).not.toContain(PRODUCT_A_NAME);
    }
  });

  it('写了一条 action=export 的审计，只记摘要 + 行数', async () => {
    const audit = await test.database.query<{
      action: string;
      object_type: string;
      changes: { rowCount?: number };
    }>(
      `SELECT action, object_type, changes
         FROM audit_log
        WHERE action = 'export' AND object_type = 'inventory_batch'
        ORDER BY occurred_at DESC
        LIMIT 1`,
    );
    expect(audit.rows[0]).toMatchObject({
      action: 'export',
      object_type: 'inventory_batch',
    });
    expect(typeof audit.rows[0]!.changes.rowCount).toBe('number');
  });
});
