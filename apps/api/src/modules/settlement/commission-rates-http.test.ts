import type { CommissionRate, SettlementOrderDetail } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 提成比例配置 + 确认时算提成（D5④ / D36 / D77）。
 *
 * 覆盖：
 * - 配置 CRUD：老板可用、经理 403、跨公司 403、同员工同生效日 409、删除后 404；
 * - 确认结算：按归属人解析比例并快照、负毛利记 0、无配置记 0、改配置不影响已结算单。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';

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

interface DraftInput {
  readonly id: string;
  readonly orderNo: string;
  readonly sourceDocId: string;
  readonly saleAmount?: string;
  readonly costAmount?: string;
  readonly grossProfit?: string;
  readonly marginRate?: string;
  readonly netProfit?: string;
}

describe('commission 提成配置与确认算提成（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;

  async function insertDraft(input: DraftInput): Promise<void> {
    await test.database.query(
      `INSERT INTO settlement_order
         (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
          status, total_sale_amount, total_cost_amount, gross_profit,
          gross_margin_rate, related_loss_amount, net_profit,
          commission_rate_snapshot, commission_amount, commission_owner_id,
          version)
       VALUES ($1::uuid, $2, $3::uuid, $4, 'E', $5::uuid,
               '待确认', $6::amount, $7::amount, $8::amount,
               $9::amount, '0', $10::amount, '0', '0', $11::uuid, 1)`,
      [
        input.id,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        input.orderNo,
        input.sourceDocId,
        input.saleAmount ?? '100',
        input.costAmount ?? '70',
        input.grossProfit ?? '30',
        input.marginRate ?? '0.3',
        input.netProfit ?? '30',
        DEMO_IDS.ownerEmployeeId,
      ],
    );
  }

  async function createRate(input: {
    employeeId?: string;
    companyId?: string;
    rate?: string;
    effectiveFrom?: string;
    cookie?: string;
    requestId: string;
  }): Promise<{ statusCode: number; body: unknown }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/commission-rates',
      headers: writeHeaders(input.cookie ?? ownerCookie, input.requestId),
      payload: {
        companyId: input.companyId ?? DEMO_IDS.companyId,
        employeeId: input.employeeId ?? DEMO_IDS.ownerEmployeeId,
        rate: input.rate ?? '0.1',
        effectiveFrom: input.effectiveFrom ?? '2026-01-01',
      },
    });
    return { statusCode: response.statusCode, body: response.json() };
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
    ownerCookie = await login(app, OWNER_PHONE, 'req-commission-login-owner');
    managerCookie = await login(
      app,
      MANAGER_PHONE,
      'req-commission-login-manager',
    );
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('配置 CRUD：创建 201 / 重复 409 / 列表可见 / 删除 200 / 再删 404 / 审计落库', async () => {
    const created = await createRate({
      rate: '0.125',
      effectiveFrom: '2026-03-01',
      requestId: 'req-commission-create',
    });
    expect(created.statusCode).toBe(201);
    const rate = created.body as CommissionRate;
    expect(rate).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      employeeId: DEMO_IDS.ownerEmployeeId,
      rate: '0.125',
      effectiveFrom: '2026-03-01',
      createdBy: DEMO_IDS.ownerEmployeeId,
    });

    const duplicate = await createRate({
      rate: '0.2',
      effectiveFrom: '2026-03-01',
      requestId: 'req-commission-dup',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/commission-rates?limit=10',
      headers: readHeaders(ownerCookie, 'req-commission-list'),
    });
    expect(list.statusCode).toBe(200);
    const page = list.json() as { items: CommissionRate[] };
    expect(page.items.map((item) => item.id)).toContain(rate.id);

    const audits = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE action = 'commission.rate.create'
          AND object_type = 'commission_rate'
          AND object_id = $1`,
      [rate.id],
    );
    expect(audits.rows[0]?.count).toBe('1');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/commission-rates/${rate.id}`,
      headers: writeHeaders(ownerCookie, 'req-commission-delete'),
    });
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as CommissionRate).id).toBe(rate.id);

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/commission-rates/${rate.id}`,
      headers: writeHeaders(ownerCookie, 'req-commission-delete-again'),
    });
    expect(again.statusCode).toBe(404);
  });

  it('权限与公司隔离：经理无 commission 权限 403；配到不可见公司 403', async () => {
    const managerList = await app.inject({
      method: 'GET',
      url: '/api/v1/commission-rates',
      headers: readHeaders(managerCookie, 'req-commission-manager-list'),
    });
    expect(managerList.statusCode).toBe(403);
    expect(managerList.json()).toMatchObject({ code: 'FORBIDDEN' });

    const managerCreate = await createRate({
      cookie: managerCookie,
      requestId: 'req-commission-manager-create',
    });
    expect(managerCreate.statusCode).toBe(403);

    const otherCompany = await createRate({
      companyId: '00000000-0000-4000-8000-0000000000ff',
      employeeId: DEMO_IDS.salesEmployeeId,
      requestId: 'req-commission-other-company',
    });
    expect(otherCompany.statusCode).toBe(403);
  });

  it('D80：员工不属于所选公司时拒绝配置（422）', async () => {
    const stranger = await createRate({
      employeeId: '01900000-0000-7000-8000-000000009901',
      effectiveFrom: '2026-02-01',
      requestId: 'req-commission-stranger',
    });
    expect(stranger.statusCode).toBe(422);
    expect(stranger.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('确认结算：按配置比例快照并算提成，改配置不影响已结算单', async () => {
    const draftId = '01900000-0000-7000-8000-000000009611';
    await insertDraft({
      id: draftId,
      orderNo: 'C-0001-20261108-0611',
      sourceDocId: '01900000-0000-7000-8000-000000009711',
    });
    const created = await createRate({
      rate: '0.1',
      effectiveFrom: '2026-01-01',
      requestId: 'req-commission-rate-for-confirm',
    });
    expect(created.statusCode).toBe(201);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/settlement-orders/${draftId}/confirm`,
      headers: writeHeaders(ownerCookie, 'req-commission-confirm', {
        'if-match': '"1"',
        'x-reason': '按 10% 提成',
      }),
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      status: '已结算',
      commissionRateSnapshot: '0.1',
      commissionAmount: '3',
      commissionOwnerId: DEMO_IDS.ownerEmployeeId,
    });

    await test.database.query(
      `UPDATE commission_rate SET rate = '0.5'
        WHERE company_id = $1::uuid AND employee_id = $2::uuid`,
      [DEMO_IDS.companyId, DEMO_IDS.ownerEmployeeId],
    );
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/settlement-orders/${draftId}`,
      headers: readHeaders(ownerCookie, 'req-commission-confirm-detail'),
    });
    expect(detail.statusCode).toBe(200);
    const frozen = detail.json() as SettlementOrderDetail;
    expect(frozen.commissionRateSnapshot).toBe('0.1');
    expect(frozen.commissionAmount).toBe('3');
  });

  it('负毛利与无配置：提成一律记 0', async () => {
    // 负毛利：比例 0.5 也不提成（D5④）。
    await test.database.query(
      `UPDATE commission_rate SET rate = '0.5'
        WHERE company_id = $1::uuid AND employee_id = $2::uuid`,
      [DEMO_IDS.companyId, DEMO_IDS.ownerEmployeeId],
    );
    const negativeId = '01900000-0000-7000-8000-000000009612';
    await insertDraft({
      id: negativeId,
      orderNo: 'C-0001-20261108-0612',
      sourceDocId: '01900000-0000-7000-8000-000000009712',
      saleAmount: '50',
      costAmount: '70',
      grossProfit: '-20',
      marginRate: '-0.4',
      netProfit: '-20',
    });
    const negative = await app.inject({
      method: 'POST',
      url: `/api/v1/settlement-orders/${negativeId}/confirm`,
      headers: writeHeaders(ownerCookie, 'req-commission-negative', {
        'if-match': '"1"',
        'x-reason': '负毛利确认',
      }),
    });
    expect(negative.statusCode).toBe(200);
    expect(negative.json()).toMatchObject({
      commissionRateSnapshot: '0.5',
      commissionAmount: '0',
    });

    // 无配置：销售没配过比例 → 0。
    const noConfigId = '01900000-0000-7000-8000-000000009613';
    await test.database.query(
      `INSERT INTO settlement_order
         (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
          status, total_sale_amount, total_cost_amount, gross_profit,
          gross_margin_rate, related_loss_amount, net_profit,
          commission_rate_snapshot, commission_amount, commission_owner_id,
          version)
       VALUES ($1::uuid, $2, $3::uuid, 'C-0001-20261108-0613', 'E',
               '01900000-0000-7000-8000-000000009713'::uuid, '待确认',
               '100', '70', '30', '0.3', '0', '30', '0', '0',
               $4::uuid, 1)`,
      [noConfigId, DEMO_IDS.tenantId, DEMO_IDS.companyId, DEMO_IDS.salesEmployeeId],
    );
    const noConfig = await app.inject({
      method: 'POST',
      url: `/api/v1/settlement-orders/${noConfigId}/confirm`,
      headers: writeHeaders(ownerCookie, 'req-commission-no-config', {
        'if-match': '"1"',
        'x-reason': '未配提成',
      }),
    });
    expect(noConfig.statusCode).toBe(200);
    expect(noConfig.json()).toMatchObject({
      commissionRateSnapshot: '0',
      commissionAmount: '0',
    });
  });
});
