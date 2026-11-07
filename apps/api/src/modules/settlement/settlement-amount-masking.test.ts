import type { SettlementOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * C 单金额脱敏（D27 / D78）+ 查看敏感金额审计（D51①）。
 *
 * 口径：无 `settlement.view_price` → 金额字段 null（记录仍可见、不 403、不出 0）；
 * 有该权限的**详情**读取写一条 `amount.detail` 审计，列表不记。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001'; // 老板：含所有 view_price
const MANAGER_PHONE = '10000000002'; // 经理：各域只 read，无 view_price
const SALES_PHONE = '10000000003'; // 销售：settlement 只有 read

const MASKED = [
  'totalSaleAmount',
  'totalCostAmount',
  'grossProfit',
  'grossMarginRate',
  'relatedLossAmount',
  'netProfit',
  'commissionAmount',
] as const;

function readHeaders(
  cookie: string,
  requestId: string,
): Record<string, string> {
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

describe('settlement 金额脱敏 + 敏感读审计（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let salesCookie: string;

  async function insertDraft(id: string, orderNo: string, sourceDocId: string): Promise<void> {
    await test.database.query(
      `INSERT INTO settlement_order
         (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
          status, total_sale_amount, total_cost_amount, gross_profit,
          gross_margin_rate, related_loss_amount, net_profit,
          commission_rate_snapshot, commission_amount, version)
       VALUES ($1::uuid, $2, $3::uuid, $4, 'E', $5::uuid,
               '待确认', '100', '70', '30', '0.3', '5', '25',
               '0.05', '1.5', 1)`,
      [
        id,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        orderNo,
        sourceDocId,
      ],
    );
  }

  async function detailOf(
    cookie: string,
    id: string,
    requestId: string,
  ): Promise<SettlementOrder> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/settlement-orders/${id}`,
      headers: readHeaders(cookie, requestId),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as SettlementOrder;
  }

  async function listItems(
    cookie: string,
    requestId: string,
  ): Promise<SettlementOrder[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/settlement-orders?companyId=${DEMO_IDS.companyId}`,
      headers: readHeaders(cookie, requestId),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: SettlementOrder[] }).items;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-mask-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-mask-login-manager');
    salesCookie = await login(app, SALES_PHONE, 'req-mask-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('有看价：详情金额可见，并写一条 amount.detail 敏感读审计', async () => {
    const id = '01900000-0000-7000-8000-000000009401';
    await insertDraft(id, 'C-MASK-0001', '01900000-0000-7000-8000-000000009501');

    const detail = await detailOf(ownerCookie, id, 'req-mask-owner-detail');
    expect(detail.totalSaleAmount).toBe('100');
    expect(detail.totalCostAmount).toBe('70');
    expect(detail.grossProfit).toBe('30');
    expect(detail.grossMarginRate).toBe('0.3');
    expect(detail.relatedLossAmount).toBe('5');
    expect(detail.netProfit).toBe('25');
    expect(detail.commissionAmount).toBe('1.5');

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
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      object_type: 'settlement_order',
      operation_id: 'settlement.order.detail.read',
      domain: 'settlement',
    });
  });

  it('无看价：详情 200 但 7 个金额字段全为 null，比例快照仍可见，且不写敏感读审计', async () => {
    const id = '01900000-0000-7000-8000-000000009402';
    await insertDraft(id, 'C-MASK-0002', '01900000-0000-7000-8000-000000009502');

    const detail = await detailOf(managerCookie, id, 'req-mask-manager-detail');
    for (const field of MASKED) expect(detail[field]).toBeNull();
    expect(detail.commissionRateSnapshot).toBe('0.05');

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'amount.detail' AND object_id = $1`,
      [id],
    );
    expect(audit.rows[0]?.count).toBe('0');
  });

  it('无看价：列表金额同样为 null', async () => {
    const id = '01900000-0000-7000-8000-000000009403';
    await insertDraft(id, 'C-MASK-0003', '01900000-0000-7000-8000-000000009503');

    const items = await listItems(managerCookie, 'req-mask-manager-list');
    const item = items.find((entry) => entry.id === id);
    expect(item).toBeDefined();
    for (const field of MASKED) expect(item?.[field]).toBeNull();
  });

  it('销售（settlement 只有 read）看不到金额', async () => {
    const id = '01900000-0000-7000-8000-000000009404';
    await insertDraft(id, 'C-MASK-0004', '01900000-0000-7000-8000-000000009504');

    const detail = await detailOf(salesCookie, id, 'req-mask-sales-detail');
    for (const field of MASKED) expect(detail[field]).toBeNull();
  });

  it('有看价：列表金额可见，但列表读取不写敏感读审计', async () => {
    const id = '01900000-0000-7000-8000-000000009405';
    await insertDraft(id, 'C-MASK-0005', '01900000-0000-7000-8000-000000009505');

    const items = await listItems(ownerCookie, 'req-mask-owner-list');
    const item = items.find((entry) => entry.id === id);
    expect(item?.totalSaleAmount).toBe('100');
    expect(item?.netProfit).toBe('25');

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'amount.detail' AND object_id = $1`,
      [id],
    );
    expect(audit.rows[0]?.count).toBe('0');
  });
});
