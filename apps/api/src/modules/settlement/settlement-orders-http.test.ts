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
    // D77 ③：确认时按归属人在本公司的配置解析比例，这里给老板配 5%。
    await test.database.query(
      `UPDATE settlement_order SET commission_owner_id = $1::uuid
        WHERE id = $2::uuid`,
      [DEMO_IDS.ownerEmployeeId, id],
    );
    await test.database.query(
      `INSERT INTO commission_rate
         (id, tenant_id, company_id, employee_id, rate, effective_from, created_by)
       VALUES ('01900000-0000-7000-8000-000000009501', $1, $2::uuid, $3::uuid,
               '0.05', CURRENT_DATE, $3::uuid)`,
      [DEMO_IDS.tenantId, DEMO_IDS.companyId, DEMO_IDS.ownerEmployeeId],
    );
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
        scope: [{ domain: 'settlement', actions: ['read', 'approve', 'view_price'] }],
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
          AND action <> 'amount.detail'
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

  it('确认：有 approve 但无 settlement.view_price 时 403，状态不推进（P0-13）', async () => {
    const id = '01900000-0000-7000-8000-000000009601';
    await insertDraft({
      id,
      orderNo: 'C-0001-20261107-0601',
      sourceDocId: '01900000-0000-7000-8000-000000009602',
    });

    // 经理岗默认只有 settlement.read：这里补授 approve，但不授 view_price。
    await test.database.query(
      `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
       VALUES ($1, '01900000-0000-7000-8000-000000000012', 'settlement', 'approve', true)`,
      [DEMO_IDS.tenantId],
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/settlement-orders/${id}/confirm`,
      headers: writeHeaders(
        managerCookie,
        'req-settlement-confirm-no-view-price',
        { 'if-match': '"1"', 'x-reason': '经理尝试确认结算' },
      ),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: '缺少 settlement.view_price 权限',
    });

    const state = await test.database.query<{ status: string }>(
      `SELECT status FROM settlement_order WHERE id = $1::uuid`,
      [id],
    );
    expect(state.rows[0]?.status).toBe('待确认');
  });

  it('撤销：If-Match / approve / view_price / reason / AI 校验（422 / 428 / 409 / 403）', async () => {
    const id = '01900000-0000-7000-8000-000000009b01';
    await insertDraft({
      id,
      orderNo: 'C-0001-20261108-0b01',
      sourceDocId: '01900000-0000-7000-8000-000000009b02',
    });
    const url = `/api/v1/settlement-orders/${id}/unsettle`;
    const body = { confirm: true, reason: '财务复核发现错单' };
    // 经理岗补授 approve 但不授 view_price（上一个用例已插；这里兜底防止用例顺序变化）。
    await test.database.query(
      `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
       VALUES ($1, '01900000-0000-7000-8000-000000000012', 'settlement', 'approve', true)
       ON CONFLICT DO NOTHING`,
      [DEMO_IDS.tenantId],
    );

    const missingIfMatch = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(ownerCookie, 'req-settlement-unsettle-428'),
      payload: body,
    });
    expect(missingIfMatch.statusCode).toBe(428);
    expect(missingIfMatch.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const missingReason = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(ownerCookie, 'req-settlement-unsettle-reason', {
        'if-match': '"1"',
      }),
      payload: { confirm: true },
    });
    expect(missingReason.statusCode).toBe(422);
    expect(missingReason.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const stale = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(ownerCookie, 'req-settlement-unsettle-409', {
        'if-match': '"9"',
      }),
      payload: body,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const noApprove = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(warehouseCookie, 'req-settlement-unsettle-403', {
        'if-match': '"1"',
      }),
      payload: body,
    });
    expect(noApprove.statusCode).toBe(403);
    expect(noApprove.json()).toMatchObject({ code: 'FORBIDDEN' });

    // 经理岗已被上一个用例补授 settlement.approve，但没有 settlement.view_price。
    const noViewPrice = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(managerCookie, 'req-settlement-unsettle-no-view-price', {
        'if-match': '"1"',
      }),
      payload: body,
    });
    expect(noViewPrice.statusCode).toBe(403);
    expect(noViewPrice.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: '缺少 settlement.view_price 权限',
    });

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-settlement-unsettle-ai-token'),
      payload: {
        name: 'Settlement Unsettle AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'settlement', actions: ['read', 'approve', 'view_price'] }],
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
        'x-request-id': 'req-settlement-unsettle-ai-no-reason',
      },
      payload: body,
    });
    expect(aiWithoutReason.statusCode).toBe(422);
    expect(aiWithoutReason.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const aiForbidden = await app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${secret}`,
        'if-match': '"1"',
        'x-reason': 'AI 尝试撤销结算',
        'x-request-id': 'req-settlement-unsettle-ai-forbidden',
      },
      payload: body,
    });
    expect(aiForbidden.statusCode).toBe(403);
    expect(aiForbidden.json()).toMatchObject({ code: 'AI_ACTION_FORBIDDEN' });

    const state = await test.database.query<{ status: string; version: number }>(
      `SELECT status, version FROM settlement_order WHERE id = $1::uuid`,
      [id],
    );
    expect(state.rows[0]).toEqual({ status: '待确认', version: 1 });
  });

  it('撤销：待确认单 422；已结算单 200 清空快照、留审计、可再次确认', async () => {
    const draftId = '01900000-0000-7000-8000-000000009c01';
    await insertDraft({
      id: draftId,
      orderNo: 'C-0001-20261108-0c01',
      sourceDocId: '01900000-0000-7000-8000-000000009c02',
    });
    const draftUnsettle = await app.inject({
      method: 'POST',
      url: `/api/v1/settlement-orders/${draftId}/unsettle`,
      headers: writeHeaders(ownerCookie, 'req-settlement-unsettle-draft', {
        'if-match': '"1"',
      }),
      payload: { confirm: true, reason: '误操作' },
    });
    expect(draftUnsettle.statusCode).toBe(422);
    expect(draftUnsettle.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: '结算单尚未结算，无需撤销',
    });

    const id = '01900000-0000-7000-8000-000000009d01';
    await insertDraft({
      id,
      orderNo: 'C-0001-20261108-0d01',
      sourceDocId: '01900000-0000-7000-8000-000000009d02',
    });
    // 模拟一张已确认、已冻结快照的结算单。
    await test.database.query(
      `UPDATE settlement_order
          SET status = '已结算',
              settled_at = now(),
              related_loss_amount_snapshot = related_loss_amount,
              commission_owner_id = $2::uuid
        WHERE id = $1::uuid`,
      [id, DEMO_IDS.ownerEmployeeId],
    );
    const url = `/api/v1/settlement-orders/${id}/unsettle`;

    const response = await app.inject({
      method: 'POST',
      url,
      headers: writeHeaders(ownerCookie, 'req-settlement-unsettle-ok', {
        'if-match': '"1"',
        'x-reason': '财务复核发现错单',
      }),
      payload: { confirm: true, reason: '财务复核发现错单' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(response.json()).toMatchObject({
      id,
      status: '待确认',
      version: 2,
      relatedLossAmount: null,
      netProfit: null,
      commissionRateSnapshot: null,
      commissionAmount: null,
    });

    const row = await test.database.query<{
      status: string;
      settled_at: Date | null;
      related_loss_amount_snapshot: string | null;
    }>(
      `SELECT status, settled_at, related_loss_amount_snapshot
         FROM settlement_order WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rows[0]?.status).toBe('待确认');
    expect(row.rows[0]?.settled_at).toBeNull();
    expect(row.rows[0]?.related_loss_amount_snapshot).toBeNull();

    const audit = await test.database.query<{
      action: string;
      result: string;
      reason: string | null;
      changes: Record<string, unknown>;
    }>(
      `SELECT action, result, reason, changes
         FROM audit_log
        WHERE object_id = $1
          AND action = 'settlement.order.unsettle'`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'settlement.order.unsettle',
      result: 'success',
      reason: '财务复核发现错单',
      changes: {
        beforeStatus: '已结算',
        afterStatus: '待确认',
        version: 2,
        reason: '财务复核发现错单',
        relatedLossAmount: '5',
        netProfit: '25',
        commissionRateSnapshot: '0.05',
        commissionAmount: '1.5',
      },
    });

    // 不锁死：撤销后可再次确认，提成按当时配置重新快照（D77 ③ / D88）。
    await test.database.query(
      `INSERT INTO commission_rate
         (id, tenant_id, company_id, employee_id, rate, effective_from, created_by)
       VALUES ('01900000-0000-7000-8000-000000009d03', $1, $2::uuid, $3::uuid,
               '0.1', CURRENT_DATE, $3::uuid)
       ON CONFLICT (tenant_id, company_id, employee_id, effective_from)
       DO UPDATE SET rate = EXCLUDED.rate`,
      [DEMO_IDS.tenantId, DEMO_IDS.companyId, DEMO_IDS.ownerEmployeeId],
    );
    const reconfirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/settlement-orders/${id}/confirm`,
      headers: writeHeaders(ownerCookie, 'req-settlement-reconfirm-ok', {
        'if-match': '"2"',
        'x-reason': '重新确认',
      }),
    });
    expect(reconfirmed.statusCode).toBe(200);
    expect(reconfirmed.headers.etag).toBe('"3"');
    expect(reconfirmed.json()).toMatchObject({
      id,
      status: '已结算',
      version: 3,
      relatedLossAmount: '0',
      netProfit: '30',
      commissionRateSnapshot: '0.1',
      commissionAmount: '3',
    });
  });
});
