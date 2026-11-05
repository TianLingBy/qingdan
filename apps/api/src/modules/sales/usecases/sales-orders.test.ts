import {
  AppError,
  type SalesOrder,
  type SalesOrderDetail,
  type ScopeMatrix,
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
  cancelSalesOrder,
  createSalesOrder,
  getSalesOrder,
  listSalesOrders,
  updateSalesOrder,
} from './sales-orders.js';

/** 销售单 E 用例 / 数据访问（D15 / D16 / D20 / D21 / D22 / D51 / D52）。 */

const CUSTOMER_ID = '01900000-0000-7000-8000-000000003101';
const OTHER_CUSTOMER_ID = '01900000-0000-7000-8000-000000003102';
const PRODUCT_ID = '01900000-0000-7000-8000-000000003111';
const OTHER_PRODUCT_ID = '01900000-0000-7000-8000-000000003112';
const BATCH_A_ID = '01900000-0000-7000-8000-000000003121';
const BATCH_B_ID = '01900000-0000-7000-8000-000000003122';
const OTHER_BATCH_ID = '01900000-0000-7000-8000-000000003123';
const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000003103';
const FLOW_ID = '01900000-0000-7000-8000-000000003131';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'update', 'delete'] },
];
const READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'sales', actions: ['read'] }];

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_A_ID, BATCH_B_ID],
  qty: '2',
  unitPrice: '15',
  amount: '999',
};

