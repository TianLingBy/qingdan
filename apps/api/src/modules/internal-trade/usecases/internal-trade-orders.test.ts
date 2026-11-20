import {
  AppError,
  type InternalTradeOrder,
  type InternalTradeOrderDetail,
  type ScopeMatrix,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { registerServices } from '../../../platform/services/registry.js';
import { inventoryServices } from '../../inventory/services/ports.js';
import { settlementServices } from '../../settlement/services/drafts.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../testing/pglite.js';
import {
  cancelInternalTradeOrder,
  createInternalTradeOrder,
  dispatchInternalTradeOrder,
  getInternalTradeOrder,
  listInternalTradeOrders,
  receiveInternalTradeOrder,
  revokeDispatchInternalTradeOrder,
  updateInternalTradeOrder,
} from './internal-trade-orders.js';

/** 内部交易单 N 用例 / 数据访问（D15 / D16 / D21 / D22 / D51 / D52 / D68）。 */

const TO_COMPANY_ID = '01900000-0000-7000-8000-000000005101';
const OUTSIDE_COMPANY_ID = '01900000-0000-7000-8000-000000005102';
const PRODUCT_ID = '01900000-0000-7000-8000-000000005111';
const OTHER_PRODUCT_ID = '01900000-0000-7000-8000-000000005112';
const BATCH_A_ID = '01900000-0000-7000-8000-000000005121';
const BATCH_B_ID = '01900000-0000-7000-8000-000000005122';
const OTHER_COMPANY_BATCH_ID = '01900000-0000-7000-8000-000000005123';
const OUTSIDE_BATCH_ID = '01900000-0000-7000-8000-000000005124';
const FLOW_ID = '01900000-0000-7000-8000-000000005131';

const FULL_SCOPE: ScopeMatrix = [
  {
    domain: 'internal_trade',
    actions: ['read', 'create', 'update', 'ship', 'approve', 'delete', 'view_price'],
  },
];
const READ_ONLY_SCOPE: ScopeMatrix = [
  { domain: 'internal_trade', actions: ['read'] },
];
/** 有读权限、无看价权限（D79 脱敏测试用）。 */
const NO_PRICE_SCOPE: ScopeMatrix = [
  { domain: 'internal_trade', actions: ['read', 'create', 'update'] },
];

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_A_ID, BATCH_B_ID],
  qty: '2',
  unitPrice: '15',
  amount: '999',
};

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly auditReason?: string | null;
}

