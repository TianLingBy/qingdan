import { TODO_KINDS, type TodoItem, type TodoList } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import type { Database, QueryResultLike, SqlClient } from '../../platform/db/client.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * GET /api/v1/todos 工作台待办（D89 / #289，收口 #308）。
 *
 * 覆盖：
 * - 未登录 401；无 `workbench.read` 403；
 * - 一个 `approve` 都没有 → 200 + 6 条全 count=0（不查库），与「有 approve 但全 0」形状相同；
 * - 只有 settlement.approve → 6 个 kind 全返回，只有结算有笔数，其余 0；
 * - 跨公司：两家公司各 1 条客户退货 → 给 2；5 个域 approve 时 count 查询数 ≤ 6、不按公司翻倍；
 * - 「本人负责」：两个经手人各看各的；提成归属人不是本人不计结算；
 * - 退货待办 `hint` 与「可见公司内」口径一致；
 * - 4 类本人负责待办的计数有 owner 组合索引；
 * - 响应不含金额字段。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';

const COMPANY_OTHER = '01900000-0000-7000-8000-000000007001';
const POSITION_FINANCE_ONLY = '01900000-0000-7000-8000-000000007101';
const POSITION_PROCESSING = '01900000-0000-7000-8000-000000007102';
const POSITION_NO_WORKBENCH = '01900000-0000-7000-8000-000000007103';
const POSITION_MULTI_APPROVE = '01900000-0000-7000-8000-000000007104';
const POSITION_ZERO_APPROVE = '01900000-0000-7000-8000-000000007105';
const EMP_FINANCE = '01900000-0000-7000-8000-000000007201';
const EMP_PROCESSING_A = '01900000-0000-7000-8000-000000007202';
const EMP_PROCESSING_B = '01900000-0000-7000-8000-000000007203';
const EMP_NO_WORKBENCH = '01900000-0000-7000-8000-000000007204';
const EMP_MULTI_APPROVE = '01900000-0000-7000-8000-000000007205';
const EMP_ZERO_APPROVE = '01900000-0000-7000-8000-000000007206';
const PROCESSOR_ID = '01900000-0000-7000-8000-000000007301';
const CUSTOMER_DEMO = '01900000-0000-7000-8000-000000007701';
const CUSTOMER_OTHER = '01900000-0000-7000-8000-000000007702';
const SALES_ORDER_DEMO = '01900000-0000-7000-8000-000000007801';
const SALES_ORDER_OTHER = '01900000-0000-7000-8000-000000007802';
const CUSTOMER_RETURN_DEMO = '01900000-0000-7000-8000-000000007901';
const CUSTOMER_RETURN_OTHER = '01900000-0000-7000-8000-000000007902';

const FINANCE_PHONE = '10000000111';
const PROCESSING_A_PHONE = '10000000112';
const PROCESSING_B_PHONE = '10000000113';
const NO_WORKBENCH_PHONE = '10000000114';
const MULTI_APPROVE_PHONE = '10000000115';
const ZERO_APPROVE_PHONE = '10000000116';

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

/**
 * 统计应用数据库上的 `query` 调用，用来给「串行 count 有上限」钉断言。
 * 只筛待办计数 SQL，认证 / 会话查询不计入。
 */
class CountingDatabase implements Database {
  private readonly statements: string[] = [];

  constructor(private readonly inner: Database) {}

  reset(): void {
    this.statements.length = 0;
  }

