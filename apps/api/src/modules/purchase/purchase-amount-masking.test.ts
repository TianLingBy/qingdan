import type { PurchaseOrder, PurchaseOrderDetail } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * A 单金额脱敏（D27 / D79）+ 查看敏感金额审计（D51①）。
 *
 * 口径：无 `purchase.view_price` → 金额字段 null（记录仍可见、不 403、不出 0）：
 * `goodsAmount` / `feeAmount` / `totalAmount` / `lines[].unitPrice|amount` /
 * `fees[].unitPrice|amount`。有该权限的**详情**读取写一条 `amount.detail` 审计。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 老板：含所有 view_price
const MANAGER_PHONE = '10000000002'; // 经理：各域只 read，无 view_price

const SUPPLIER_ID = '01900000-0000-7000-8000-000000006401';
const PRODUCT_ID = '01900000-0000-7000-8000-000000006411';

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId };
}

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

describe('purchase 金额脱敏 + 敏感读审计（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let orderId: string;

  async function detailOf(
    cookie: string,
    id: string,
    requestId: string,
  ): Promise<PurchaseOrderDetail> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders/${id}`,
      headers: readHeaders(cookie, requestId),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as PurchaseOrderDetail;
  }

  async function listItems(cookie: string, requestId: string): Promise<PurchaseOrder[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders?companyId=${DEMO_IDS.companyId}`,
      headers: readHeaders(cookie, requestId),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: PurchaseOrder[] }).items;
  }

  async function amountDetailAudits(id: string): Promise<number> {
    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'amount.detail' AND object_id = $1`,
      [id],
    );
    return Number(audit.rows[0]?.count ?? '0');
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO supplier
         (id, tenant_id, company_id, supplier_no, name, status)
       VALUES ($1, $2, $3, NULL, '脱敏测试供应商', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [SUPPLIER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '脱敏测试采购商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-pmask-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-pmask-login-manager');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: writeHeaders(ownerCookie, 'req-pmask-create'),
      payload: {
        companyId: DEMO_IDS.companyId,
        supplierId: SUPPLIER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [
          {
            productId: PRODUCT_ID,
            qty: '2',
            unitPrice: '15',
            amount: '30',
          },
        ],
        fees: [
          {
            feeName: '运费',
            qty: '1',
            unitPrice: '5',
            amount: '5',
            remark: null,
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    orderId = (created.json() as PurchaseOrder).id;
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('有看价：详情金额可见，并写一条 amount.detail 敏感读审计', async () => {
    const detail = await detailOf(ownerCookie, orderId, 'req-pmask-owner-detail');
    expect(detail.goodsAmount).toBe('30');
    expect(detail.feeAmount).toBe('5');
    expect(detail.totalAmount).toBe('35');
    expect(detail.lines[0]).toMatchObject({ unitPrice: '15', amount: '30' });
    expect(detail.fees[0]).toMatchObject({ unitPrice: '5', amount: '5' });

    const audit = await test.database.query<{
      object_type: string;
      operation_id: string | null;
      domain: string | null;
    }>(
      `SELECT object_type,
              changes->>'operationId' AS operation_id,
              changes->>'domain' AS domain
         FROM audit_log
        WHERE action = 'amount.detail' AND object_id = $1`,
      [orderId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      object_type: 'purchase_order',
      operation_id: 'purchase.order.detail.read',
      domain: 'purchase',
    });
  });

  it('无看价：详情 200 但单头 / 明细 / 费用金额全为 null，且不写敏感读审计', async () => {
    const before = await amountDetailAudits(orderId);
    const detail = await detailOf(managerCookie, orderId, 'req-pmask-manager-detail');
    expect(detail.goodsAmount).toBeNull();
    expect(detail.feeAmount).toBeNull();
    expect(detail.totalAmount).toBeNull();
    for (const line of detail.lines) {
      expect(line.unitPrice).toBeNull();
      expect(line.amount).toBeNull();
    }
    for (const fee of detail.fees) {
      expect(fee.unitPrice).toBeNull();
      expect(fee.amount).toBeNull();
    }
    // 非金额字段照常可见。
    expect(detail.supplierName).toBe('脱敏测试供应商');
    expect(detail.lines[0]?.qty).toBe('2');
    expect(await amountDetailAudits(orderId)).toBe(before);
  });

  it('无看价：列表金额同样为 null', async () => {
    const items = await listItems(managerCookie, 'req-pmask-manager-list');
    const item = items.find((entry) => entry.id === orderId);
    expect(item).toBeDefined();
    expect(item?.goodsAmount).toBeNull();
    expect(item?.totalAmount).toBeNull();
    expect(item?.lines[0]?.unitPrice).toBeNull();
  });

  it('有看价：列表金额可见，但列表读取不写敏感读审计', async () => {
    const before = await amountDetailAudits(orderId);
    const items = await listItems(ownerCookie, 'req-pmask-owner-list');
    const item = items.find((entry) => entry.id === orderId);
    expect(item?.totalAmount).toBe('35');
    expect(await amountDetailAudits(orderId)).toBe(before);
  });
});
