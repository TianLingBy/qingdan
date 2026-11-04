import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * M1 员工列表（D15 / D50 / D54②）：
 *   - 老板看到全租户 4 人；非老板只看绑定公司集合内的员工；
 *   - 员工被调到第二家公司后，非老板看不到他；
 *   - 游标分页两页无重叠；
 *   - 只回 `phoneMasked`（如 100****0001），完整手机号不出服务端；
 *   - 无 `employee.read` → 403。
 */

const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const SALES_PHONE = '10000000003';

const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000003';
const WAREHOUSE_POSITION_ID = '01900000-0000-7000-8000-000000000016';

interface EmployeeItem {
  id: string;
  employeeNo: string;
  name: string;
  status: string;
  isOwner: boolean;
  phoneMasked: string;
  companies: Array<{
    companyId: string;
    companyName: string;
    positionId: string;
    positionName: string;
  }>;
}

interface EmployeePageBody {
  items: EmployeeItem[];
  nextCursor: string | null;
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

describe('platform 员工列表（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;

  async function list(
    cookie: string,
    requestId: string,
    query = '',
  ) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/employees${query}`,
      headers: { cookie, 'x-request-id': requestId },
    });
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    app = buildApp({
      config: testConfig({ publicBaseUrl: 'https://qingdan.example' }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-employee-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-employee-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('老板看到全租户 4 人，含公司-岗位对与脱敏手机号', async () => {
    const response = await list(ownerCookie, 'req-employee-owner-list');
    expect(response.statusCode).toBe(200);

    const body = response.json() as EmployeePageBody;
    expect(body.items).toHaveLength(4);
    expect(new Set(body.items.map((item) => item.name))).toEqual(
      new Set(['张明', '李强', '王芳', '赵刚']),
    );
    expect(body.nextCursor).toBeNull();

    for (const item of body.items) {
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(item.employeeNo).toMatch(/^\d{6}$/);
      expect(['在职', '停用']).toContain(item.status);
      expect(item.isOwner).toBeTypeOf('boolean');
      expect(item.phoneMasked).toMatch(/^\d{3}\*{4}\d{4}$/);
      expect(item.companies.length).toBeGreaterThan(0);
      for (const company of item.companies) {
        expect(company.companyId).toBe(DEMO_IDS.companyId);
        expect(company.companyName).toBe('演示公司');
        expect(company.positionId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(company.positionName.length).toBeGreaterThan(0);
      }
    }

    const owner = body.items.find((item) => item.id === DEMO_IDS.ownerEmployeeId)!;
    expect(owner.isOwner).toBe(true);
    expect(owner.phoneMasked).toBe('100****0001');
  });

  it('员工调到第二家公司后，非老板只看到绑定公司内的人', async () => {
    // 加第二家公司，把仓管（赵刚）从演示公司调到新公司：他不再属于经理的可见范围。
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [SECOND_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      'DELETE FROM employee_company_position WHERE employee_id = $1',
      [DEMO_IDS.warehouseEmployeeId],
    );
    await test.database.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2, $3, $4)`,
      [DEMO_IDS.tenantId, DEMO_IDS.warehouseEmployeeId, SECOND_COMPANY_ID, WAREHOUSE_POSITION_ID],
    );

    const managerCookie = await login(app, MANAGER_PHONE, 'req-employee-login-manager');
    const response = await list(managerCookie, 'req-employee-manager-list');
    expect(response.statusCode).toBe(200);

    const body = response.json() as EmployeePageBody;
    expect(body.items).toHaveLength(3);
    const ids = body.items.map((item) => item.id);
    expect(ids).not.toContain(DEMO_IDS.warehouseEmployeeId);
    expect(new Set(ids)).toEqual(
      new Set([DEMO_IDS.ownerEmployeeId, DEMO_IDS.managerEmployeeId, DEMO_IDS.salesEmployeeId]),
    );
    // 每家员工只回自己可见公司的公司-岗位对。
    for (const item of body.items) {
      for (const company of item.companies) expect(company.companyId).toBe(DEMO_IDS.companyId);
    }

    // 显式点不可见公司：范围过滤优先，返回空列表而不是越权数据。
    const outside = await list(managerCookie, 'req-employee-manager-outside', `?companyId=${SECOND_COMPANY_ID}`);
    expect(outside.statusCode).toBe(200);
    expect((outside.json() as EmployeePageBody).items).toHaveLength(0);

    // 老板仍能看到全租户 4 人（赵刚现在属于第二家公司）。
    const ownerView = await list(ownerCookie, 'req-employee-owner-after-move');
    expect((ownerView.json() as EmployeePageBody).items).toHaveLength(4);
  });

  it('游标分页两页无重叠', async () => {
    const first = await list(ownerCookie, 'req-employee-page-1', '?limit=2');
    expect(first.statusCode).toBe(200);
    const firstPage = first.json() as EmployeePageBody;
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await list(
      ownerCookie,
      'req-employee-page-2',
      `?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect(second.statusCode).toBe(200);
    const secondPage = second.json() as EmployeePageBody;

    const firstIds = new Set(firstPage.items.map((item) => item.id));
    for (const item of secondPage.items) expect(firstIds.has(item.id)).toBe(false);
    expect(firstPage.items.length + secondPage.items.length).toBe(4);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('只回 phoneMasked，响应里不含完整手机号', async () => {
    const response = await list(ownerCookie, 'req-employee-phone-mask');
    expect(response.statusCode).toBe(200);
    const body = response.json() as EmployeePageBody;
    const serialized = JSON.stringify(body.items);

    for (const item of body.items) {
      expect(item.phoneMasked).toMatch(/^\d{3}\*{4}\d{4}$/);
      expect(item).not.toHaveProperty('phone');
    }

    const phones = await test.database.query<{ phone: string }>(
      'SELECT phone FROM employee WHERE tenant_id = $1',
      [DEMO_IDS.tenantId],
    );
    expect(phones.rows).toHaveLength(4);
    for (const row of phones.rows) {
      expect(serialized).not.toContain(row.phone);
      expect(body.items.some((item) => item.phoneMasked === row.phone)).toBe(false);
    }
  });

  it('无 employee.read 权限 → 403', async () => {
    const response = await list(salesCookie, 'req-employee-forbidden');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});
