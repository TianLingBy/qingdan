import { registerServices, resetServices } from '../../../platform/services/registry.js';
import { inventoryServices } from '../../inventory/services/ports.js';
import {
  AppError,
  type ScopeMatrix,
  type SupplierReturn,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import {
  cancelSupplierReturn,
  completeSupplierReturn,
  createSupplierReturn,
  getSupplierReturn,
  listSupplierReturns,
} from './supplier-returns.js';

/**
 * S 供应商退货用例（F4c / D15 / D16 / D21 / D47 / D51 / D52 / D54）。
 *
 * 覆盖：
 *   - create → 201、S 单号、SQL 计算明细金额并由 SQL 聚合 refundAmount；
 *   - 权限不足 / 跨公司 / AI 危险动作拒绝；
 *   - 成功审计落 audit_log；普通读不记；
 *   - list / detail 按原 A 单、状态、单号过滤，跨公司不可见。
 */

const SUPPLIER_ID = '01900000-0000-7000-8000-000000000501';
const SECOND_SUPPLIER_ID = '01900000-0000-7000-8000-000000000502';
const PRODUCT_ID = '01900000-0000-7000-8000-000000000511';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000000512';
const BATCH_ID = '01900000-0000-7000-8000-000000000521';
const BATCH_2_ID = '01900000-0000-7000-8000-000000000522';
/** 与 BATCH_ID 同商品、锁价不同：用来验证「一行跨多批次按各自锁价分别算」。 */
const BATCH_3_ID = '01900000-0000-7000-8000-000000000523';
const BATCH_4_ID = '01900000-0000-7000-8000-000000000524';
const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000503';
const PURCHASE_ORDER_ID = '01900000-0000-7000-8000-000000000531';
const SECOND_PURCHASE_ORDER_ID = '01900000-0000-7000-8000-000000000532';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'supplier_return', actions: ['read', 'create', 'approve', 'delete'] },
];
const READ_ONLY_SCOPE: ScopeMatrix = [
  { domain: 'supplier_return', actions: ['read'] },
];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly auditReason?: string | null;
}

let requestSequence = 0;

function makeRequest(input: FakeRequestInput): FastifyRequest {
  requestSequence += 1;
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
    headers: {
      'x-request-id': `req-supplier-return-${requestSequence}`,
    },
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
    credentialId: 'session-supplier-return-test',
    companyIds: [DEMO_IDS.companyId],
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
    credentialId: 'ai-token-supplier-return-test',
    credentialType: 'api_token',
    ...overrides,
  });
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

const CREATE_BODY = {
  companyId: DEMO_IDS.companyId,
  originalPurchaseOrderId: PURCHASE_ORDER_ID,
  lines: [
    {
      productId: PRODUCT_ID,
      batchIds: [BATCH_ID],
      qty: '2',
      // 前端故意写 1 元：退款单价必须取批次锁价 11（D105），客户端价只作预估。
      unitPrice: '1',
      amount: '999',
    },
    {
      productId: PRODUCT_2_ID,
      batchIds: [BATCH_2_ID],
      qty: '3',
      // 前端与服务端锁价一致：金额不应因此变化。
      unitPrice: '22',
      amount: '0',
    },
  ],
  // 客户端应退金额同样故意错误：必须由服务端按批次锁价覆盖为 2×11 + 3×22 = 88。
  refundAmount: '999',
};