const FEE = {
  feeName: '运费',
  qty: '2',
  unitPrice: '10',
  amount: '999',
  remark: null,
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

describe('sales 销售单用例（PGlite + seed 演示租户）', () => {
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
  ): Promise<SalesOrder> {
    const { ctx, state } = writeCtx(overrides, {
      body: {
        companyId: DEMO_IDS.companyId,
        customerId: CUSTOMER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        fees: [FEE],
        ...input,
      },
    });
    const created = await createSalesOrder(ctx);
    expect(state.statusCode).toBe(201);
    return created;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, NULL, '用例客户', '启用'),
              ($4, $2, $5, NULL, '二司客户', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [
        CUSTOMER_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        OTHER_CUSTOMER_ID,
        OTHER_COMPANY_ID,
      ],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '用例商品', '{}', '件', '启用'),
              ($4, $2, $5, NULL, '二司商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [
        PRODUCT_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        OTHER_PRODUCT_ID,
        OTHER_COMPANY_ID,
      ],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E-UNIT-A', '10', '1000', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'E-UNIT-B', '20', '1000', '0', '0', '0', $5),
              ($7, $2, $8, $9, 'E-UNIT-OTHER', '12', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
        BATCH_B_ID,
        OTHER_BATCH_ID,
        OTHER_COMPANY_ID,
        OTHER_PRODUCT_ID,
      ],
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('开单：E 单号、SQL 金额聚合、行成本下限、费用与审计落库', async () => {
    const created = await createOne();

    expect(created.tenantId).toBe(DEMO_IDS.tenantId);
    expect(created.companyId).toBe(DEMO_IDS.companyId);
    expect(created.orderNo).toMatch(/^E-0001-\d{8}-\d{4}$/);
    expect(created.customerName).toBe('用例客户');
    expect(created.status).toBe('进行中');
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
    expect(created.fees).toEqual([
      {
        feeName: '运费',
        qty: '2',
        unitPrice: '10',
        amount: '20',
        remark: null,
      },
    ]);
    expect(created.totalAmount).toBe('50');

    const floor = await test.database.query<{ cost_floor: string }>(
      `SELECT trim_scale(cost_floor) AS cost_floor
         FROM sales_order_line
        WHERE order_id = $1`,
      [created.id],
    );
    expect(floor.rows[0]?.cost_floor).toBe('15');

    const detail = (await getSalesOrder(
      readCtx({}, { params: { id: created.id } }),
    )) as SalesOrderDetail;
    expect(detail.receipts).toEqual([]);
    expect(detail.receiptBalance).toBe('0');
    expect(detail.cancelable).toEqual({ allowed: true, reason: null });

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result FROM audit_log WHERE object_id = $1`,
      [created.id],
    );
    expect(audit.rows).toEqual([
      { action: 'sales.order.create', result: 'success' },
    ]);
  });

  it('D20 / D22 / D15：破下限、跨公司客户 / 批次、AI 开单与无权限均拒绝', async () => {
    await expectAppError(
      createSalesOrder(
        writeCtx(
          {},
          {
            body: {
              companyId: DEMO_IDS.companyId,
              customerId: CUSTOMER_ID,
              handlerId: DEMO_IDS.ownerEmployeeId,
              lines: [{ ...LINE, unitPrice: '14.999999' }],
            },
          },
        ).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSalesOrder(
        writeCtx(
          {},
          {
            body: {
              companyId: DEMO_IDS.companyId,
              customerId: OTHER_CUSTOMER_ID,
              handlerId: DEMO_IDS.ownerEmployeeId,
              lines: [LINE],
            },
          },
        ).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSalesOrder(
        writeCtx(
          {},
          {
            body: {
              companyId: DEMO_IDS.companyId,
              customerId: CUSTOMER_ID,
              handlerId: DEMO_IDS.ownerEmployeeId,
              lines: [{ ...LINE, batchIds: [OTHER_BATCH_ID] }],
            },
          },
        ).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSalesOrder(
        writeCtx(
          {},
          {
            body: {
              companyId: DEMO_IDS.companyId,
              customerId: CUSTOMER_ID,
              handlerId: DEMO_IDS.ownerEmployeeId,
              lines: [{ ...LINE, productId: OTHER_PRODUCT_ID }],
            },
          },
        ).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSalesOrder(
        writeCtx(
          { scope: READ_ONLY_SCOPE },
          {
            body: {
              companyId: DEMO_IDS.companyId,
              customerId: CUSTOMER_ID,
              handlerId: DEMO_IDS.ownerEmployeeId,
              lines: [LINE],
            },
          },
        ).ctx,
      ),
      'FORBIDDEN',
    );

    await expectAppError(
      createSalesOrder(
        writeCtx(
          {},
          {
            principal: aiPrincipal(),
            auditReason: 'AI 尝试开销售单',
            body: {
              companyId: DEMO_IDS.companyId,
              customerId: CUSTOMER_ID,
              handlerId: DEMO_IDS.ownerEmployeeId,
              lines: [LINE],
            },
          },
        ).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );
  });

  it('列表 / 详情：客户、状态、关键字过滤；跨公司不可见；普通读不记审计', async () => {
    const created = await createOne({ fees: [] });

    const filtered = await listSalesOrders(
      readCtx(
        {},
        {
          query: {
            customerId: CUSTOMER_ID,
            status: '进行中',
            keyword: created.orderNo,
          },
        },
      ),
    );
    expect(filtered.items.map((item) => item.id)).toEqual([created.id]);
    expect(filtered.items[0]?.lines[0]?.batchIds).toEqual([
      BATCH_A_ID,
      BATCH_B_ID,
    ]);

    const byName = await listSalesOrders(
      readCtx({}, { query: { keyword: '用例客户' } }),
    );
    expect(byName.items.map((item) => item.id)).toContain(created.id);

    const outside = principal({ companyIds: [OTHER_COMPANY_ID] });
    const outsideList = await listSalesOrders(
      readCtx(outside, { query: { keyword: created.orderNo } }),
    );
    expect(outsideList.items).toHaveLength(0);
    await expectAppError(
      getSalesOrder(readCtx(outside, { params: { id: created.id } })),
      'NOT_FOUND',
    );

    const reads = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action IN ('sales.order.list.read', 'sales.order.detail.read')`,
    );
    expect(reads.rows[0]?.count).toBe('0');
  });

  it('修改：If-Match 必填、版本冲突、整体替换商品 / 费用；AI 修改放行', async () => {
    const created = await createOne();

    await expectAppError(
      updateSalesOrder(
        writeCtx(
          {},
          {
            params: { id: created.id },
            body: { fees: [] },
          },
        ).ctx,
      ),
      'PRECONDITION_REQUIRED',
    );
    await expectAppError(
      updateSalesOrder(
        writeCtx(
          {},
          {
            params: { id: created.id },
            headers: { 'if-match': '"9"' },
            body: { fees: [] },
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
          fees: [
            {
              feeName: '装卸费',
              qty: '1',
              unitPrice: '8',
              amount: '1',
            },
          ],
        },
      },
    );
    const updated = await updateSalesOrder(ctx);
    expect(state.headers.ETag).toBe('"2"');
    expect(updated.version).toBe(2);
    expect(updated.lines[0]).toMatchObject({
      amount: '60',
      batchIds: [BATCH_B_ID],
    });
    expect(updated.fees).toEqual([
      {
        feeName: '装卸费',
        qty: '1',
        unitPrice: '8',
        amount: '8',
        remark: null,
      },
    ]);
    expect(updated.totalAmount).toBe('68');

    const aiUpdate = writeCtx(
      {},
      {
        principal: aiPrincipal(),
        auditReason: 'AI 修改销售单',
        params: { id: created.id },
        headers: { 'if-match': '"2"' },
        body: { handlerId: DEMO_IDS.managerEmployeeId },
      },
    );
    const aiUpdated = await updateSalesOrder(aiUpdate.ctx);
    expect(aiUpdated.version).toBe(3);
    expect(aiUpdated.handlerId).toBe(DEMO_IDS.managerEmployeeId);

    const completed = await createOne();
    await test.database.query(
      `UPDATE sales_order SET status = '已完成' WHERE id = $1`,
      [completed.id],
    );
    await expectAppError(
      updateSalesOrder(
        writeCtx(
          {},
          {
            params: { id: completed.id },
            headers: { 'if-match': '"1"' },
            body: { customerId: CUSTOMER_ID },
          },
        ).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'sales.order.update'
          AND object_id = $1
          AND result = 'success'`,
      [created.id],
    );
    expect(audit.rows[0]?.count).toBe('2');
  });

  it('取消：D21 有下游 / 已完成拒绝，AI 禁止；成功置已取消并记审计', async () => {
    const withDownstream = await createOne();
    await test.database.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id, handled_by)
       VALUES ($1, $2, $3, $4, '-1', 'E', $5, $6)`,
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
      cancelSalesOrder(
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

    const completed = await createOne();
    await test.database.query(
      `UPDATE sales_order SET status = '已完成' WHERE id = $1`,
      [completed.id],
    );
    await expectAppError(
      cancelSalesOrder(
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

    const aiTarget = await createOne();
    await expectAppError(
      cancelSalesOrder(
        writeCtx(
          {},
          {
            principal: aiPrincipal(),
            auditReason: 'AI 尝试取消销售单',
            params: { id: aiTarget.id },
            headers: { 'if-match': '"1"' },
          },
        ).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    const created = await createOne();
    const { ctx, state } = writeCtx(
      {},
      {
        params: { id: created.id },
        headers: { 'if-match': '"1"' },
      },
    );
    const cancelled = await cancelSalesOrder(ctx);
    expect(state.headers.ETag).toBe('"2"');
    expect(cancelled.status).toBe('已取消');
    expect(cancelled.version).toBe(2);

    await expectAppError(
      cancelSalesOrder(
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

    const detail = (await getSalesOrder(
      readCtx({}, { params: { id: created.id } }),
    )) as SalesOrderDetail;
    expect(detail.cancelable).toEqual({
      allowed: false,
      reason: 'already_cancelled',
    });
  });
});
