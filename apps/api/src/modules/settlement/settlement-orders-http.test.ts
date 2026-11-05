import type {
  SettlementOrder,
  SettlementOrderDetail,
} from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * settlement C 结算单 HTTP 层（D15 / D19 / D51 / D52 / D69）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const WAREHOUSE_PHONE = '10000000004';

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
  readonly sourceDocType?: 'E' | 'N';
}

describe('settlement C 结算单 HTTP（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let warehouseCookie: string;

  async function insertDraft(input: DraftInput): Promise<void> {
    await test.database.query(
      `INSERT INTO settlement_order
         (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
          status, total_sale_amount, total_cost_amount, gross_profit,
          gross_margin_rate, related_loss_amount, net_profit,
          commission_rate_snapshot, commission_amount, version)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid,
               '待确认', '100', '70', '30', '0.3', '5', '25',
               '0.05', '1.5', 1)`,
      [
        input.id,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        input.orderNo,
        input.sourceDocType ?? 'E',
        input.sourceDocId,
      ],
    );
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
    ownerCookie = await login(app, OWNER_PHONE, 'req-settlement-login-owner');
    managerCookie = await login(
      app,
      MANAGER_PHONE,
      'req-settlement-login-manager',
    );
    warehouseCookie = await login(
      app,
      WAREHOUSE_PHONE,
      'req-settlement-login-warehouse',
    );
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 401；无 settlement.read 403；列表 / 详情 200；普通读不记审计', async () => {
    const id = '01900000-0000-7000-8000-000000009101';
    await insertDraft({
      id,
      orderNo: 'C-0001-20261105-0201',
      sourceDocId: '01900000-0000-7000-8000-000000009201',
      sourceDocType: 'N',
    });

    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/settlement-orders',
      headers: { 'x-request-id': 'req-settlement-anonymous' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    const noPermission = await app.inject({
      method: 'GET',
      url: '/api/v1/settlement-orders',
      headers: readHeaders(
        warehouseCookie,
        'req-settlement-no-permission',
      ),
    });
    expect(noPermission.statusCode).toBe(403);
    expect(noPermission.json()).toMatchObject({ code: 'FORBIDDEN' });

    const list = await app.inject({
      method: 'GET',
      url:
        `/api/v1/settlement-orders?companyId=${DEMO_IDS.companyId}` +
        `&status=${encodeURIComponent('待确认')}` +
        '&sourceDocType=N' +
        '&keyword=0201',
      headers: readHeaders(ownerCookie, 'req-settlement-list-ok'),
    });
    expect(list.statusCode).toBe(200);
    const page = list.json() as {
      items: SettlementOrder[];
      nextCursor: string | null;
    };
    expect(page.items.map((item) => item.id)).toEqual([id]);
    expect(page.nextCursor).toBeNull();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/settlement-orders/${id}`,
      headers: readHeaders(ownerCookie, 'req-settlement-detail-ok'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect(detail.json()).toMatchObject({
      id,
      sourceDocType: 'N',
      status: '待确认',
      relatedLossAmount: '5',
      netProfit: '25',
      confirmable: { allowed: true, reason: null },
    });

    const reads = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action IN (
          'settlement.order.list.read',
          'settlement.order.detail.read'
        )`,
    );
    expect(reads.rows[0]?.count).toBe('0');
  });

  it('确认：If-Match / approve / AI reason 校验；成功后冻结快照、审计并拒绝重复确认', async () => {
    const id = '01900000-0000-7000-8000-000000009301';
    await insertDraft({
      id,
      orderNo: 'C-0001-20261105-0301',
      sourceDocId: '01900000-0000-7000-8000-000000009401',
    });
    const url = `/api/v1/settlement-orders/${id}/confirm`;

    const missingIfMatch = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(ownerCookie, 'req-settlement-confirm-428'),
    });
    expect(missingIfMatch.statusCode).toBe(428);
    expect(missingIfMatch.json()).toMatchObject({
      code: 'PRECONDITION_REQUIRED',
    });

    const noApprove = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(managerCookie, 'req-settlement-confirm-403', {
        'if-match': '"1"',
      }),
    });
    expect(noApprove.statusCode).toBe(403);
    expect(noApprove.json()).toMatchObject({ code: 'FORBIDDEN' });

    const stale = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(ownerCookie, 'req-settlement-confirm-409', {
        'if-match': '"9"',
      }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-settlement-ai-token'),
      payload: {
        name: 'Settlement AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'settlement', actions: ['read', 'approve'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const aiWithoutReason = await app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${secret}`,
        'if-match': '"1"',
        'x-request-id': 'req-settlement-ai-no-reason',
      },
    });
    expect(aiWithoutReason.statusCode).toBe(422);
    expect(aiWithoutReason.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    const aiForbidden = await app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${secret}`,
        'if-match': '"1"',
        'x-reason': 'AI 尝试确认结算',
        'x-request-id': 'req-settlement-ai-forbidden',
      },
    });
    expect(aiForbidden.statusCode).toBe(403);
    expect(aiForbidden.json()).toMatchObject({
      code: 'AI_ACTION_FORBIDDEN',
    });

    const confirmed = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(ownerCookie, 'req-settlement-confirm-ok', {
        'if-match': '"1"',
        'x-reason': '财务复核确认',
      }),
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.headers.etag).toBe('"2"');
    expect(confirmed.json()).toMatchObject({
      id,
      status: '已结算',
      version: 2,
      relatedLossAmount: '5',
      netProfit: '25',
      commissionRateSnapshot: '0.05',
      commissionAmount: '1.5',
      confirmable: {
        allowed: false,
        reason: 'already_settled',
      },
    });

    await test.database.query(
      `UPDATE settlement_order
          SET related_loss_amount = '9'
        WHERE id = $1::uuid`,
      [id],
    );
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/settlement-orders/${id}`,
      headers: readHeaders(ownerCookie, 'req-settlement-frozen-detail'),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as SettlementOrderDetail).relatedLossAmount).toBe('5');
    expect((detail.json() as SettlementOrderDetail).netProfit).toBe('25');

    const repeated = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(
        ownerCookie,
        'req-settlement-confirm-repeated',
        { 'if-match': '"2"' },
      ),
    });
    expect(repeated.statusCode).toBe(422);
    expect(repeated.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const audit = await test.database.query<{
      action: string;
      result: string;
      reason: string | null;
    }>(
      `SELECT action, result, reason
         FROM audit_log
        WHERE object_id = $1
          AND result = 'success'`,
      [id],
    );
    expect(audit.rows).toEqual([
      {
        action: 'settlement.order.confirm',
        result: 'success',
        reason: '财务复核确认',
      },
    ]);

    const failures = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE object_id = $1
          AND action = 'settlement.order.confirm'
          AND result = 'fail'`,
      [id],
    );
    expect(Number(failures.rows[0]?.count)).toBeGreaterThanOrEqual(4);
  });
});
