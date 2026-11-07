import {
  AppError,
  type CustomerReturn,
  type SalesOrder,
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
  createCustomerReturn,
  getCustomerReturn,
  listCustomerReturns,
} from './customer-returns.js';
import { createSalesOrder } from './sales-orders.js';

const CUSTOMER_ID = '01900000-0000-7000-8000-000000006101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000006111';
const BATCH_ID = '01900000-0000-7000-8000-000000006121';
const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000006131';

const SALES_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'update', 'delete', 'view_price'] },
];
const RETURN_WRITE_SCOPE: ScopeMatrix = [
  { domain: 'customer_return', actions: ['read', 'create'] },
];
const RETURN_READ_SCOPE: ScopeMatrix = [
  { domain: 'customer_return', actions: ['read'] },
];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly auditReason?: string | null;
}

function makeRequest(input: FakeRequestInput): FastifyRequest {
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
    headers: {},
    ip: '127.0.0.1',
    auditSource: 'web',
    auditReason: input.auditReason ?? null,
  } as unknown as FastifyRequest;
}

function makeReply(): {
  reply: FastifyReply;
  state: { statusCode: number };
} {
  const state = { statusCode: 200 };
  const reply = {
    status(code: number) {
      state.statusCode = code;
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
    credentialId: 'customer-return-session-test',
    companyIds: [DEMO_IDS.companyId],
    scope: RETURN_WRITE_SCOPE,
    source: 'web',
    credentialType: 'session',
    sessionRenewed: false,
    ...overrides,
  };
}

function managerPrincipal(
  overrides: Partial<Principal> = {},
): Principal {
  return principal({
    actorId: DEMO_IDS.managerEmployeeId,
    employeeId: DEMO_IDS.managerEmployeeId,
    credentialId: 'manager-return-session-test',
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

describe('sales R 客户退货用例（PGlite + seed 演示租户）', () => {
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
    body: unknown,
    overrides: Partial<Principal> = {},
    auditReason: string | null = null,
  ) {
    const { reply, state } = makeReply();
    return {
      ctx: {
        database: test.database,
        request: makeRequest({
          principal: principal(overrides),
          body,
          auditReason,
        }),
        reply,
      },
      state,
    };
  }

  async function createOrder(): Promise<SalesOrder> {
    const { reply } = makeReply();
    return createSalesOrder({
      database: test.database,
      request: makeRequest({
        principal: principal({ scope: SALES_SCOPE }),
        body: {
          companyId: DEMO_IDS.companyId,
          customerId: CUSTOMER_ID,
          handlerId: DEMO_IDS.ownerEmployeeId,
          lines: [
            {
              productId: PRODUCT_ID,
              batchIds: [BATCH_ID],
              qty: '2',
              unitPrice: '15',
              amount: '999',
            },
          ],
          fees: [],
        },
      }),
      reply,
    });
  }

  async function createReturn(
    originalSalesOrderId: string,
    payload: Record<string, unknown> = {},
    overrides: Partial<Principal> = {},
  ): Promise<{ customerReturn: CustomerReturn; statusCode: number }> {
    const { ctx, state } = writeCtx(
      {
        companyId: DEMO_IDS.companyId,
        originalSalesOrderId,
        returnType: '退货退款',
        refundMode: '原路退款',
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds: [BATCH_ID],
            qty: '2',
            unitPrice: '12.5',
            amount: '999',
          },
        ],
        refundAmount: '25',
        ...payload,
      },
      overrides,
    );
    const customerReturn = await createCustomerReturn(ctx);
    return { customerReturn, statusCode: state.statusCode };
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '退货二司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, NULL, '退货测试客户', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '退货测试商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'RETURN-TEST', '10', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
  });

  afterAll(async () => {
    await test?.database.close();
  });

  it('经理登记退货退款：R 单号、SQL 行金额、列表筛选、详情与成功审计', async () => {
    const order = await createOrder();
    const { customerReturn, statusCode } = await createReturn(
      order.id,
      {},
      managerPrincipal(),
    );
    expect(statusCode).toBe(201);
    expect(customerReturn.returnNo).toMatch(/^R-0001-\d{8}-\d{4}$/);
    expect(customerReturn).toMatchObject({
      companyId: DEMO_IDS.companyId,
      originalSalesOrderId: order.id,
      returnType: '退货退款',
      onlyRefundKind: null,
      refundMode: '原路退款',
      status: '进行中',
      refundAmount: '25',
      version: 1,
    });
    expect(customerReturn.lines).toEqual([
      {
        productId: PRODUCT_ID,
        batchIds: [BATCH_ID],
        qty: '2',
        unitPrice: '12.5',
        amount: '25',
      },
    ]);

    const page = await listCustomerReturns(
      readCtx(
        { scope: RETURN_READ_SCOPE },
        {
          query: {
            originalSalesOrderId: order.id,
            status: '进行中',
            keyword: customerReturn.returnNo,
          },
        },
      ),
    );
    expect(page.items.map((item) => item.id)).toEqual([customerReturn.id]);
    expect(page.nextCursor).toBeNull();

    const detail = await getCustomerReturn(
      readCtx(
        { scope: RETURN_READ_SCOPE },
        { params: { id: customerReturn.id } },
      ),
    );
    expect(detail).toEqual(customerReturn);

    const audit = await test.database.query<{
      action: string;
      result: string;
      company_id: string;
    }>(
      `SELECT action, result, company_id
         FROM audit_log
        WHERE object_id = $1`,
      [customerReturn.id],
    );
    expect(audit.rows).toEqual([
      {
        action: 'customer_return.create',
        result: 'success',
        company_id: DEMO_IDS.companyId,
      },
    ]);
  });

  it('仅退款可无明细；D40 子类型与退款方式原样落库', async () => {
    const order = await createOrder();
    const { customerReturn } = await createReturn(order.id, {
      returnType: '仅退款',
      onlyRefundKind: '减成交额',
      refundMode: '冲抵应收',
      lines: [],
      refundAmount: '10',
    });
    expect(customerReturn.onlyRefundKind).toBe('减成交额');
    expect(customerReturn.lines).toEqual([]);
  });

  it('D47 岗位、权限、公司隔离、批次归属、AI 与只读角色均拒绝', async () => {
    const order = await createOrder();
    const payload = {
      companyId: DEMO_IDS.companyId,
      originalSalesOrderId: order.id,
      returnType: '退货退款',
      refundMode: '原路退款',
      lines: [
        {
          productId: PRODUCT_ID,
          batchIds: [BATCH_ID],
          qty: '1',
          unitPrice: '10',
          amount: '10',
        },
      ],
      refundAmount: '10',
    };

    await expectAppError(
      createCustomerReturn(
        writeCtx(payload, {
          actorId: DEMO_IDS.salesEmployeeId,
          employeeId: DEMO_IDS.salesEmployeeId,
          credentialId: 'sales-return-session-test',
        }).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      createCustomerReturn(
        writeCtx(payload, { scope: RETURN_READ_SCOPE }).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      createCustomerReturn(
        writeCtx(
          payload,
          { actorType: 'ai', credentialId: 'return-ai-token' },
          'AI 尝试登记退货',
        ).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );
    await expectAppError(
      getCustomerReturn(
        readCtx(
          { companyIds: [OTHER_COMPANY_ID], scope: RETURN_READ_SCOPE },
          { params: { id: order.id } },
        ),
      ),
      'NOT_FOUND',
    );
    await expectAppError(
      createReturn(
        order.id,
        {
          lines: [
            {
              productId: PRODUCT_ID,
              batchIds: ['01900000-0000-7000-8000-000000006199'],
              qty: '1',
              unitPrice: '10',
              amount: '10',
            },
          ],
        },
        managerPrincipal(),
      ),
      'VALIDATION_FAILED',
    );

    const persisted = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM customer_return
        WHERE original_sales_order_id = $1`,
      [order.id],
    );
    expect(persisted.rows[0]?.count).toBe('0');
  });
});
