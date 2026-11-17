import { registerServices, resetServices } from '../../../platform/services/registry.js';
import { inventoryServices } from '../../inventory/services/ports.js';
import {
  AppError,
  type CustomerReturn,
  type SalesOrder,
  type ScopeMatrix,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { computeAuthz } from '../../../platform/authz/service.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../testing/pglite.js';
import {
  completeCustomerReturn,
  createCustomerReturn,
  getCustomerReturn,
  listCustomerReturns,
} from './customer-returns.js';
import { createSalesOrder } from './sales-orders.js';

const CUSTOMER_ID = '01900000-0000-7000-8000-000000006101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000006111';
const BATCH_ID = '01900000-0000-7000-8000-000000006121';
const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000006131';
/** 自定义岗位（preset_key IS NULL）员工：权限只来自岗位授权。 */
const CUSTOM_POSITION_ID = '01900000-0000-7000-8000-000000006141';
const CUSTOM_EMPLOYEE_ID = '01900000-0000-7000-8000-000000006151';
/** 分到「老板」预设岗位、但个人覆盖撤销 customer_return.create 的员工。 */
const OWNER_POSITION_EMPLOYEE_ID = '01900000-0000-7000-8000-000000006152';

const SALES_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'update', 'delete', 'view_price'] },
];
const RETURN_WRITE_SCOPE: ScopeMatrix = [
  { domain: 'customer_return', actions: ['read', 'create', 'approve'] },
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
    registerServices(inventoryServices);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '退货二司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name)
       VALUES ($1, $2, $3, NULL, '退货测试客户')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '退货测试商品', '{}', '件')
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
    // 自定义岗位（preset_key IS NULL）+ 岗位授予 customer_return.read/create。
    // 旧实现按 preset_key 白名单放行，这个岗位必被 403；改后只认权限点。
    await test.database.query(
      `INSERT INTO position (id, tenant_id, name, kind, is_system, scope, status, preset_key)
       VALUES ($1, $2, '退货专员', '自定义', false, '公司级', '启用', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOM_POSITION_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
       VALUES ($1, $2, 'customer_return', 'read', true),
              ($1, $2, 'customer_return', 'create', true)
       ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true`,
      [DEMO_IDS.tenantId, CUSTOM_POSITION_ID],
    );
    await test.database.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1, $2, '000098', '10000000098', '退货专员', '在职', false)
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOM_EMPLOYEE_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id, company_id, position_id) DO NOTHING`,
      [
        DEMO_IDS.tenantId,
        CUSTOM_EMPLOYEE_ID,
        DEMO_IDS.companyId,
        CUSTOM_POSITION_ID,
      ],
    );

    // 老板预设岗位 + 个人覆盖撤销 customer_return.create：岗位名不再能绕过权限点。
    const ownerPosition = await test.database.query<{ id: string }>(
      `SELECT id FROM position WHERE tenant_id = $1 AND preset_key = 'owner'`,
      [DEMO_IDS.tenantId],
    );
    const ownerPositionId = ownerPosition.rows[0]?.id;
    if (!ownerPositionId) throw new Error('seed 缺少老板预设岗位');
    await test.database.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1, $2, '000099', '10000000099', '老板岗员工', '在职', false)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_POSITION_EMPLOYEE_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id, company_id, position_id) DO NOTHING`,
      [
        DEMO_IDS.tenantId,
        OWNER_POSITION_EMPLOYEE_ID,
        DEMO_IDS.companyId,
        ownerPositionId,
      ],
    );
    await test.database.query(
      `INSERT INTO employee_permission_override
         (tenant_id, employee_id, domain, action, granted, operator_id)
       VALUES ($1, $2, 'customer_return', 'create', false, $3)
       ON CONFLICT (employee_id, domain, action) DO UPDATE SET granted = false`,
      [
        DEMO_IDS.tenantId,
        OWNER_POSITION_EMPLOYEE_ID,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
  });

  afterAll(async () => {
    resetServices();
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

  it('自定义岗位授予 customer_return.create → 能建单（不再按 preset_key 放行）', async () => {
    const authz = await computeAuthz(test.database, {
      employeeId: CUSTOM_EMPLOYEE_ID,
      tenantId: DEMO_IDS.tenantId,
    });
    if (!authz) throw new Error('自定义岗位员工权限解析失败');
    const order = await createOrder();
    const { customerReturn, statusCode } = await createReturn(
      order.id,
      {},
      {
        actorId: CUSTOM_EMPLOYEE_ID,
        employeeId: CUSTOM_EMPLOYEE_ID,
        credentialId: 'custom-position-return-session-test',
        companyIds: authz.companyIds,
        scope: authz.scope,
      },
    );
    expect(statusCode).toBe(201);
    expect(customerReturn).toMatchObject({
      companyId: DEMO_IDS.companyId,
      originalSalesOrderId: order.id,
      status: '进行中',
    });
  });

  it('老板预设岗位但撤销 customer_return.create → 403 且理由为缺权限点', async () => {
    const authz = await computeAuthz(test.database, {
      employeeId: OWNER_POSITION_EMPLOYEE_ID,
      tenantId: DEMO_IDS.tenantId,
    });
    if (!authz) throw new Error('老板岗员工权限解析失败');
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
    const { ctx } = writeCtx(payload, {
      actorId: OWNER_POSITION_EMPLOYEE_ID,
      employeeId: OWNER_POSITION_EMPLOYEE_ID,
      credentialId: 'owner-position-return-session-test',
      companyIds: authz.companyIds,
      scope: authz.scope,
    });
    const error = await createCustomerReturn(ctx).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      message: '缺少 customer_return.create 权限',
    });
    const persisted = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM customer_return
        WHERE original_sales_order_id = $1`,
      [order.id],
    );
    expect(persisted.rows[0]?.count).toBe('0');
  });

  it('权限、公司隔离、批次归属、AI 与只读角色均拒绝', async () => {
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
  async function finish(id: string, version = 1) {
    const request = makeRequest({ principal: principal(), params: { id } });
    request.headers['if-match'] = `"${version}"`;
    return completeCustomerReturn({
      database: test.database, request,
      reply: { header() { return this; } } as unknown as FastifyReply,
    });
  }

  async function stock() {
    return (await test.database.query(
      `SELECT id, inbound_qty::text, locked_unit_cost::text FROM inventory_batch ORDER BY id`,
    )).rows;
  }

  it('完成：库存与流水同事务、成本不变、完成审计、拒绝重复完成', async () => {
    const order = (await createReturn((await createOrder()).id)).customerReturn;
    const before = await stock();
    const completed = await finish(order.id);
    expect(completed).toMatchObject({ status: '已完成', version: 2 });
    const after = await stock();
    const oldBatch = before.find(row => row.id === BATCH_ID)!;
    const newBatch = after.find(row => row.id === BATCH_ID)!;
    expect(Number(newBatch.inbound_qty) - Number(oldBatch.inbound_qty)).toBe(2);
    expect(newBatch.locked_unit_cost).toBe(oldBatch.locked_unit_cost);
    const flows = await test.database.query(
      `SELECT delta::text, source_doc_type FROM inventory_flow WHERE source_doc_id = $1`, [order.id],
    );
    expect(flows.rows).toHaveLength(1);
    expect(flows.rows.map(row => Number(row.delta))).toContain(2);
    expect(flows.rows.every(row => row.source_doc_type === 'R')).toBe(true);
    await expectAppError(finish(order.id), 'VERSION_CONFLICT');
    await expectAppError(finish(order.id, 2), 'VALIDATION_FAILED');
    expect(await stock()).toEqual(after);
    const audit = await test.database.query(
      `SELECT action FROM audit_log WHERE object_id = $1 AND action = 'customer_return.complete'`, [order.id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('仅退款完成不改变库存且不生成流水', async () => {
    const { customerReturn: order } = await createReturn((await createOrder()).id, {
      returnType: '仅退款', onlyRefundKind: '减成交额', lines: [],
    });
    const before = await stock();
    expect(await finish(order.id)).toMatchObject({ status: '已完成', version: 2 });
    expect(await stock()).toEqual(before);
    expect((await test.database.query(`SELECT id FROM inventory_flow WHERE source_doc_id = $1`, [order.id])).rows).toEqual([]);
  });

  it.each([
    [undefined, 'PRECONDITION_REQUIRED'],
    ['', 'PRECONDITION_REQUIRED'],
    ['1', 'VERSION_CONFLICT'],
    ['"1""', 'VERSION_CONFLICT'],
    ['W/"1"', 'VERSION_CONFLICT'],
  ])('拒绝非法 If-Match %s 且无库存副作用', async (header, code) => {
    const order = (await createReturn((await createOrder()).id)).customerReturn;
    const before = await stock();
    const request = makeRequest({ principal: principal(), params: { id: order.id } });
    request.headers['if-match'] = header;
    await expectAppError(completeCustomerReturn({
      database: test.database, request,
      reply: { header() { return this; } } as unknown as FastifyReply,
    }), code);
    expect(await stock()).toEqual(before);
  });

});