describe('purchase S 供应商退货用例（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;

  function readCtx(overrides: Partial<Principal> = {}, parts: Partial<FakeRequestInput> = {}) {
    return {
      database: test.database,
      request: makeRequest({ principal: principal(overrides), ...parts }),
    };
  }

  function writeCtx(overrides: Partial<Principal> = {}, parts: Partial<FakeRequestInput> = {}) {
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

  async function createOne(input: Record<string, unknown> = {}): Promise<SupplierReturn> {
    const { ctx, state } = writeCtx({}, {
      body: {
        ...CREATE_BODY,
        ...input,
      },
    });
    const created = await createSupplierReturn(ctx);
    expect(state.statusCode).toBe(201);
    return created;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    registerServices(inventoryServices);

    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [SECOND_COMPANY_ID, DEMO_IDS.tenantId],
    );
    for (const [id, companyId, name] of [
      [SUPPLIER_ID, DEMO_IDS.companyId, '供应商退货供应商'],
      [SECOND_SUPPLIER_ID, SECOND_COMPANY_ID, '二司供应商'],
    ] as const) {
      await test.database.query(
        `INSERT INTO supplier
           (id, tenant_id, company_id, supplier_no, name, supplied_materials)
         VALUES ($1, $2, $3, NULL, $4, '{}')
         ON CONFLICT (id) DO NOTHING`,
        [id, DEMO_IDS.tenantId, companyId, name],
      );
    }
    for (const [id, name] of [
      [PRODUCT_ID, '供应商退货商品'],
      [PRODUCT_2_ID, '供应商退货商品二'],
    ] as const) {
      await test.database.query(
        `INSERT INTO product
           (id, tenant_id, company_id, product_no, name, aliases, unit)
         VALUES ($1, $2, $3, NULL, $4, '{}', '件')
         ON CONFLICT (id) DO NOTHING`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, name],
      );
    }

    for (const [id, companyId, supplierId, orderNo] of [
      [PURCHASE_ORDER_ID, DEMO_IDS.companyId, SUPPLIER_ID, 'A-TEST-SR-0001'],
      [SECOND_PURCHASE_ORDER_ID, SECOND_COMPANY_ID, SECOND_SUPPLIER_ID, 'A-TEST-SR-0002'],
    ] as const) {
      await test.database.query(
        `INSERT INTO purchase_order
           (id, tenant_id, company_id, order_no, supplier_id, handler_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, '进行中')`,
        [id, DEMO_IDS.tenantId, companyId, orderNo, supplierId, DEMO_IDS.ownerEmployeeId],
      );
    }
    await test.database.query(
      `INSERT INTO purchase_order_line
         (id, tenant_id, company_id, order_id, line_no, product_id, qty, unit_price, amount)
       VALUES ($1, $2, $3, $4, 1, $5, '2', '12.5', '25')`,
      [
        '01900000-0000-7000-8000-000000000541',
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PURCHASE_ORDER_ID,
        PRODUCT_ID,
      ],
    );

    for (const [id, productId, batchNo, lockedUnitCost] of [
      [BATCH_ID, PRODUCT_ID, 'SR-BATCH-0001', '11'],
      [BATCH_2_ID, PRODUCT_2_ID, 'SR-BATCH-0002', '22'],
      [BATCH_3_ID, PRODUCT_ID, 'SR-BATCH-0003', '22'],
      [BATCH_4_ID, PRODUCT_ID, 'SR-BATCH-0004', '22'],
    ] as const) {
      await test.database.query(
        `INSERT INTO inventory_batch
           (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
            inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
         VALUES ($1, $2, $3, $4, $5, $6::amount, '10000', '0', '0', '0', $7)`,
        [
          id,
          DEMO_IDS.tenantId,
          DEMO_IDS.companyId,
          productId,
          batchNo,
          lockedUnitCost,
          DEMO_IDS.ownerEmployeeId,
        ],
      );
    }
  });

  afterAll(async () => {
    resetServices();
    await test.database.close();
  });

  beforeEach(async () => {
    await test.database.query(
      `UPDATE inventory_batch
          SET inbound_qty = 10000,
              pending_execution_qty = 0,
              referenced_qty = 0,
              in_transit_qty = 0,
              locked_unit_cost = (CASE id
                WHEN $1::uuid THEN '11'
                ELSE '22'
              END)::amount`,
      [BATCH_ID],
    );
  });

  it('登记退货：201、S 单号、金额按批次锁价由服务端算、审计落库', async () => {
    const created = await createOne();

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.tenantId).toBe(DEMO_IDS.tenantId);
    expect(created.companyId).toBe(DEMO_IDS.companyId);
    expect(created.returnNo).toMatch(/^S-0001-\d{8}-\d{4}$/);
    expect(created.originalPurchaseOrderId).toBe(PURCHASE_ORDER_ID);
    expect(created.status).toBe('进行中');
    expect(created.version).toBe(1);
    expect(created.remark).toBeNull();
    // 2 × 锁价 11 + 3 × 锁价 22；客户端传的 1 元与 999 都不参与。
    expect(created.refundAmount).toBe('88');
    expect(created.lines).toHaveLength(2);
    expect(created.lines[0]).toMatchObject({
      productId: PRODUCT_ID,
      batchIds: [BATCH_ID],
      qty: '2',
      unitPrice: '11',
      amount: '22',
    });
    expect(created.lines[1]).toMatchObject({
      productId: PRODUCT_2_ID,
      batchIds: [BATCH_2_ID],
      qty: '3',
      unitPrice: '22',
      amount: '66',
    });

    const audit = await test.database.query<{
      action: string;
      object_type: string;
      result: string;
      changes: { refundAmount?: string; pendingReservations?: unknown };
    }>(
      `SELECT action, object_type, result, changes
         FROM audit_log
        WHERE object_id = $1`,
      [created.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'supplier_return.create',
      object_type: 'supplier_return',
      result: 'success',
    });
    expect(audit.rows[0]?.changes.refundAmount).toBe('88');
    expect(audit.rows[0]?.changes.pendingReservations).toEqual([
      { batchId: BATCH_ID, qty: '2', pendingAfter: '2', availableAfter: '9998' },
      { batchId: BATCH_2_ID, qty: '3', pendingAfter: '3', availableAfter: '9997' },
    ]);
  });

  it('列表 / 详情：按原 A 单、状态、单号过滤；跨公司不可见；普通读不记审计', async () => {
    const created = await createOne();

    const detail = await getSupplierReturn(
      readCtx({}, { params: { id: created.id } }),
    );
    expect(detail.id).toBe(created.id);
    expect(detail.lines).toHaveLength(2);

    const list = await listSupplierReturns(
      readCtx({}, {
        query: {
          originalPurchaseOrderId: PURCHASE_ORDER_ID,
          status: '进行中',
          keyword: created.returnNo,
        },
      }),
    );
    expect(list.items.map((item) => item.id)).toContain(created.id);
    expect(list.items.find((item) => item.id === created.id)?.lines).toHaveLength(2);

    const outside = principal({ companyIds: [SECOND_COMPANY_ID] });
    await expectAppError(
      getSupplierReturn(readCtx(outside, { params: { id: created.id } })),
      'NOT_FOUND',
    );
    const outsideList = await listSupplierReturns(
      readCtx(outside, { query: { keyword: created.returnNo } }),
    );
    expect(outsideList.items).toHaveLength(0);

    const reads = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action IN ('supplier_return.list.read', 'supplier_return.detail.read')`,
    );
    expect(reads.rows[0]?.count).toBe('0');
  });

  it('权限拒绝、跨公司原 A 单、批次商品不一致、AI 无原因 / 有原因均拒绝', async () => {
    const before = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action = 'supplier_return.create'`,
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({ scope: READ_ONLY_SCOPE }, { body: CREATE_BODY }).ctx,
      ),
      'FORBIDDEN',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({ companyIds: [SECOND_COMPANY_ID] }, { body: CREATE_BODY }).ctx,
      ),
      'FORBIDDEN',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({}, {
          body: {
            ...CREATE_BODY,
            originalPurchaseOrderId: SECOND_PURCHASE_ORDER_ID,
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({}, {
          body: {
            ...CREATE_BODY,
            lines: [
              {
                ...CREATE_BODY.lines[0],
                batchIds: [BATCH_2_ID],
              },
            ],
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({}, {
          principal: aiPrincipal(),
          body: CREATE_BODY,
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({}, {
          principal: aiPrincipal(),
          auditReason: 'AI 尝试登记供应商退货',
          body: CREATE_BODY,
        }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    const after = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action = 'supplier_return.create'`,
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
  async function finish(id: string, version = 1) {
    const request = makeRequest({ principal: principal(), params: { id } });
    request.headers['if-match'] = `"${version}"`;
    return completeSupplierReturn({
      database: test.database, request,
      reply: { header() { return this; } } as unknown as FastifyReply,
    });
  }

  async function cancel(id: string, version = 1) {
    const request = makeRequest({ principal: principal(), params: { id } });
    request.headers['if-match'] = `"${version}"`;
    return cancelSupplierReturn({
      database: test.database,
      request,
      reply: { header() { return this; } } as unknown as FastifyReply,
    });
  }

  async function stock() {
    return (await test.database.query(
      `SELECT id, inbound_qty::text, locked_unit_cost::text FROM inventory_batch ORDER BY id`,
    )).rows;
  }

  it('完成：库存与流水同事务、成本不变、完成审计、拒绝重复完成', async () => {
    const order = await createOne();
    const before = await stock();
    const completed = await finish(order.id);
    expect(completed).toMatchObject({ status: '已完成', version: 2 });
    const after = await stock();
    const oldBatch = before.find(row => row.id === BATCH_ID)!;
    const newBatch = after.find(row => row.id === BATCH_ID)!;
    expect(Number(newBatch.inbound_qty) - Number(oldBatch.inbound_qty)).toBe(-2);
    expect(newBatch.locked_unit_cost).toBe(oldBatch.locked_unit_cost);
    const flows = await test.database.query(
      `SELECT delta::text, source_doc_type FROM inventory_flow WHERE source_doc_id = $1`, [order.id],
    );
    expect(flows.rows).toHaveLength(2);
    expect(flows.rows.map(row => Number(row.delta))).toContain(-2);
    expect(flows.rows.every(row => row.source_doc_type === 'S')).toBe(true);
    await expectAppError(finish(order.id), 'VERSION_CONFLICT');
    await expectAppError(finish(order.id, 2), 'VALIDATION_FAILED');
    expect(await stock()).toEqual(after);
    const audit = await test.database.query<{ action: string; changes: Record<string, unknown> }>(
      `SELECT action, changes FROM audit_log WHERE object_id = $1 AND action = 'supplier_return.complete'`, [order.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.changes).toMatchObject({
      pendingReleases: [
        { batchId: BATCH_ID, qty: '2', pendingAfter: '0' },
        { batchId: BATCH_2_ID, qty: '3', pendingAfter: '0' },
      ],
    });
    const finishedBatches = await test.database.query<{
      id: string;
      pending_execution_qty: string;
      available_qty: string;
    }>(
      `SELECT id::text AS id,
              trim_scale(pending_execution_qty) AS pending_execution_qty,
              trim_scale(available_qty) AS available_qty
         FROM inventory_batch
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[BATCH_ID, BATCH_2_ID]],
    );
    expect(finishedBatches.rows).toEqual([
      { id: BATCH_ID, pending_execution_qty: '0', available_qty: '9998' },
      { id: BATCH_2_ID, pending_execution_qty: '0', available_qty: '9997' },
    ]);
  });

  it('建单即占待执行量，取消释放且只写一条取消审计', async () => {
    const order = await createOne();
    const pending = await test.database.query<{
      batch_id: string;
      pending_execution_qty: string;
      available_qty: string;
    }>(
      `SELECT id AS batch_id,
              trim_scale(pending_execution_qty) AS pending_execution_qty,
              trim_scale(available_qty) AS available_qty
         FROM inventory_batch
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[BATCH_ID, BATCH_2_ID]],
    );
    expect(pending.rows).toEqual([
      { batch_id: BATCH_ID, pending_execution_qty: '2', available_qty: '9998' },
      { batch_id: BATCH_2_ID, pending_execution_qty: '3', available_qty: '9997' },
    ]);

    const cancelled = await cancel(order.id);
    expect(cancelled).toMatchObject({ status: '已取消', version: 2 });
    const released = await test.database.query<{ pending_execution_qty: string }>(
      `SELECT trim_scale(pending_execution_qty) AS pending_execution_qty
         FROM inventory_batch
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[BATCH_ID, BATCH_2_ID]],
    );
    expect(released.rows.map((row) => row.pending_execution_qty)).toEqual(['0', '0']);
    const audit = await test.database.query<{ action: string; changes: Record<string, unknown> }>(
      `SELECT action, changes
         FROM audit_log
        WHERE object_id = $1 AND action = 'supplier_return.cancel'`,
      [order.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.changes).toMatchObject({
      pendingReleases: [
        { batchId: BATCH_ID, qty: '2', pendingAfter: '0' },
        { batchId: BATCH_2_ID, qty: '3', pendingAfter: '0' },
      ],
    });
  });

  it('第二行待执行占用不足：第一行释放、流水及单据状态全部回滚', async () => {
    const order = await createOne({ lines: [CREATE_BODY.lines[0], { ...CREATE_BODY.lines[1], qty: '9999' }] });
    const before = await stock();
    const pendingBefore = await test.database.query<{
      id: string;
      pending_execution_qty: string;
    }>(
      `SELECT id::text AS id,
              trim_scale(pending_execution_qty) AS pending_execution_qty
         FROM inventory_batch
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[BATCH_ID, BATCH_2_ID]],
    );
    expect(pendingBefore.rows.map((row) => row.pending_execution_qty)).toEqual(['2', '9999']);

    // 第二行占用记录被人为压少 1；第一行已释放后第二行失败，必须整单回滚。
    await test.database.query(
      `UPDATE inventory_batch SET pending_execution_qty = 9998 WHERE id = $1::uuid`,
      [BATCH_2_ID],
    );
    await expectAppError(finish(order.id), 'VERSION_CONFLICT');
    expect(await stock()).toEqual(before);
    const pendingAfter = await test.database.query<{
      id: string;
      pending_execution_qty: string;
    }>(
      `SELECT id::text AS id,
              trim_scale(pending_execution_qty) AS pending_execution_qty
         FROM inventory_batch
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[BATCH_ID, BATCH_2_ID]],
    );
    expect(pendingAfter.rows).toEqual([
      { id: BATCH_ID, pending_execution_qty: '2' },
      { id: BATCH_2_ID, pending_execution_qty: '9998' },
    ]);
    expect(await getSupplierReturn(readCtx({}, { params: { id: order.id } }))).toMatchObject({ status: '进行中', version: 1 });
    expect((await test.database.query(`SELECT id FROM inventory_flow WHERE source_doc_id = $1`, [order.id])).rows).toEqual([]);
  });

  it('前端单价不参与计算：传 1 元仍按批次锁价 11 元算，响应与落库都回显 11', async () => {
    const created = await createOne({
      lines: [
        { productId: PRODUCT_ID, batchIds: [BATCH_ID], qty: '2', unitPrice: '1', amount: '2' },
      ],
      refundAmount: '2',
    });

    expect(created.refundAmount).toBe('22');
    expect(created.lines[0]).toMatchObject({ unitPrice: '11', amount: '22' });
    // 不能只在响应层改：明细行落库的单价/金额必须是服务端值。
    const stored = await test.database.query<{ unit_price: string; amount: string }>(
      `SELECT trim_scale(unit_price) AS unit_price, trim_scale(amount) AS amount
         FROM supplier_return_line
        WHERE return_id = $1::uuid`,
      [created.id],
    );
    expect(stored.rows[0]).toEqual({ unit_price: '11', amount: '22' });
  });

  it('前端单价与服务端一致：金额不变（3 × 锁价 22 = 66）', async () => {
    const created = await createOne({
      lines: [
        { productId: PRODUCT_2_ID, batchIds: [BATCH_2_ID], qty: '3', unitPrice: '22', amount: '66' },
      ],
      refundAmount: '66',
    });

    expect(created.refundAmount).toBe('66');
    expect(created.lines[0]).toMatchObject({ unitPrice: '22', amount: '66' });
  });

  it('一行跨多批（锁价 11 / 22）：按各批分摊数量 × 该批锁价分别算再求和', async () => {
    // 两批、数量 2 → 1 × 11 + 1 × 22 = 33；回显单价只是「金额 ÷ 数量」的展示值 16.5。
    const halves = await createOne({
      lines: [
        {
          productId: PRODUCT_ID,
          batchIds: [BATCH_ID, BATCH_3_ID],
          qty: '2',
          unitPrice: '16.5',
          amount: '33',
        },
      ],
      refundAmount: '33',
    });
    expect(halves.refundAmount).toBe('33');
    expect(halves.lines[0]).toMatchObject({ amount: '33', unitPrice: '16.5' });

    // 三批、数量 1：均分到 6 位后余量末批承接 → 0.333333 × 11 + 0.333333 × 22 + 0.333334 × 22
    // = 18.333337。**平均锁价口径**会得 18.333333（(11+22+22)/3 × 1），两位小数之后的差异正是
    // 「哪一批吃掉余量」的分叉，所以这里断言到第 6 位，而不是只看个位。
    const thirds = await createOne({
      lines: [
        {
          productId: PRODUCT_ID,
          batchIds: [BATCH_ID, BATCH_3_ID, BATCH_4_ID],
          qty: '1',
          unitPrice: '18.333333',
          amount: '18.333333',
        },
      ],
      refundAmount: '18.333333',
    });
    expect(thirds.refundAmount).toBe('18.333337');
    expect(thirds.lines[0]).toMatchObject({ amount: '18.333337', unitPrice: '18.333337' });
  });

  it('批次锁价为空：422 指到行，不兜底成 0 或客户端价', async () => {
    // 现行库结构 locked_unit_cost 是 NOT NULL（0009），这里临时放开以验证「锁价缺失必须报错」
    // 的防线：将来约束若是放宽，这条路径也不会静默写出错账。
    await test.database.query(
      `ALTER TABLE inventory_batch ALTER COLUMN locked_unit_cost DROP NOT NULL`,
    );
    const before = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM supplier_return`,
    );
    try {
      await test.database.query(
        `UPDATE inventory_batch SET locked_unit_cost = NULL WHERE id = $1::uuid`,
        [BATCH_2_ID],
      );
      const { ctx } = writeCtx({}, {
        body: {
          ...CREATE_BODY,
          lines: [CREATE_BODY.lines[0], CREATE_BODY.lines[1]],
        },
      });
      await expect(createSupplierReturn(ctx)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { field: 'lines.1.batchIds', lineNo: 2 },
      });
      const after = await test.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM supplier_return`,
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    } finally {
      await test.database.query(
        `UPDATE inventory_batch SET locked_unit_cost = '22'::amount WHERE id = $1::uuid`,
        [BATCH_2_ID],
      );
      await test.database.query(
        `ALTER TABLE inventory_batch ALTER COLUMN locked_unit_cost SET NOT NULL`,
      );
    }
  });

  it('批次不存在：422 指到行', async () => {
    const { ctx } = writeCtx({}, {
      body: {
        ...CREATE_BODY,
        lines: [
          { ...CREATE_BODY.lines[0], batchIds: ['01900000-0000-7000-8000-0000000005ff'] },
          CREATE_BODY.lines[1],
        ],
      },
    });
    await expect(createSupplierReturn(ctx)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'lines.0.batchIds' },
    });
  });

  it.each([
    [undefined, 'PRECONDITION_REQUIRED'],
    ['', 'PRECONDITION_REQUIRED'],
    ['1', 'VERSION_CONFLICT'],
    ['"1""', 'VERSION_CONFLICT'],
    ['W/"1"', 'VERSION_CONFLICT'],
  ])('拒绝非法 If-Match %s 且无库存副作用', async (header, code) => {
    const order = await createOne();
    const before = await stock();
    const request = makeRequest({ principal: principal(), params: { id: order.id } });
    request.headers['if-match'] = header;
    await expectAppError(completeSupplierReturn({
      database: test.database, request,
      reply: { header() { return this; } } as unknown as FastifyReply,
    }), code);
    expect(await stock()).toEqual(before);
  });

});
