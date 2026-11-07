import { AppError, type InternalTradeOrder, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { registerServices, resetServices } from '../../../platform/services/registry.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../testing/pglite.js';
import { inventoryServices } from '../../inventory/services/ports.js';
import { settlementServices } from '../../settlement/services/drafts.js';
import {
  createInternalTradeOrder,
  getInternalTradeOrder,
  receiveInternalTradeOrder,
  shipInternalTradeOrder,
} from './internal-trade-orders.js';

/**
 * N 单到货确认 / 转司（D22 / D31 / D29 / D74 / D75）。
 *
 * 覆盖：状态推进、在途占用释放、批次归属转接收公司、C 草稿金额（售价=Σ行金额、
 * 成本=Σ(量×批次锁价)、提成 0、来源 N）、只有接收方可确认、AI 禁止、
 * 状态/版本/If-Match 校验、C 草稿已存在时整单回滚（批次不被转走）。
 */

const TO_COMPANY_ID = '01900000-0000-7000-8000-000000007101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000007111';

const FULL_SCOPE: ScopeMatrix = [
  {
    domain: 'internal_trade',
    actions: ['read', 'create', 'update', 'delete'],
  },
];

const READ_ONLY_SCOPE: ScopeMatrix = [
  { domain: 'internal_trade', actions: ['read'] },
];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

function makeRequest(input: FakeRequestInput): FastifyRequest {
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: {},
    body: input.body,
    headers: input.headers ?? {},
    ip: '127.0.0.1',
    auditSource: 'web',
    auditReason: '到货确认测试',
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
    send() {
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
    companyIds: [DEMO_IDS.companyId, TO_COMPANY_ID],
    scope: FULL_SCOPE,
    source: 'web',
    credentialType: 'session',
    sessionRenewed: false,
    ...overrides,
  };
}

async function expectAppError(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const promise = action();
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('internal-trade N 单到货确认 / 转司（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let batchSeq = 0;

  function writeCtx(
    overrides: Partial<Principal> = {},
    parts: Partial<FakeRequestInput> = {},
  ) {
    const { reply, state } = makeReply();
    return {
      ctx: {
        database: test.database,
        request: makeRequest({ principal: principal(overrides), ...parts }),
        reply,
      },
      state,
    };
  }

  async function freshBatch(inbound = '1000', cost = '10'): Promise<string> {
    batchSeq += 1;
    const id = `01900000-0000-7000-8000-0000000072${String(batchSeq).padStart(2, '0')}`;
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '0', '0', '0', $8)`,
      [
        id,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        `N-RECV-${batchSeq}`,
        cost,
        inbound,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
    return id;
  }

  async function createShippedOrder(
    qty: string,
    batchIds: readonly string[],
    unitPrice = '25',
  ): Promise<InternalTradeOrder> {
    const { ctx } = writeCtx({}, {
      body: {
        fromCompanyId: DEMO_IDS.companyId,
        toCompanyId: TO_COMPANY_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds: [...batchIds],
            qty,
            unitPrice,
            amount: '0',
          },
        ],
        internalPrice: '999',
      },
    });
    const created = await createInternalTradeOrder(ctx);
    const shipped = await shipInternalTradeOrder(
      writeCtx(
        {},
        { params: { id: created.id }, headers: { 'if-match': `"${created.version}"` } },
      ).ctx,
    );
    expect(shipped.status).toBe('在途');
    return shipped;
  }

  async function batchState(batchId: string) {
    const result = await test.database.query<{
      in_transit_qty: string;
      available_qty: string;
      company_id: string;
    }>(
      `SELECT trim_scale(in_transit_qty) AS in_transit_qty,
              trim_scale(available_qty) AS available_qty,
              company_id
         FROM inventory_batch
        WHERE id = $1`,
      [batchId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`批次 ${batchId} 不存在`);
    return row;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // D70：用例测试不走 registerModules，这里显式注册 inventory 与 settlement 两个端口。
    resetServices();
    registerServices(inventoryServices);
    registerServices(settlementServices);

    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '内部交易接收公司3', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [TO_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '转司测试商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
  });

  afterAll(async () => {
    resetServices();
    await test.database.close();
  });

  it('确认到货：在途 → 已完成，释放在途占用、批次转接收公司、生成 C 草稿（提成 0）', async () => {
    const batchA = await freshBatch('1000', '10');
    const batchB = await freshBatch('1000', '20');
    const shipped = await createShippedOrder('2', [batchA, batchB], '25');

    const { ctx, state } = writeCtx(
      {},
      {
        params: { id: shipped.id },
        headers: { 'if-match': `"${shipped.version}"` },
      },
    );
    const received = await receiveInternalTradeOrder(ctx);

    expect(received.status).toBe('已完成');
    expect(received.inTransitQty).toBe('0');
    expect(received.version).toBe(shipped.version + 1);
    expect(state.headers.ETag).toBe(`"${received.version}"`);

    // 批次：在途归零、可用量恢复到 1000、归属变成接收公司
    expect(await batchState(batchA)).toMatchObject({
      in_transit_qty: '0',
      available_qty: '1000',
      company_id: TO_COMPANY_ID,
    });
    expect(await batchState(batchB)).toMatchObject({
      in_transit_qty: '0',
      available_qty: '1000',
      company_id: TO_COMPANY_ID,
    });

    // C 草稿（D75）：售价 = Σ行金额 = 2×25；成本 = 1×10 + 1×20；提成 0；归属发出公司
    const drafts = await test.database.query<{
      company_id: string;
      source_doc_type: string;
      total_sale_amount: string;
      total_cost_amount: string;
      gross_profit: string;
      commission_amount: string;
      status: string;
    }>(
      `SELECT company_id,
              source_doc_type,
              trim_scale(total_sale_amount) AS total_sale_amount,
              trim_scale(total_cost_amount) AS total_cost_amount,
              trim_scale(gross_profit) AS gross_profit,
              trim_scale(commission_amount) AS commission_amount,
              status
         FROM settlement_order
        WHERE source_doc_id = $1`,
      [shipped.id],
    );
    expect(drafts.rows).toHaveLength(1);
    expect(drafts.rows[0]).toMatchObject({
      company_id: DEMO_IDS.companyId,
      source_doc_type: 'N',
      total_sale_amount: '50',
      total_cost_amount: '30',
      gross_profit: '20',
      commission_amount: '0',
    });

    // 审批审计：批次保管人快照 + 转司前后公司
    const audit = await test.database.query<{ changes: unknown }>(
      `SELECT changes
         FROM audit_log
        WHERE object_id = $1
          AND action = 'internal_trade.order.receive'
        ORDER BY created_at DESC
        LIMIT 1`,
      [shipped.id],
    );
    expect(audit.rows[0]?.changes).toMatchObject({
      beforeStatus: '在途',
      afterStatus: '已完成',
      transferredBatchCount: 2,
      fromCompanyId: DEMO_IDS.companyId,
      toCompanyId: TO_COMPANY_ID,
      totalSaleAmount: '50',
      totalCostAmount: '30',
      commissionRateSnapshot: '0',
    });

    // 转司不改数量 → 不写库存流水（D74 ⑤）
    const flows = await test.database.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM inventory_flow
        WHERE source_doc_id = $1`,
      [shipped.id],
    );
    expect(flows.rows[0]?.count).toBe(0);
  });

  it('权限：只有接收公司可确认（发出方 403）；只读 403；AI 禁止；失败不转司也不出草稿', async () => {
    const batch = await freshBatch();
    const shipped = await createShippedOrder('1', [batch]);

    const fromOnly = writeCtx(
      { companyIds: [DEMO_IDS.companyId] },
      { params: { id: shipped.id }, headers: { 'if-match': `"${shipped.version}"` } },
    );
    await expectAppError(() => receiveInternalTradeOrder(fromOnly.ctx), 'FORBIDDEN');

    const readOnly = writeCtx(
      { scope: READ_ONLY_SCOPE },
      { params: { id: shipped.id }, headers: { 'if-match': `"${shipped.version}"` } },
    );
    await expectAppError(() => receiveInternalTradeOrder(readOnly.ctx), 'FORBIDDEN');

    const ai = writeCtx(
      { actorType: 'ai', credentialId: 'token-test' },
      { params: { id: shipped.id }, headers: { 'if-match': `"${shipped.version}"` } },
    );
    await expectAppError(() => receiveInternalTradeOrder(ai.ctx), 'AI_ACTION_FORBIDDEN');

    // 批次仍在发出公司、仍有在途占用、没有 C 草稿
    expect(await batchState(batch)).toMatchObject({
      company_id: DEMO_IDS.companyId,
      in_transit_qty: '1',
    });
    const drafts = await test.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM settlement_order WHERE source_doc_id = $1`,
      [shipped.id],
    );
    expect(drafts.rows[0]?.count).toBe(0);
  });

  it('状态 / 版本 / If-Match：进行中不能确认 422；重复确认 422；版本过期 409；缺 If-Match 428', async () => {
    // 进行中（未发货）直接确认
    const batch = await freshBatch();
    const { ctx: createCtx } = writeCtx({}, {
      body: {
        fromCompanyId: DEMO_IDS.companyId,
        toCompanyId: TO_COMPANY_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds: [batch],
            qty: '1',
            unitPrice: '10',
            amount: '0',
          },
        ],
        internalPrice: '10',
      },
    });
    const created = await createInternalTradeOrder(createCtx);
    const notShipped = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': `"${created.version}"` } },
    );
    await expectAppError(() => receiveInternalTradeOrder(notShipped.ctx), 'VALIDATION_FAILED');

    // 已确认之后再确认
    const shipped = await createShippedOrder('1', [await freshBatch()]);
    const first = writeCtx(
      {},
      { params: { id: shipped.id }, headers: { 'if-match': `"${shipped.version}"` } },
    );
    const received = await receiveInternalTradeOrder(first.ctx);
    const again = writeCtx(
      {},
      { params: { id: shipped.id }, headers: { 'if-match': `"${received.version}"` } },
    );
    await expectAppError(() => receiveInternalTradeOrder(again.ctx), 'VALIDATION_FAILED');

    const stale = writeCtx(
      {},
      { params: { id: shipped.id }, headers: { 'if-match': '"99"' } },
    );
    await expectAppError(() => receiveInternalTradeOrder(stale.ctx), 'VERSION_CONFLICT');

    const missing = writeCtx({}, { params: { id: shipped.id } });
    await expectAppError(() => receiveInternalTradeOrder(missing.ctx), 'PRECONDITION_REQUIRED');
  });

  it('C 草稿已存在时整单回滚：批次不被转走、状态仍在途', async () => {
    const batch = await freshBatch();
    const shipped = await createShippedOrder('1', [batch]);

    // 预先插一条同来源的 C 单，占住 (tenant, N, source_doc_id) 唯一键
    await test.database.query(
      `INSERT INTO settlement_order
         (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
          total_sale_amount, total_cost_amount, gross_profit, gross_margin_rate,
          related_loss_amount, net_profit, commission_rate_snapshot, commission_amount)
       VALUES (gen_random_uuid(), $1, $2, 'C-DUP-0001', 'N', $3,
               '0', '0', '0', '0', '0', '0', '0', '0')`,
      [DEMO_IDS.tenantId, DEMO_IDS.companyId, shipped.id],
    );

    const { ctx } = writeCtx(
      {},
      { params: { id: shipped.id }, headers: { 'if-match': `"${shipped.version}"` } },
    );
    await expectAppError(() => receiveInternalTradeOrder(ctx), 'VERSION_CONFLICT');

    expect(await batchState(batch)).toMatchObject({
      company_id: DEMO_IDS.companyId,
      in_transit_qty: '1',
      available_qty: '999',
    });
    const detail = await getInternalTradeOrder({
      database: test.database,
      request: makeRequest({ principal: principal(), params: { id: shipped.id } }),
    });
    expect(detail?.status).toBe('在途');
    expect(detail?.inTransitQty).toBe('1');
  });
});
