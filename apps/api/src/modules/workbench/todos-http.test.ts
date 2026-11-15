import { TODO_KINDS, type TodoItem, type TodoList } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * GET /api/v1/todos 工作台待办（D89 / #289）。
 *
 * 覆盖：
 * - 未登录 401；无 `workbench.read` 403；
 * - 一个 `approve` 都没有 → 200 + 空 items（不查库）；
 * - 只有 settlement.approve → 6 个 kind 全返回，只有结算有笔数，其余 0；
 * - 「本人负责」：两个经手人各看各的；提成归属人不是本人不计结算；
 * - 跨公司隔离；
 * - 响应不含金额字段。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';

const COMPANY_OTHER = '01900000-0000-7000-8000-000000007001';
const POSITION_FINANCE_ONLY = '01900000-0000-7000-8000-000000007101';
const POSITION_PROCESSING = '01900000-0000-7000-8000-000000007102';
const POSITION_NO_WORKBENCH = '01900000-0000-7000-8000-000000007103';
const EMP_FINANCE = '01900000-0000-7000-8000-000000007201';
const EMP_PROCESSING_A = '01900000-0000-7000-8000-000000007202';
const EMP_PROCESSING_B = '01900000-0000-7000-8000-000000007203';
const EMP_NO_WORKBENCH = '01900000-0000-7000-8000-000000007204';
const PROCESSOR_ID = '01900000-0000-7000-8000-000000007301';

const FINANCE_PHONE = '10000000111';
const PROCESSING_A_PHONE = '10000000112';
const PROCESSING_B_PHONE = '10000000113';
const NO_WORKBENCH_PHONE = '10000000114';

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
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
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  let financeCookie: string;
  let processingACookie: string;
  let processingBCookie: string;
  let noWorkbenchCookie: string;

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
    companyId?: string;
  }): Promise<void> {
    await test.database.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1::uuid, $2, $3, $4, $5, '在职', false)`,
      [input.id, DEMO_IDS.tenantId, input.employeeNo, input.phone, input.name],
    );
    await test.database.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2::uuid, $3::uuid, $4::uuid)`,
      [DEMO_IDS.tenantId, input.id, input.companyId ?? DEMO_IDS.companyId, input.positionId],
    );
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

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-todos-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-todos-login-sales');
    financeCookie = await login(app, FINANCE_PHONE, 'req-todos-login-finance');
    processingACookie = await login(app, PROCESSING_A_PHONE, 'req-todos-login-pa');
    processingBCookie = await login(app, PROCESSING_B_PHONE, 'req-todos-login-pb');
    noWorkbenchCookie = await login(app, NO_WORKBENCH_PHONE, 'req-todos-login-nw');
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

  it('出厂岗位预设默认带 workbench.read（D89；seed + 0033 回填同一口径）', async () => {
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

  it('一个 approve 都没有：200 且 items 为空（不返回 count=0 的条目）', async () => {
    const body = await fetchTodos(salesCookie, 'req-todos-sales-no-approve');
    // 销售岗默认有 workbench.read，但没有任何域 approve → 提前返回空数组。
    expect(body.items).toEqual([]);
  });

  it('只有 settlement.approve：6 个 kind 全返回、顺序固定，只有本人提成的结算单计 1', async () => {
    const body = await fetchTodos(financeCookie, 'req-todos-finance');

    expect(body.items.map((item) => item.kind)).toEqual([...TODO_KINDS]);
    expect(body.items).toHaveLength(6);
    expect(countOf(body.items, 'settlement_pending')).toBe(1);
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