  countQueries(): readonly string[] {
    return this.statements.filter((sql) => sql.includes('SELECT count(*)::int AS count'));
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<T>> {
    this.statements.push(sql);
    return this.inner.query<T>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    return this.inner.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.inner.transaction((tx) =>
      fn({
        query: <R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
          this.statements.push(sql);
          return tx.query<R>(sql, params);
        },
        exec: (sql: string) => tx.exec(sql),
      }),
    );
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}

async function login(app: FastifyInstance, phone: string, requestId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

describe('工作台待办 HTTP（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let counting: CountingDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  let financeCookie: string;
  let processingACookie: string;
  let processingBCookie: string;
  let noWorkbenchCookie: string;
  let multiApproveCookie: string;
  let zeroApproveCookie: string;

  async function insertPosition(
    id: string,
    name: string,
    permissions: readonly (readonly [string, string])[],
  ): Promise<void> {
    await test.database.query(
      `INSERT INTO position (id, tenant_id, name, kind, is_system)
       VALUES ($1::uuid, $2, $3, '自定义', false)`,
      [id, DEMO_IDS.tenantId, name],
    );
    for (const [domain, action] of permissions) {
      await test.database.query(
        `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
         VALUES ($1, $2::uuid, $3, $4, true)`,
        [DEMO_IDS.tenantId, id, domain, action],
      );
    }
  }

  async function insertEmployee(input: {
    id: string;
    employeeNo: string;
    phone: string;
    name: string;
    positionId: string;
    companyIds?: readonly string[];
  }): Promise<void> {
    await test.database.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1::uuid, $2, $3, $4, $5, '在职', false)`,
      [input.id, DEMO_IDS.tenantId, input.employeeNo, input.phone, input.name],
    );
    for (const companyId of input.companyIds ?? [DEMO_IDS.companyId]) {
      await test.database.query(
        `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid)`,
        [DEMO_IDS.tenantId, input.id, companyId, input.positionId],
      );
    }
  }

  async function insertSettlement(input: {
    id: string;
    orderNo: string;
    companyId: string;
    commissionOwnerId: string;
  }): Promise<void> {
    await test.database.query(
      `INSERT INTO settlement_order
         (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
          status, total_sale_amount, total_cost_amount, gross_profit,
          gross_margin_rate, related_loss_amount, net_profit,
          commission_rate_snapshot, commission_amount, commission_owner_id)
       VALUES ($1::uuid, $2, $3::uuid, $4, 'E', $1::uuid,
               '待确认', '100', '70', '30', '0.3', '0', '30', '0', '0', $5::uuid)`,
      [input.id, DEMO_IDS.tenantId, input.companyId, input.orderNo, input.commissionOwnerId],
    );
  }

  async function insertProcessingOrder(input: {
    id: string;
    orderNo: string;
    companyId: string;
    handlerId: string;
    status?: '进行中' | '已完成' | '已取消';
  }): Promise<void> {
    await test.database.query(
      `INSERT INTO processing_order
         (id, tenant_id, company_id, order_no, processor_id, handler_id, status, input_qty)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, $7, '10')`,
      [
        input.id,
        DEMO_IDS.tenantId,
        input.companyId,
        input.orderNo,
        PROCESSOR_ID,
        input.handlerId,
        input.status ?? '进行中',
      ],
    );
  }

  /** 跨公司计数用：同一租户下每家公司的客户 / 销售单 / 进行中的客户退货各一条。 */
  async function insertCustomerReturn(input: {
    returnId: string;
    returnNo: string;
    companyId: string;
    customerId: string;
    salesOrderId: string;
    salesOrderNo: string;
  }): Promise<void> {
    await test.database.query(
      `INSERT INTO customer (id, tenant_id, company_id, name)
       VALUES ($1::uuid, $2, $3::uuid, $4)`,
      [input.customerId, DEMO_IDS.tenantId, input.companyId, `待办测试客户-${input.returnNo}`],
    );
    await test.database.query(
      `INSERT INTO sales_order (id, tenant_id, company_id, order_no, customer_id, handler_id)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid)`,
      [
        input.salesOrderId,
        DEMO_IDS.tenantId,
        input.companyId,
        input.salesOrderNo,
        input.customerId,
        DEMO_IDS.salesEmployeeId,
      ],
    );
    await test.database.query(
      `INSERT INTO customer_return
         (id, tenant_id, company_id, return_no, original_sales_order_id,
          return_type, refund_mode, status, refund_amount)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, '退货退款', '原路退款', '进行中', '10')`,
      [
        input.returnId,
        DEMO_IDS.tenantId,
        input.companyId,
        input.returnNo,
        input.salesOrderId,
      ],
    );
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);

    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code) VALUES ($1::uuid, $2, '另一家公司', '0002')`,
      [COMPANY_OTHER, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO processor (id, tenant_id, company_id, name)
       VALUES ($1::uuid, $2, $3::uuid, '待办测试加工厂')`,
      [PROCESSOR_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );

    await insertPosition(POSITION_FINANCE_ONLY, '仅结算审批', [
      ['workbench', 'read'],
      ['settlement', 'approve'],
    ]);
    await insertPosition(POSITION_PROCESSING, '加工完成', [
      ['workbench', 'read'],
      ['processing', 'approve'],
    ]);
    // 没有 workbench.read：用来验证端点自身权限点。
    await insertPosition(POSITION_NO_WORKBENCH, '无工作台读', [['sales', 'read']]);
    // 5 个域 approve + 两家可见公司：验证跨公司计数与 count 查询次数上限。
    await insertPosition(POSITION_MULTI_APPROVE, '多域审批', [
      ['workbench', 'read'],
      ['settlement', 'approve'],
      ['stocktake', 'approve'],
      ['inventory_qty', 'approve'],
      ['customer_return', 'approve'],
      ['processing', 'approve'],
    ]);
    // 有 approve 但库里没有任何候选单据：用来对比「一个 approve 都没有」的形状。
    await insertPosition(POSITION_ZERO_APPROVE, '零数据审批', [
      ['workbench', 'read'],
      ['supplier_return', 'approve'],
    ]);

    await insertEmployee({
      id: EMP_FINANCE,
      employeeNo: '000011',
      phone: FINANCE_PHONE,
      name: '结算审批员',
      positionId: POSITION_FINANCE_ONLY,
    });
    await insertEmployee({
      id: EMP_PROCESSING_A,
      employeeNo: '000012',
      phone: PROCESSING_A_PHONE,
      name: '加工经手甲',
      positionId: POSITION_PROCESSING,
    });
    await insertEmployee({
      id: EMP_PROCESSING_B,
      employeeNo: '000013',
      phone: PROCESSING_B_PHONE,
      name: '加工经手乙',
      positionId: POSITION_PROCESSING,
    });
    await insertEmployee({
      id: EMP_NO_WORKBENCH,
      employeeNo: '000014',
      phone: NO_WORKBENCH_PHONE,
      name: '无工作台权限',
      positionId: POSITION_NO_WORKBENCH,
    });
    await insertEmployee({
      id: EMP_MULTI_APPROVE,
      employeeNo: '000015',
      phone: MULTI_APPROVE_PHONE,
      name: '多域审批员',
      positionId: POSITION_MULTI_APPROVE,
      companyIds: [DEMO_IDS.companyId, COMPANY_OTHER],
    });
    await insertEmployee({
      id: EMP_ZERO_APPROVE,
      employeeNo: '000016',
      phone: ZERO_APPROVE_PHONE,
      name: '零数据审批员',
      positionId: POSITION_ZERO_APPROVE,
    });

    // 结算：本人 1 条；同公司他人提成 1 条；另一家公司 1 条（都不该计入本人）。
    await insertSettlement({
      id: '01900000-0000-7000-8000-000000007401',
      orderNo: 'C-0001-20260101-0001',
      companyId: DEMO_IDS.companyId,
      commissionOwnerId: EMP_FINANCE,
    });
    await insertSettlement({
      id: '01900000-0000-7000-8000-000000007402',
      orderNo: 'C-0001-20260101-0002',
      companyId: DEMO_IDS.companyId,
      commissionOwnerId: DEMO_IDS.ownerEmployeeId,
    });
    await insertSettlement({
      id: '01900000-0000-7000-8000-000000007403',
      orderNo: 'C-0002-20260101-0001',
      companyId: COMPANY_OTHER,
      commissionOwnerId: EMP_FINANCE,
    });

    // 加工单：甲乙各 1 条进行中；甲另有 1 条已完成、1 条在另一家公司。
    await insertProcessingOrder({
      id: '01900000-0000-7000-8000-000000007501',
      orderNo: 'B-0001-20260101-0001',
      companyId: DEMO_IDS.companyId,
      handlerId: EMP_PROCESSING_A,
    });
    await insertProcessingOrder({
      id: '01900000-0000-7000-8000-000000007502',
      orderNo: 'B-0001-20260101-0002',
      companyId: DEMO_IDS.companyId,
      handlerId: EMP_PROCESSING_B,
    });
    await insertProcessingOrder({
      id: '01900000-0000-7000-8000-000000007503',
      orderNo: 'B-0001-20260101-0003',
      companyId: DEMO_IDS.companyId,
      handlerId: EMP_PROCESSING_A,
      status: '已完成',
    });
    await insertProcessingOrder({
      id: '01900000-0000-7000-8000-000000007504',
      orderNo: 'B-0002-20260101-0001',
      companyId: COMPANY_OTHER,
      handlerId: EMP_PROCESSING_A,
    });

    // 客户退货：两家公司各 1 条进行中，多域审批员两家都可见 → 应计 2（混合数）。
    await insertCustomerReturn({
      returnId: CUSTOMER_RETURN_DEMO,
      returnNo: 'R-0001-20260101-0001',
      companyId: DEMO_IDS.companyId,
      customerId: CUSTOMER_DEMO,
      salesOrderId: SALES_ORDER_DEMO,
      salesOrderNo: 'E-0001-20260101-0001',
    });
    await insertCustomerReturn({
      returnId: CUSTOMER_RETURN_OTHER,
      returnNo: 'R-0002-20260101-0001',
      companyId: COMPANY_OTHER,
      customerId: CUSTOMER_OTHER,
      salesOrderId: SALES_ORDER_OTHER,
      salesOrderNo: 'E-0002-20260101-0001',
    });

    counting = new CountingDatabase(test.database);
    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: counting,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-todos-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-todos-login-sales');
    financeCookie = await login(app, FINANCE_PHONE, 'req-todos-login-finance');
    processingACookie = await login(app, PROCESSING_A_PHONE, 'req-todos-login-pa');
    processingBCookie = await login(app, PROCESSING_B_PHONE, 'req-todos-login-pb');
    noWorkbenchCookie = await login(app, NO_WORKBENCH_PHONE, 'req-todos-login-nw');
    multiApproveCookie = await login(app, MULTI_APPROVE_PHONE, 'req-todos-login-multi');
    zeroApproveCookie = await login(app, ZERO_APPROVE_PHONE, 'req-todos-login-zero');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  async function fetchTodos(cookie: string, requestId: string): Promise<TodoList> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/todos',
      headers: readHeaders(cookie, requestId),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as TodoList;
  }

  function countOf(items: readonly TodoItem[], kind: string): number {
    return items.find((item) => item.kind === kind)?.count ?? -1;
  }

  it('出厂岗位预设默认带 workbench.read（D89；seed 与迁移回填同一口径）', async () => {
    const rows = await test.database.query<{ name: string; granted: boolean }>(
      `SELECT p.name, pp.granted
         FROM position p
         JOIN position_permission pp ON pp.position_id = p.id
        WHERE p.kind = '预设'
          AND pp.domain = 'workbench'
          AND pp.action = 'read'
        ORDER BY p.name`,
    );
    expect(rows.rows).toHaveLength(7);
    expect(rows.rows.every((row) => row.granted)).toBe(true);
  });

  it('未登录 401；无 workbench.read → 403', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/todos',
      headers: { 'x-request-id': 'req-todos-anonymous' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    const without = await app.inject({
      method: 'GET',
      url: '/api/v1/todos',
      headers: readHeaders(noWorkbenchCookie, 'req-todos-no-workbench'),
    });
    expect(without.statusCode).toBe(403);
    expect(without.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('无任何 approve：只有预警那一条查库（它要 read），其余 6 条 count=0（不查库）', async () => {
    counting.reset();
    const noApprove = await fetchTodos(salesCookie, 'req-todos-sales-no-approve');
    // 销售岗默认有 workbench.read 与 inventory_qty.read、没有任何域 approve。
    // 加第 7 条 inventory_alert（要 read 不要 approve）之前这里是「一条都不查」；
    // 现在恰好多出这一条 —— 而这正是设计意图：仓管/销售没审批权，但必须看见低库存。
    const queries = counting.countQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('inventory_batch');
    expect(noApprove.items.map((item) => item.kind)).toEqual([...TODO_KINDS]);
    expect(noApprove.items).toHaveLength(TODO_KINDS.length);
    // 除预警外全 0（本 fixture 里也没有低库存批次）。
    expect(
      noApprove.items.filter((item) => item.kind !== 'inventory_alert').every((i) => i.count === 0),
    ).toBe(true);

    const zeroApprove = await fetchTodos(zeroApproveCookie, 'req-todos-zero-approve');
    // 这个岗位有 workbench.read + supplier_return.approve，没有 inventory_qty.read：
    // 只有供应商退货那一条查库，预警那条不查（两件事在同一次请求里各按自己的动作判）。
    counting.reset();
    const trulyNone = await fetchTodos(zeroApproveCookie, 'req-todos-zero-approve-2');
    const zeroQueries = counting.countQueries();
    expect(zeroQueries).toHaveLength(1);
    expect(zeroQueries[0]).toContain('supplier_return');
    expect(trulyNone.items).toHaveLength(TODO_KINDS.length);
    expect(trulyNone.items.every((item) => item.count === 0)).toBe(true);
    expect(zeroApprove.items.map((item) => item.kind)).toEqual(trulyNone.items.map((i) => i.kind));
  });

  it('跨两家公司各 1 条客户退货 → 给 2；5 个域 approve 的 count 查询 ≤ 6，不按公司翻倍', async () => {
    counting.reset();
    const body = await fetchTodos(multiApproveCookie, 'req-todos-multi-approve');

    expect(body.items.map((item) => item.kind)).toEqual([...TODO_KINDS]);
    // 两家公司各 1 条进行中的客户退货：混合计数给 2，而不是按公司拆成 1。
    expect(countOf(body.items, 'customer_return_pending')).toBe(2);

    // 5 个域 approve → 5 条 count；可见公司数、单据行数不增加查询次数。
    const countQueries = counting.countQueries();
    expect(countQueries).toHaveLength(5);
    expect(countQueries.length).toBeLessThanOrEqual(TODO_KINDS.length);

    // hint 必须与「可见公司内」口径一致（客户 / 供应商退货都按可见公司集合统计）。
    expect(body.items.find((item) => item.kind === 'customer_return_pending')?.hint).toBe(
      '可见公司内在办的客户退货待确认',
    );
    expect(body.items.find((item) => item.kind === 'supplier_return_pending')?.hint).toBe(
      '可见公司内在办的供应商退货待确认',
    );
    for (const item of body.items) expect(item.hint).not.toContain('本公司');
  });

  it('4 类本人负责待办的计数有 (tenant_id, company_id, status, 负责人) 组合索引（#308）', async () => {
    const expected = [
      ['settlement_order', 'commission_owner_id'],
      ['inventory_stocktake', 'applicant_id'],
      ['inventory_cost_adjustment', 'requested_by'],
      ['processing_order', 'handler_id'],
    ] as const;
    for (const [table, ownerColumn] of expected) {
      const rows = await test.database.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = $1`,
        [table],
      );
      expect(
        rows.rows.some((row) =>
          row.indexdef.includes(`(tenant_id, company_id, status, ${ownerColumn})`),
        ),
        `${table} 缺 owner 组合索引`,
      ).toBe(true);
    }
  });

  it('只有 settlement.approve：全部 kind 全返回、顺序固定，只有本人提成的结算单计 1', async () => {
    const body = await fetchTodos(financeCookie, 'req-todos-finance');

    expect(body.items.map((item) => item.kind)).toEqual([...TODO_KINDS]);
    expect(body.items).toHaveLength(TODO_KINDS.length);
    expect(countOf(body.items, 'settlement_pending')).toBe(1);
    // 财务岗预设里没有 inventory_qty.read（看 seed.ts 的 finance 段），所以连预警也不查。
    for (const kind of TODO_KINDS.filter((kind) => kind !== 'settlement_pending')) {
      expect(countOf(body.items, kind), kind).toBe(0);
    }

    const settlement = body.items.find((item) => item.kind === 'settlement_pending')!;
    expect(settlement).toMatchObject({
      title: '结算单待确认',
      hint: '你作为提成归属人的结算单待确认',
      routeId: 'settlements',
    });
    // 其它条目即使 count=0 也带完整文案，前端一次拿全。
    for (const item of body.items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.hint.length).toBeGreaterThan(0);
      expect(item.routeId.length).toBeGreaterThan(0);
    }
  });

  it('本人负责：同公司两个加工经手人各看各的 1 条，完成态与另一家公司不计', async () => {
    const a = await fetchTodos(processingACookie, 'req-todos-processing-a');
    const b = await fetchTodos(processingBCookie, 'req-todos-processing-b');

    expect(a.items.map((item) => item.kind)).toEqual([...TODO_KINDS]);
    expect(countOf(a.items, 'processing_pending')).toBe(1);
    expect(countOf(b.items, 'processing_pending')).toBe(1);
    // 审批域之外的条目 count=0。
    expect(countOf(a.items, 'settlement_pending')).toBe(0);
    expect(a.items.find((item) => item.kind === 'processing_pending')).toMatchObject({
      title: '加工单待验收',
      hint: '你经手的加工单待验收',
      routeId: 'processing-orders',
    });
  });

  it('低库存预警进待办：可用量撑不到 8 天的批次计 1，仓管看得到、没 inventory_qty.read 的看不到', async () => {
    // 造一批「进 10 件、30 天内出 60 件」的货：日均出库 2，8.4 天覆盖线 = 16.8，
    // 可用量 10 < 16.8 → 进预警（与 GET /api/v1/inventory/alerts 同一口径，D104）。
    const BATCH_ALERT = '01900000-0000-7000-8000-000000007501';
    const BATCH_NORMAL = '01900000-0000-7000-8000-000000007502';
    const PRODUCT_ALERT = '01900000-0000-7000-8000-000000007504';
    await test.database.query(
      `INSERT INTO product (id, tenant_id, company_id, name, unit)
       VALUES ($1::uuid, $2, $3::uuid, $4, '件')`,
      [PRODUCT_ALERT, DEMO_IDS.tenantId, DEMO_IDS.companyId, '待办预警测试商品'],
    );
    for (const [id, batchNo] of [
      [BATCH_ALERT, 'T-BATCH-ALERT'],
      [BATCH_NORMAL, 'T-BATCH-NORMAL'],
    ] as const) {
      await test.database.query(
        `INSERT INTO inventory_batch
           (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
            inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, '10.000000', '10', '0', '0', '0', $6::uuid)`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, PRODUCT_ALERT, batchNo, DEMO_IDS.ownerEmployeeId],
      );
    }
    // 只有 ALERT 那批有出库流水；NORMAL 那批没有历史出库 → 不进预警（日均 0 无法算天数）。
    const thirtyDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await test.database.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id,
          handled_by, occurred_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, '-60', 'E', $5::uuid, $6::uuid, $7)`,
      [
        '01900000-0000-7000-8000-000000007503',
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        BATCH_ALERT,
        SALES_ORDER_DEMO,
        DEMO_IDS.ownerEmployeeId,
        thirtyDaysAgo,
      ],
    );

    const owner = await fetchTodos(ownerCookie, 'req-todos-alert-owner');
    expect(countOf(owner.items, 'inventory_alert')).toBe(1);
    expect(owner.items.find((item) => item.kind === 'inventory_alert')).toMatchObject({
      title: '低库存批次',
      routeId: 'inventory',
    });

    // 销售岗有 inventory_qty.read → 也能看到（这正是加这一条的目的：没有审批权的人也该知道）。
    const sales = await fetchTodos(salesCookie, 'req-todos-alert-sales');
    expect(countOf(sales.items, 'inventory_alert')).toBe(1);

    // 财务岗没有 inventory_qty.read → count=0，且这条不查库。
    const finance = await fetchTodos(financeCookie, 'req-todos-alert-finance');
    expect(countOf(finance.items, 'inventory_alert')).toBe(0);
  });

  it('响应不含任何金额字段（只给笔数，避免绕过 view_price）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/todos',
      headers: readHeaders(ownerCookie, 'req-todos-no-amount'),
    });
    expect(response.statusCode).toBe(200);
    const text = response.body;
    for (const key of ['amount', 'totalAmount', 'grossProfit', 'refundAmount', 'unitCost', 'price']) {
      expect(text.includes(`"${key}"`), key).toBe(false);
    }
    const parsed = response.json() as TodoList;
    for (const item of parsed.items) {
      expect(Object.keys(item).sort()).toEqual(['count', 'hint', 'kind', 'routeId', 'title']);
    }
  });
});
