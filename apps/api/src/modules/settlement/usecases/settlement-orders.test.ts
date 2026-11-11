import {
  AppError,
  type ScopeMatrix,
  type SettlementOrder,
  type SettlementOrderDetail,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../testing/pglite.js';
import {
  confirmSettlementOrder,
  getSettlementOrder,
  listSettlementOrders,
} from './settlement-orders.js';

/**
 * C 结算单用例 / 数据访问（D15 / D19 / D26 / D51 / D52 / D69）。
 */

const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000008001';

const APPROVE_SCOPE: ScopeMatrix = [
  { domain: 'settlement', actions: ['read', 'approve', 'view_price'] },
];
const READ_ONLY_SCOPE: ScopeMatrix = [
  { domain: 'settlement', actions: ['read', 'view_price'] },
];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly auditReason?: string | null;
}

function makeRequest(input: FakeRequestInput): FastifyRequest {
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: input.query ?? {},
    headers: input.headers ?? {},
    ip: '127.0.0.1',
    auditSource: 'web',
    auditReason: input.auditReason ?? null,
  } as unknown as FastifyRequest;
}

function makeReply(): {
  reply: FastifyReply;
  state: { statusCode: number; headers: Record<string, string> };
} {
  const state = { statusCode: 200, headers: {} as Record<string, string> };
  const reply = {
    status(code: number) {
      state.statusCode = code;
      return reply;
    },
    header(name: string, value: string) {
      state.headers[name] = value;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    actorType: 'employee',
    actorId: DEMO_IDS.ownerEmployeeId,
    tenantId: DEMO_IDS.tenantId,
    employeeId: DEMO_IDS.ownerEmployeeId,
    credentialId: 'session-test',
    companyIds: [DEMO_IDS.companyId],
    scope: APPROVE_SCOPE,
    source: 'web',
    credentialType: 'session',
    sessionRenewed: false,
    ...overrides,
  };
}

function aiPrincipal(overrides: Partial<Principal> = {}): Principal {
  return principal({
    actorType: 'ai',
    credentialId: 'token-test',
    ...overrides,
  });
}

async function expectAppError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

interface DraftInput {
  readonly id: string;
  readonly orderNo: string;
  readonly sourceDocId: string;
  readonly companyId?: string;
  readonly sourceDocType?: 'E' | 'N';
  readonly status?: '待确认' | '已结算';
  readonly relatedLossAmount?: string;
  readonly netProfit?: string;
  readonly version?: number;
}

describe('settlement C 结算单用例（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;

  function readCtx(
    overrides: Partial<Principal> = {},
    parts: Partial<FakeRequestInput> = {},
  ) {
    return {
      database: test.database,
      request: makeRequest({ principal: principal(overrides), ...parts }),
    };
  }

  function confirmCtx(
    id: string,
    overrides: Partial<Principal> = {},
    parts: Partial<FakeRequestInput> = {},
  ) {
    const { reply, state } = makeReply();
    return {
      ctx: {
        database: test.database,
        request: makeRequest({
          principal: principal(overrides),
          params: { id },
          ...parts,
        }),
        reply,
      },
      state,
    };
  }

  async function insertDraft(input: DraftInput): Promise<void> {
    const status = input.status ?? '待确认';
    const relatedLossAmount = input.relatedLossAmount ?? '5';
    const netProfit = input.netProfit ?? '25';
    await test.database.query(
      `INSERT INTO settlement_order
         (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
          status, total_sale_amount, total_cost_amount, gross_profit,
          gross_margin_rate, related_loss_amount,
          related_loss_amount_snapshot, net_profit,
          commission_rate_snapshot, commission_amount, version, settled_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid, $7,
               '100', '70', '30', '0.3', $8::amount, $9::amount, $10::amount,
               '0.05', '1.5', $11,
               CASE WHEN $7 = '已结算' THEN now() ELSE NULL END)`,
      [
        input.id,
        DEMO_IDS.tenantId,
        input.companyId ?? DEMO_IDS.companyId,
        input.orderNo,
        input.sourceDocType ?? 'E',
        input.sourceDocId,
        status,
        relatedLossAmount,
        status === '已结算' ? relatedLossAmount : null,
        netProfit,
        input.version ?? 1,
      ],
    );
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '结算二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('列表 / 详情：公司、状态、来源类型、单号过滤；跨公司不可见；普通读不记审计', async () => {
    await insertDraft({
      id: '01900000-0000-7000-8000-000000008101',
      orderNo: 'C-0001-20261105-0101',
      sourceDocId: '01900000-0000-7000-8000-000000008201',
      sourceDocType: 'E',
    });
    await insertDraft({
      id: '01900000-0000-7000-8000-000000008102',
      orderNo: 'C-0001-20261105-0102',
      sourceDocId: '01900000-0000-7000-8000-000000008202',
      sourceDocType: 'N',
    });
    await insertDraft({
      id: '01900000-0000-7000-8000-000000008103',
      orderNo: 'C-0002-20261105-0103',
      sourceDocId: '01900000-0000-7000-8000-000000008203',
      companyId: OTHER_COMPANY_ID,
    });

    const page = await listSettlementOrders(
      readCtx(
        {},
        {
          query: {
            companyId: DEMO_IDS.companyId,
            status: '待确认',
            sourceDocType: 'E',
            keyword: '0101',
          },
        },
      ),
    );
    expect(page.items.map((item) => item.orderNo)).toEqual([
      'C-0001-20261105-0101',
    ]);
    expect(page.nextCursor).toBeNull();

    const detail = (await getSettlementOrder(
      readCtx(
        {},
        { params: { id: '01900000-0000-7000-8000-000000008101' } },
      ),
    )) as SettlementOrderDetail;
    expect(detail).toMatchObject({
      id: '01900000-0000-7000-8000-000000008101',
      sourceDocType: 'E',
      status: '待确认',
      totalSaleAmount: '100',
      totalCostAmount: '70',
      grossProfit: '30',
      grossMarginRate: '0.3',
      relatedLossAmount: '5',
      netProfit: '25',
      commissionRateSnapshot: '0.05',
      commissionAmount: '1.5',
      confirmable: { allowed: true, reason: null },
    });

    const outside = await listSettlementOrders(
      readCtx(
        { companyIds: [OTHER_COMPANY_ID] },
        { query: { keyword: 'C-0001-20261105-0101' } },
      ),
    );
    expect(outside.items).toHaveLength(0);
    await expectAppError(
      getSettlementOrder(
        readCtx(
          { companyIds: [OTHER_COMPANY_ID] },
          { params: { id: detail.id } },
        ),
      ),
      'NOT_FOUND',
    );

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

  it('确认：approve + reason / AI / If-Match 校验；冻结 D69 快照；重复确认拒绝且落审计', async () => {
    const id = '01900000-0000-7000-8000-000000008301';
    await insertDraft({
      id,
      orderNo: 'C-0001-20261105-0301',
      sourceDocId: '01900000-0000-7000-8000-000000008401',
    });

    await expectAppError(
      confirmSettlementOrder(confirmCtx(id).ctx),
      'PRECONDITION_REQUIRED',
    );

    await expectAppError(
      confirmSettlementOrder(
        confirmCtx(
          id,
          { scope: READ_ONLY_SCOPE },
          { headers: { 'if-match': '"1"' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );

    await expectAppError(
      confirmSettlementOrder(
        confirmCtx(
          id,
          {},
          { headers: { 'if-match': '"9"' } },
        ).ctx,
      ),
      'VERSION_CONFLICT',
    );

    await expectAppError(
      confirmSettlementOrder(
        confirmCtx(
          id,
          aiPrincipal(),
          { headers: { 'if-match': '"1"' }, auditReason: null },
        ).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      confirmSettlementOrder(
        confirmCtx(
          id,
          aiPrincipal(),
          {
            headers: { 'if-match': '"1"' },
            auditReason: 'AI 尝试确认结算',
          },
        ).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    const confirmedCtx = confirmCtx(
      id,
      {},
      {
        headers: { 'if-match': '"1"' },
        auditReason: '财务复核确认',
      },
    );
    const confirmed = await confirmSettlementOrder(confirmedCtx.ctx);
    expect(confirmedCtx.state.headers.ETag).toBe('"2"');
    expect(confirmed).toMatchObject({
      id,
      status: '已结算',
      version: 2,
      relatedLossAmount: '5',
      netProfit: '25',
      confirmable: {
        allowed: false,
        reason: 'already_settled',
      },
    });

    // 模拟后续损耗重算只更新当前损失列：已结算单仍读取确认时快照（D69）。
    await test.database.query(
      `UPDATE settlement_order
          SET related_loss_amount = '9'
        WHERE id = $1::uuid`,
      [id],
    );
    const frozen = (await getSettlementOrder(
      readCtx({}, { params: { id } }),
    )) as SettlementOrder;
    expect(frozen.relatedLossAmount).toBe('5');
    expect(frozen.netProfit).toBe('25');

    await expectAppError(
      confirmSettlementOrder(
        confirmCtx(
          id,
          {},
          { headers: { 'if-match': '"2"' } },
        ).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const audits = await test.database.query<{
      action: string;
      result: string;
      reason: string | null;
    }>(
      `SELECT action, result, reason
         FROM audit_log
        WHERE object_id = $1
          AND action <> 'amount.detail'
        ORDER BY occurred_at, id`,
      [id],
    );
    expect(audits.rows).toEqual([
      {
        action: 'settlement.order.confirm',
        result: 'success',
        reason: '财务复核确认',
      },
    ]);
  });

  it('确认响应同样按看价脱敏：有 approve 但无 view_price 时金额为 null（D78）', async () => {
    const id = '01900000-0000-7000-8000-000000008901';
    await insertDraft({
      id,
      orderNo: 'C-0001-20261107-0901',
      sourceDocId: '01900000-0000-7000-8000-000000008902',
    });
    const noViewPrice: ScopeMatrix = [
      { domain: 'settlement', actions: ['read', 'approve'] },
    ];

    const confirmed = await confirmSettlementOrder(
      confirmCtx(
        id,
        { scope: noViewPrice },
        { headers: { 'if-match': '"1"' }, auditReason: '财务复核确认' },
      ).ctx,
    );

    expect(confirmed.status).toBe('已结算');
    expect(confirmed.totalSaleAmount).toBeNull();
    expect(confirmed.grossProfit).toBeNull();
    expect(confirmed.netProfit).toBeNull();
    expect(confirmed.commissionAmount).toBeNull();
    // 比例不是金额，不脱敏；本单无归属人 → 快照 0（D77 ③）。
    expect(confirmed.commissionRateSnapshot).toBe('0');
  });
});