function makeRequest(input: FakeRequestInput): FastifyRequest {
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
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

function aiPrincipal(overrides: Partial<Principal> = {}): Principal {
  return principal({
    actorType: 'ai',
    credentialId: 'token-test',
    ...overrides,
  });
}

async function expectAppError(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const promise = action();
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('internal-trade N 单用例（PGlite + seed 演示租户）', () => {
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

  async function createOne(
    input: Record<string, unknown> = {},
    overrides: Partial<Principal> = {},
  ): Promise<InternalTradeOrder> {
    const { ctx, state } = writeCtx(overrides, {
      body: {
        fromCompanyId: DEMO_IDS.companyId,
        toCompanyId: TO_COMPANY_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        internalPrice: '10.5',
        ...input,
      },
    });
    const created = await createInternalTradeOrder(ctx);
    expect(state.statusCode).toBe(201);
    return created;
  }

  beforeAll(async () => {
    registerServices({
      stockBatchInspection: inventoryServices.stockBatchInspection,
      stockBatchTransfer: inventoryServices.stockBatchTransfer,
      ...settlementServices,
    });
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '内部交易接收公司', '0002', 1, '启用'),
              ($3, $2, '内部交易外部公司', '0003', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [TO_COMPANY_ID, DEMO_IDS.tenantId, OUTSIDE_COMPANY_ID],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '内部交易商品', '{}', '件'),
              ($4, $2, $3, NULL, '内部交易其他商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [
        PRODUCT_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        OTHER_PRODUCT_ID,
      ],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'N-UNIT-A', '10', '1000', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'N-UNIT-B', '20', '1000', '0', '0', '0', $5),
              ($7, $2, $8, $4, 'N-UNIT-TO', '12', '1000', '0', '0', '0', $5),
              ($9, $2, $10, $4, 'N-UNIT-OUT', '12', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
        BATCH_B_ID,
        OTHER_COMPANY_BATCH_ID,
        TO_COMPANY_ID,
        OUTSIDE_BATCH_ID,
        OUTSIDE_COMPANY_ID,
      ],
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('开单：N 单号、SQL 金额 / 在途量聚合、公司回显与审计落库', async () => {
    const created = await createOne();

    expect(created.tenantId).toBe(DEMO_IDS.tenantId);
    expect(created.fromCompanyId).toBe(DEMO_IDS.companyId);
    expect(created.fromCompanyName).toBe('演示公司');
    expect(created.toCompanyId).toBe(TO_COMPANY_ID);
    expect(created.toCompanyName).toBe('内部交易接收公司');
    expect(created.orderNo).toMatch(/^N-0001-\d{8}-\d{4}$/);
    expect(created.status).toBe('进行中');
    expect(created.internalPrice).toBe('10.5');
    // D68：单仍为「进行中」，尚未发货，绝不能虚报在途锁定。
    expect(created.inTransitQty).toBe('0');
    expect(created.version).toBe(1);
    expect(created.lines).toEqual([
      {
        productId: PRODUCT_ID,
        batchIds: [BATCH_A_ID, BATCH_B_ID],
        qty: '2',
        unitPrice: '15',
        amount: '30',
      },
    ]);

    const row = await test.database.query<{
      company_id: string;
      amount: string;
      in_transit_qty: string;
    }>(
      `SELECT o.company_id,
              trim_scale(l.amount) AS amount,
              trim_scale(o.in_transit_qty) AS in_transit_qty
         FROM internal_trade_order o
         JOIN internal_trade_order_line l
           ON l.order_id = o.id
        WHERE o.id = $1`,
      [created.id],
    );
    expect(row.rows[0]).toEqual({
      company_id: DEMO_IDS.companyId,
      amount: '30',
      in_transit_qty: '0',
    });

    const recipientList = await listInternalTradeOrders(
      readCtx(
        { companyIds: [TO_COMPANY_ID] },
        {
          query: {
            toCompanyId: TO_COMPANY_ID,
            status: '进行中',
            keyword: created.orderNo,
          },
        },
      ),
    );
    expect(recipientList.items.map((item) => item.id)).toEqual([created.id]);

    const detail = (await getInternalTradeOrder(
      readCtx(
        { companyIds: [TO_COMPANY_ID] },
        { params: { id: created.id } },
      ),
    )) as InternalTradeOrderDetail;
    expect(detail.cancelable).toEqual({ allowed: true, reason: null });
    expect(detail.lines[0]?.batchIds).toEqual([BATCH_A_ID, BATCH_B_ID]);

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result FROM audit_log WHERE object_id = $1`,
      [created.id],
    );
    expect(audit.rows).toEqual([
      { action: 'internal_trade.order.create', result: 'success' },
    ]);
  });

  it('到货确认：仅在途单可确认，并原子转移关联批次', async () => {
    const created = await createOne();
    await test.database.query(
      `UPDATE internal_trade_order SET status = '在途', in_transit_qty = 4 WHERE id = $1`,
      [created.id],
    );
    await test.database.query(
      `UPDATE inventory_batch
          SET in_transit_qty = 2
        WHERE id IN ($1::uuid, $2::uuid)`,
      [BATCH_A_ID, BATCH_B_ID],
    );

    const { ctx, state } = writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"1"' },
    });
    const received = await receiveInternalTradeOrder(ctx);

    expect(received.status).toBe('已完成');
    expect(received.inTransitQty).toBe('0');
    expect(state.headers.ETag).toBe('"2"');
    const batches = await test.database.query<{ company_id: string; in_transit_qty: string }>(
      `SELECT company_id, trim_scale(in_transit_qty) AS in_transit_qty
         FROM inventory_batch
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id`,
      [BATCH_A_ID, BATCH_B_ID],
    );
    expect(batches.rows).toEqual([
      { company_id: TO_COMPANY_ID, in_transit_qty: '0' },
      { company_id: TO_COMPANY_ID, in_transit_qty: '0' },
    ]);
    const draft = await test.database.query<{ source_doc_type: string; total_sale_amount: string; total_cost_amount: string }>(
      `SELECT source_doc_type, trim_scale(total_sale_amount) AS total_sale_amount,
              trim_scale(total_cost_amount) AS total_cost_amount
         FROM settlement_order WHERE source_doc_id = $1`,
      [created.id],
    );
    expect(draft.rows[0]).toEqual({ source_doc_type: 'N', total_sale_amount: '30', total_cost_amount: '30' });
    await test.database.query(
      `UPDATE inventory_batch SET company_id = $1::uuid WHERE id IN ($2::uuid, $3::uuid)`,
      [DEMO_IDS.companyId, BATCH_A_ID, BATCH_B_ID],
    );
  });

  it('D15 / D22 / D52：跨公司批次、不可见接收公司、同公司、AI 开单均拒绝', async () => {
    await expectAppError(
      () =>
        createInternalTradeOrder(
          writeCtx(
            {},
            {
              body: {
                fromCompanyId: DEMO_IDS.companyId,
                toCompanyId: TO_COMPANY_ID,
                handlerId: DEMO_IDS.ownerEmployeeId,
                lines: [{ ...LINE, batchIds: [OTHER_COMPANY_BATCH_ID] }],
                internalPrice: '10',
              },
            },
          ).ctx,
        ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      () =>
        createInternalTradeOrder(
          writeCtx(
            { companyIds: [DEMO_IDS.companyId] },
            {
              body: {
                fromCompanyId: DEMO_IDS.companyId,
                toCompanyId: TO_COMPANY_ID,
                handlerId: DEMO_IDS.ownerEmployeeId,
                lines: [LINE],
                internalPrice: '10',
              },
            },
          ).ctx,
        ),
      'FORBIDDEN',
    );

    await expectAppError(
      () =>
        createInternalTradeOrder(
          writeCtx(
            {},
            {
              body: {
                fromCompanyId: DEMO_IDS.companyId,
                toCompanyId: DEMO_IDS.companyId,
                handlerId: DEMO_IDS.ownerEmployeeId,
                lines: [LINE],
                internalPrice: '10',
              },
            },
          ).ctx,
        ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      () =>
        createInternalTradeOrder(
          writeCtx(
            {},
            {
              principal: aiPrincipal(),
              auditReason: 'AI 尝试开内部交易单',
              body: {
                fromCompanyId: DEMO_IDS.companyId,
                toCompanyId: TO_COMPANY_ID,
                handlerId: DEMO_IDS.ownerEmployeeId,
                lines: [LINE],
                internalPrice: '10',
              },
            },
          ).ctx,
        ),
      'AI_ACTION_FORBIDDEN',
    );

    await expectAppError(
      () =>
        createInternalTradeOrder(
          writeCtx(
            { scope: READ_ONLY_SCOPE },
            {
              body: {
                fromCompanyId: DEMO_IDS.companyId,
                toCompanyId: TO_COMPANY_ID,
                handlerId: DEMO_IDS.ownerEmployeeId,
                lines: [LINE],
                internalPrice: '10',
              },
            },
          ).ctx,
        ),
      'FORBIDDEN',
    );
  });

  it('修改：If-Match、四态限制、整体替换明细、SQL 重聚合；AI 修改放行', async () => {
    const created = await createOne();

    await expectAppError(
      () =>
        updateInternalTradeOrder(
          writeCtx(
            {},
            {
              params: { id: created.id },
              body: { internalPrice: '20' },
            },
          ).ctx,
        ),
      'PRECONDITION_REQUIRED',
    );
    await expectAppError(
      () =>
        updateInternalTradeOrder(
          writeCtx(
            {},
            {
              params: { id: created.id },
              headers: { 'if-match': '"9"' },
              body: { internalPrice: '20' },
            },
          ).ctx,
        ),
      'VERSION_CONFLICT',
    );

    const { ctx, state } = writeCtx(
      {},
      {
        params: { id: created.id },
        headers: { 'if-match': '"1"' },
        body: {
          lines: [
            {
              productId: PRODUCT_ID,
              batchIds: [BATCH_B_ID],
              qty: '3',
              unitPrice: '20',
              amount: '1',
            },
          ],
          internalPrice: '18.25',
        },
      },
    );
    const updated = await updateInternalTradeOrder(ctx);
    expect(state.headers.ETag).toBe('"2"');
    expect(updated.version).toBe(2);
    expect(updated.internalPrice).toBe('18.25');
    expect(updated.inTransitQty).toBe('0');
    expect(updated.lines).toEqual([
      {
        productId: PRODUCT_ID,
        batchIds: [BATCH_B_ID],
        qty: '3',
        unitPrice: '20',
        amount: '60',
      },
    ]);

    const aiUpdate = writeCtx(
      {},
      {
        principal: aiPrincipal(),
        auditReason: 'AI 修改内部交易单',
        params: { id: created.id },
        headers: { 'if-match': '"2"' },
        body: { handlerId: DEMO_IDS.managerEmployeeId },
      },
    );
    const aiUpdated = await updateInternalTradeOrder(aiUpdate.ctx);
    expect(aiUpdated.version).toBe(3);
    expect(aiUpdated.handlerId).toBe(DEMO_IDS.managerEmployeeId);

    const inTransit = await createOne();
    await test.database.query(
      `UPDATE internal_trade_order SET status = '在途' WHERE id = $1`,
      [inTransit.id],
    );
    await expectAppError(
      () =>
        updateInternalTradeOrder(
          writeCtx(
            {},
            {
              params: { id: inTransit.id },
              headers: { 'if-match': '"1"' },
              body: { internalPrice: '22' },
            },
          ).ctx,
        ),
      'VALIDATION_FAILED',
    );

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'internal_trade.order.update'
          AND object_id = $1
          AND result = 'success'`,
      [created.id],
    );
    expect(audit.rows[0]?.count).toBe('2');
  });

  it('取消：进行中 / 在途可取消，终态与有下游拒绝；AI 禁止并记审计', async () => {
    const created = await createOne();
    const aiTarget = await createOne();
    await expectAppError(
      () =>
        cancelInternalTradeOrder(
          writeCtx(
            {},
            {
              principal: aiPrincipal(),
              auditReason: 'AI 尝试取消内部交易单',
              params: { id: aiTarget.id },
              headers: { 'if-match': '"1"' },
            },
          ).ctx,
        ),
      'AI_ACTION_FORBIDDEN',
    );

    const withDownstream = await createOne();
    await test.database.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id, handled_by)
       VALUES ($1, $2, $3, $4, '-1', 'N', $5, $6)`,
      [
        FLOW_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        BATCH_A_ID,
        withDownstream.id,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
    await expectAppError(
      () =>
        cancelInternalTradeOrder(
          writeCtx(
            {},
            {
              params: { id: withDownstream.id },
              headers: { 'if-match': '"1"' },
            },
          ).ctx,
        ),
      'VERSION_CONFLICT',
    );

    const inTransit = await createOne();
    await test.database.query(
      `UPDATE internal_trade_order SET status = '在途' WHERE id = $1`,
      [inTransit.id],
    );
    const inTransitWrite = writeCtx(
      {},
      {
        params: { id: inTransit.id },
        headers: { 'if-match': '"1"' },
      },
    );
    const cancelledInTransit = await cancelInternalTradeOrder(
      inTransitWrite.ctx,
    );
    expect(inTransitWrite.state.headers.ETag).toBe('"2"');
    expect(cancelledInTransit.status).toBe('已取消');

    const completed = await createOne();
    await test.database.query(
      `UPDATE internal_trade_order SET status = '已完成' WHERE id = $1`,
      [completed.id],
    );
    await expectAppError(
      () =>
        cancelInternalTradeOrder(
          writeCtx(
            {},
            {
              params: { id: completed.id },
              headers: { 'if-match': '"1"' },
            },
          ).ctx,
        ),
      'VALIDATION_FAILED',
    );

    const { ctx, state } = writeCtx(
      {},
      {
        params: { id: created.id },
        headers: { 'if-match': '"1"' },
      },
    );
    const cancelled = await cancelInternalTradeOrder(ctx);
    expect(state.headers.ETag).toBe('"2"');
    expect(cancelled).toMatchObject({ status: '已取消', version: 2 });

    await expectAppError(
      () =>
        cancelInternalTradeOrder(
          writeCtx(
            {},
            {
              params: { id: created.id },
              headers: { 'if-match': '"2"' },
            },
          ).ctx,
        ),
      'VALIDATION_FAILED',
    );

    const detail = (await getInternalTradeOrder(
      readCtx({}, { params: { id: created.id } }),
    )) as InternalTradeOrderDetail;
    expect(detail.cancelable).toEqual({
      allowed: false,
      reason: 'already_cancelled',
    });

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'internal_trade.order.cancel'
          AND object_id = $1
          AND result = 'success'`,
      [created.id],
    );
    expect(audit.rows[0]?.count).toBe('1');
  });

  it('D79：无 internal_trade.view_price → 金额为 null（不 403、不出 0），数量照常可见', async () => {
    const hidden: Partial<Principal> = { scope: NO_PRICE_SCOPE };
    const created = await createOne({ internalPrice: '88.8' }, hidden);

    // 创建响应即脱敏：金额 null、字段仍在，数量不受影响。
    expect(created.internalPrice).toBeNull();
    expect(created.lines[0]).toMatchObject({ qty: '2', unitPrice: null, amount: null });

    const detail = (await getInternalTradeOrder(
      readCtx(hidden, { params: { id: created.id } }),
    )) as InternalTradeOrderDetail;
    expect(detail.internalPrice).toBeNull();
    expect(detail.lines[0]?.unitPrice).toBeNull();
    expect(detail.lines[0]?.amount).toBeNull();
    expect(detail.inTransitQty).toBe('0'); // 数量不是价格，不脱敏

    const page = await listInternalTradeOrders(readCtx(hidden));
    const row = page.items.find((item) => item.id === created.id);
    expect(row?.internalPrice).toBeNull();
    expect(row?.lines[0]?.unitPrice).toBeNull();

    // 同一张单，老板（含 view_price）仍能看到真实金额。
    const ownerDetail = (await getInternalTradeOrder(
      readCtx({}, { params: { id: created.id } }),
    )) as InternalTradeOrderDetail;
    expect(ownerDetail.internalPrice).toBe('88.8');
    expect(ownerDetail.lines[0]?.unitPrice).toBe('15');
  });

  it('D79：有 update 但无 view_price → 修改响应同样脱敏', async () => {
    const hidden: Partial<Principal> = { scope: NO_PRICE_SCOPE };
    const created = await createOne({}, hidden);
    const { ctx, state } = writeCtx(hidden, {
      params: { id: created.id },
      headers: { 'if-match': `"${created.version}"` },
      body: { internalPrice: '99.9' },
    });
    const updated = await updateInternalTradeOrder(ctx);
    expect(state.statusCode).toBe(200);
    expect(updated.internalPrice).toBeNull();
    expect(updated.version).toBe(created.version + 1);
  });

  it('发货：进行中 → 在途，锁定批次在途量并记审计', async () => {
    const created = await createOne();
    const { ctx, state } = writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"1"' },
    });
    const dispatched = await dispatchInternalTradeOrder(ctx);

    expect(dispatched.status).toBe('在途');
    expect(dispatched.inTransitQty).toBe('2');
    expect(dispatched.version).toBe(2);
    expect(state.headers.ETag).toBe('"2"');

    const batches = await test.database.query<{ in_transit_qty: string }>(
      `SELECT trim_scale(in_transit_qty) AS in_transit_qty
         FROM inventory_batch
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id`,
      [BATCH_A_ID, BATCH_B_ID],
    );
    expect(batches.rows).toEqual([{ in_transit_qty: '1' }, { in_transit_qty: '1' }]);

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result
         FROM audit_log
        WHERE object_id = $1
          AND action = 'internal_trade.order.dispatch'`,
      [created.id],
    );
    expect(audit.rows).toEqual([{ action: 'internal_trade.order.dispatch', result: 'success' }]);

    await test.database.query(
      `UPDATE inventory_batch SET in_transit_qty = 0 WHERE id IN ($1::uuid, $2::uuid)`,
      [BATCH_A_ID, BATCH_B_ID],
    );
  });

  it('发货：在途 / 已完成 / 已取消 → VALIDATION_FAILED', async () => {
    for (const status of ['在途', '已完成', '已取消'] as const) {
      const created = await createOne();
      await test.database.query(
        `UPDATE internal_trade_order SET status = $1 WHERE id = $2`,
        [status, created.id],
      );
      await expectAppError(
        () =>
          dispatchInternalTradeOrder(
            writeCtx({}, {
              params: { id: created.id },
              body: { confirm: true },
              headers: { 'if-match': '"1"' },
            }).ctx,
          ),
        'VALIDATION_FAILED',
      );
    }
  });

  it('发货：批次可用量不足 → VERSION_CONFLICT', async () => {
    const created = await createOne();
    await test.database.query(
      `UPDATE inventory_batch SET inbound_qty = 0 WHERE id = $1::uuid`,
      [BATCH_A_ID],
    );
    const failure = await dispatchInternalTradeOrder(
      writeCtx({}, {
        params: { id: created.id },
        body: { confirm: true },
        headers: { 'if-match': '"1"' },
      }).ctx,
    ).catch((error: unknown) => error);
    await test.database.query(
      `UPDATE inventory_batch SET inbound_qty = 1000 WHERE id = $1::uuid`,
      [BATCH_A_ID],
    );

    // #269：N 单发货必须说「内部交易发货」，并带批次标识。
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { batchId: BATCH_A_ID, batchNo: 'N-UNIT-A' },
    });
    const failureMessage = (failure as AppError).message;
    expect(failureMessage).toContain('内部交易发货');
    expect(failureMessage).toContain('N-UNIT-A');
    expect(failureMessage).not.toContain('盘亏');
  });

  it('发货：调用者不属发出公司 → FORBIDDEN', async () => {
    const created = await createOne();
    await expectAppError(
      () =>
        dispatchInternalTradeOrder(
          writeCtx(
            { companyIds: [TO_COMPANY_ID] },
            {
              params: { id: created.id },
              body: { confirm: true },
              headers: { 'if-match': '"1"' },
            },
          ).ctx,
        ),
      'FORBIDDEN',
    );
  });

  it('连通：发货后到货确认成功，批次转司、在途量归零、单据已完成', async () => {
    const created = await createOne();
    const { ctx, state } = writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"1"' },
    });
    const dispatched = await dispatchInternalTradeOrder(ctx);
    expect(dispatched.status).toBe('在途');
    expect(state.headers.ETag).toBe('"2"');

    const { ctx: receiveCtx, state: receiveState } = writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"2"' },
    });
    const received = await receiveInternalTradeOrder(receiveCtx);
    expect(received.status).toBe('已完成');
    expect(received.inTransitQty).toBe('0');
    expect(receiveState.headers.ETag).toBe('"3"');

    const batches = await test.database.query<{ company_id: string; in_transit_qty: string }>(
      `SELECT company_id, trim_scale(in_transit_qty) AS in_transit_qty
         FROM inventory_batch
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id`,
      [BATCH_A_ID, BATCH_B_ID],
    );
    expect(batches.rows).toEqual([
      { company_id: TO_COMPANY_ID, in_transit_qty: '0' },
      { company_id: TO_COMPANY_ID, in_transit_qty: '0' },
    ]);

    await test.database.query(
      `UPDATE inventory_batch SET company_id = $1::uuid WHERE id IN ($2::uuid, $3::uuid)`,
      [DEMO_IDS.companyId, BATCH_A_ID, BATCH_B_ID],
    );
  });

  it('撤销发货：dispatch → revoke 成功，回进行中、在途量归零、available_qty 回升、审计 reason 落库', async () => {
    const created = await createOne();
    await dispatchInternalTradeOrder(writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"1"' },
    }).ctx);

    const afterDispatch = await test.database.query<{ in_transit_qty: string; available_qty: string }>(
      `SELECT trim_scale(in_transit_qty) AS in_transit_qty, trim_scale(available_qty) AS available_qty
         FROM inventory_batch
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id`,
      [BATCH_A_ID, BATCH_B_ID],
    );
    expect(afterDispatch.rows).toEqual([
      { in_transit_qty: '1', available_qty: '999' },
      { in_transit_qty: '1', available_qty: '999' },
    ]);

    const { ctx, state } = writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true, reason: '司机临时取消' },
      headers: { 'if-match': '"2"' },
    });
    const revoked = await revokeDispatchInternalTradeOrder(ctx);
    expect(revoked.status).toBe('进行中');
    expect(revoked.inTransitQty).toBe('0');
    expect(revoked.version).toBe(3);
    expect(state.headers.ETag).toBe('"3"');

    const afterRevoke = await test.database.query<{ in_transit_qty: string; available_qty: string }>(
      `SELECT trim_scale(in_transit_qty) AS in_transit_qty, trim_scale(available_qty) AS available_qty
         FROM inventory_batch
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id`,
      [BATCH_A_ID, BATCH_B_ID],
    );
    expect(afterRevoke.rows).toEqual([
      { in_transit_qty: '0', available_qty: '1000' },
      { in_transit_qty: '0', available_qty: '1000' },
    ]);

    const audit = await test.database.query<{ action: string; changes: Record<string, unknown> }>(
      `SELECT action, changes
         FROM audit_log
        WHERE object_id = $1
          AND action = 'internal_trade.order.dispatch_revoke'`,
      [created.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: 'internal_trade.order.dispatch_revoke' });
    expect(audit.rows[0]?.changes).toMatchObject({
      beforeStatus: '在途',
      afterStatus: '进行中',
      releasedBatchCount: 2,
      reason: '司机临时取消',
    });
  });

  it('撤销发货：撤销后能再次 dispatch（状态机闭环）', async () => {
    const created = await createOne();
    await dispatchInternalTradeOrder(writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"1"' },
    }).ctx);

    const revoked = await revokeDispatchInternalTradeOrder(writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true, reason: '点错了' },
      headers: { 'if-match': '"2"' },
    }).ctx);
    expect(revoked).toMatchObject({ status: '进行中', version: 3, inTransitQty: '0' });

    const { ctx: reCtx, state } = writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"3"' },
    });
    const redispatched = await dispatchInternalTradeOrder(reCtx);
    expect(redispatched).toMatchObject({ status: '在途', version: 4, inTransitQty: '2' });
    expect(state.headers.ETag).toBe('"4"');

    await test.database.query(
      `UPDATE inventory_batch SET in_transit_qty = 0 WHERE id IN ($1::uuid, $2::uuid)`,
      [BATCH_A_ID, BATCH_B_ID],
    );
  });

  it('撤销发货：进行中 / 已完成 / 已取消 → VALIDATION_FAILED', async () => {
    for (const status of ['进行中', '已完成', '已取消'] as const) {
      const created = await createOne();
      await test.database.query(
        `UPDATE internal_trade_order SET status = $1 WHERE id = $2`,
        [status, created.id],
      );
      await expectAppError(
        () =>
          revokeDispatchInternalTradeOrder(
            writeCtx({}, {
              params: { id: created.id },
              body: { confirm: true, reason: '不该能撤' },
              headers: { 'if-match': '"1"' },
            }).ctx,
          ),
        'VALIDATION_FAILED',
      );
    }
  });

  it('撤销发货：reason 缺失或空串 → VALIDATION_FAILED', async () => {
    const created = await createOne();
    await dispatchInternalTradeOrder(writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"1"' },
    }).ctx);

    await expectAppError(
      () =>
        revokeDispatchInternalTradeOrder(
          writeCtx({}, {
            params: { id: created.id },
            body: { confirm: true },
            headers: { 'if-match': '"2"' },
          }).ctx,
        ),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      () =>
        revokeDispatchInternalTradeOrder(
          writeCtx({}, {
            params: { id: created.id },
            body: { confirm: true, reason: '   ' },
            headers: { 'if-match': '"2"' },
          }).ctx,
        ),
      'VALIDATION_FAILED',
    );

    await test.database.query(
      `UPDATE inventory_batch SET in_transit_qty = 0 WHERE id IN ($1::uuid, $2::uuid)`,
      [BATCH_A_ID, BATCH_B_ID],
    );
  });

  it('撤销发货：批次在途量被外部改小 → VERSION_CONFLICT，且不减成负数', async () => {
    const created = await createOne();
    await dispatchInternalTradeOrder(writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"1"' },
    }).ctx);
    // 外部把 BATCH_A 的在途量改小，模拟数据被别处动过。
    await test.database.query(
      `UPDATE inventory_batch SET in_transit_qty = 0 WHERE id = $1::uuid`,
      [BATCH_A_ID],
    );

    await expectAppError(
      () =>
        revokeDispatchInternalTradeOrder(
          writeCtx({}, {
            params: { id: created.id },
            body: { confirm: true, reason: '在途量被改小' },
            headers: { 'if-match': '"2"' },
          }).ctx,
        ),
      'VERSION_CONFLICT',
    );

    const batches = await test.database.query<{ in_transit_qty: string }>(
      `SELECT trim_scale(in_transit_qty) AS in_transit_qty
         FROM inventory_batch
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id`,
      [BATCH_A_ID, BATCH_B_ID],
    );
    // BATCH_A 停在 0（没有减成负数），BATCH_B 因事务回滚仍保持 1。
    expect(batches.rows).toEqual([{ in_transit_qty: '0' }, { in_transit_qty: '1' }]);

    await test.database.query(
      `UPDATE inventory_batch SET in_transit_qty = 0 WHERE id IN ($1::uuid, $2::uuid)`,
      [BATCH_A_ID, BATCH_B_ID],
    );
  });

  it('撤销发货：调用者不属发出公司 → FORBIDDEN', async () => {
    const created = await createOne();
    await dispatchInternalTradeOrder(writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"1"' },
    }).ctx);

    await expectAppError(
      () =>
        revokeDispatchInternalTradeOrder(
          writeCtx(
            { companyIds: [TO_COMPANY_ID] },
            {
              params: { id: created.id },
              body: { confirm: true, reason: '接收方想撤' },
              headers: { 'if-match': '"2"' },
            },
          ).ctx,
        ),
      'FORBIDDEN',
    );

    await test.database.query(
      `UPDATE inventory_batch SET in_transit_qty = 0 WHERE id IN ($1::uuid, $2::uuid)`,
      [BATCH_A_ID, BATCH_B_ID],
    );
  });

  it('撤销发货：只有 ship 能撤，仅 update / delete 无 ship → FORBIDDEN', async () => {
    const created = await createOne();
    await dispatchInternalTradeOrder(writeCtx({}, {
      params: { id: created.id },
      body: { confirm: true },
      headers: { 'if-match': '"1"' },
    }).ctx);

    await expectAppError(
      () =>
        revokeDispatchInternalTradeOrder(
          writeCtx(
            {
              // D106：经手人自己的单可以撤，所以「没有 ship」的拒绝要换一个不是经手人的身份。
              scope: [{ domain: 'internal_trade', actions: ['update', 'delete'] }],
              actorId: DEMO_IDS.managerEmployeeId,
              employeeId: DEMO_IDS.managerEmployeeId,
            },
            {
              params: { id: created.id },
              body: { confirm: true, reason: '没有出权限还想撤' },
              headers: { 'if-match': '"2"' },
            },
          ).ctx,
        ),
      'FORBIDDEN',
    );

    const { ctx, state } = writeCtx(
      { scope: [{ domain: 'internal_trade', actions: ['ship'] }] },
      {
        params: { id: created.id },
        body: { confirm: true, reason: '有出权限就能撤' },
        headers: { 'if-match': '"2"' },
      },
    );
    const revoked = await revokeDispatchInternalTradeOrder(ctx);
    expect(revoked).toMatchObject({ status: '进行中', version: 3, inTransitQty: '0' });
    expect(state.headers.ETag).toBe('"3"');
  });

  it('D106 经手人自带豁免：一个权限点都没有，自己开的单也能发货 / 到货', async () => {
    // 一个权限点都不给：能通过只可能来自「本单经手人」这一半。
    const handlerOnly = { scope: [] as ScopeMatrix };

    const created = await createOne();
    await dispatchInternalTradeOrder(
      writeCtx(handlerOnly, {
        params: { id: created.id },
        body: { confirm: true },
        headers: { 'if-match': '"1"' },
      }).ctx,
    );
    await expect(
      receiveInternalTradeOrder(
        writeCtx(handlerOnly, {
          params: { id: created.id },
          body: { confirm: true },
          headers: { 'if-match': '"2"' },
        }).ctx,
      ),
    ).resolves.toMatchObject({ status: '已完成' });
  });
});
