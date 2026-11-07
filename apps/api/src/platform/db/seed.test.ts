import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { computeAuthz } from '../authz/service.js';
import { DEMO_IDS, seed } from './seed.js';

/**
 * seed 在 PGlite 上实跑：验证 SQL 可执行、7 套岗位齐全、账号打印不抛错、重复执行幂等。
 * 真实 PG 上的执行仍需 `pnpm -C apps/api seed`（未验证项见交付报告）。
 */
describe('seed（演示租户）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('可执行：建出租户/公司/7 套岗位/4 名员工，工号合法', async () => {
    await seed(test.database);

    const positions = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM position WHERE tenant_id = $1`,
      [DEMO_IDS.tenantId],
    );
    expect(positions.rows[0]!.n).toBe(7);

    const employees = await test.database.query<{ employee_no: string; is_owner: boolean; phone: string }>(
      `SELECT employee_no, is_owner, phone FROM employee WHERE tenant_id = $1 ORDER BY employee_no`,
      [DEMO_IDS.tenantId],
    );
    expect(employees.rows.map((row) => row.employee_no)).toEqual(['000001', '000002', '000003', '000004']);
    expect(employees.rows.filter((row) => row.is_owner)).toHaveLength(1);
    // 占位手机号，不写真实号段。
    for (const row of employees.rows) {
      expect(row.phone).toMatch(/^1[0-9]{10}$/);
    }
  });

  it('老板拿到全公司可见范围，销售岗位权限已生效', async () => {
    const owner = await computeAuthz(test.database, {
      employeeId: DEMO_IDS.ownerEmployeeId,
      tenantId: DEMO_IDS.tenantId,
    });
    expect(owner).not.toBeNull();
    expect(owner!.companyIds).toEqual([DEMO_IDS.companyId]);
    // 老板 = 全权限（含看价）。
    expect(owner!.scope.some((entry) => entry.actions.includes('view_price'))).toBe(true);

    const sales = await computeAuthz(test.database, {
      employeeId: DEMO_IDS.salesEmployeeId,
      tenantId: DEMO_IDS.tenantId,
    });
    expect(sales).not.toBeNull();
    const salesEntry = sales!.scope.find((entry) => entry.domain === 'sales');
    expect(salesEntry?.actions).toEqual(expect.arrayContaining(['read', 'create', 'update']));
  });

  it('D71 盘点角色矩阵：经理可审批，仓管只有「仅删减」', async () => {
    const manager = await computeAuthz(test.database, {
      employeeId: DEMO_IDS.managerEmployeeId,
      tenantId: DEMO_IDS.tenantId,
    });
    const managerStocktake = manager!.scope.find((entry) => entry.domain === 'stocktake');
    expect(managerStocktake?.actions).toEqual(
      expect.arrayContaining(['read', 'create', 'delete', 'approve']),
    );

    const warehouse = await computeAuthz(test.database, {
      employeeId: DEMO_IDS.warehouseEmployeeId,
      tenantId: DEMO_IDS.tenantId,
    });
    const warehouseStocktake = warehouse!.scope.find((entry) => entry.domain === 'stocktake');
    // 盘盈＝create、盘亏＝delete：仓管只有 delete，即只能发起盘亏（D47「仅删减」）。
    expect([...(warehouseStocktake?.actions ?? [])].sort()).toEqual(['delete', 'read']);
  });

  it('重复执行幂等：不重复建岗位/员工', async () => {
    await seed(test.database);

    const employees = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM employee WHERE tenant_id = $1`,
      [DEMO_IDS.tenantId],
    );
    expect(employees.rows[0]!.n).toBe(4);
  });
});
