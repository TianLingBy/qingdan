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

  it('D94 口径补全：经理 / 纯仓管 / 采购三个预设都含 purchase.ship', async () => {
    const rows = await test.database.query<{ preset_key: string; action: string }>(
      `SELECT p.preset_key, pp.action
         FROM position p
         JOIN position_permission pp ON pp.position_id = p.id
        WHERE p.tenant_id = $1
          AND p.preset_key IN ('manager', 'warehouse', 'purchase')
          AND pp.domain = 'purchase'
          AND pp.granted = true`,
      [DEMO_IDS.tenantId],
    );
    for (const presetKey of ['manager', 'warehouse', 'purchase']) {
      const actions = rows.rows.filter((row) => row.preset_key === presetKey).map((row) => row.action);
      expect(actions).toContain('ship');
    }
  });

  it('#414 护栏抓到的采购预设漏洞：加工单/加工厂/供应商退货三块都补上了', async () => {
    // 背景：这几格不是「口径未定」，是「业务上明明有人该做，但那个预设整块没有这个域」。
    // 采购能建供应商却建不了加工厂、能跟单却建不了加工单、能发起退货却确认不了。
    const rows = await test.database.query<{ domain: string; action: string }>(
      `SELECT pp.domain, pp.action
         FROM position p
         JOIN position_permission pp ON pp.position_id = p.id
        WHERE p.tenant_id = $1
          AND p.preset_key = 'purchase'
          AND pp.granted = true`,
      [DEMO_IDS.tenantId],
    );
    const granted = new Set(rows.rows.map((row) => `${row.domain}.${row.action}`));

    // 补齐的八格。每一格都对应一个「此前点不到的按钮」。
    for (const scope of [
      'processing.read',
      'processing.create',
      'processor.read',
      'processor.create',
      'processor.update',
      'supplier_return.read',
      'supplier_return.create',
      'supplier_return.approve',
    ]) {
      expect(granted.has(scope)).toBe(true);
    }

    // 刻意没补的三格 —— 它们要么动库存与成本、要么是高争议动作，仍归老板/经理。
    // 写成反向断言，防止有人「顺手补全」时把审批权一起放给采购。
    for (const scope of ['processing.approve', 'processing.ship', 'supplier_return.delete']) {
      expect(granted.has(scope)).toBe(false);
    }
  });

  it('#414 派生的第二个洞：internal_trade 与 commission 不再只有老板能用', async () => {
    // 补之前：内部交易的发货与到货确认没有任何非老板预设能做；
    // 提成比例整块只有老板能看 —— 销售算不出自己的提成。
    const rows = await test.database.query<{ preset_key: string; name: string; domain: string; action: string }>(
      `SELECT p.preset_key, p.name, pp.domain, pp.action
         FROM position p
         JOIN position_permission pp ON pp.position_id = p.id
        WHERE p.tenant_id = $1
          AND pp.domain IN ('internal_trade', 'commission')
          AND pp.granted = true
        ORDER BY p.preset_key, p.name, pp.domain, pp.action`,
      [DEMO_IDS.tenantId],
    );

    const pick = (name: string, domain: string) =>
      [
        ...new Set(
          rows.rows
            .filter((row) => row.name === name && row.domain === domain)
            .map((row) => row.action),
        ),
      ].sort();

    // 经理：开单与改单（调拨要决策），read 与 view_handler 来自 flatMap。
    expect(pick('经理', 'internal_trade')).toEqual(
      expect.arrayContaining(['create', 'read', 'update', 'view_handler']),
    );
    // 纯仓管：发出侧发货 + 接收侧到货确认，不参与开单。
    expect(pick('纯仓管', 'internal_trade')).toEqual(['approve', 'read', 'ship']);
    // 两个销售型预设都只看，不参与实物动作。
    expect(pick('销售', 'internal_trade')).toEqual(['read']);
    expect(pick('销售+仓管', 'internal_trade')).toEqual(['read']);
    // 采购不涉及内部交易 —— 反向断言，防顺手铺全。
    expect(pick('采购', 'internal_trade')).toEqual([]);

    // 提成比例：销售看得到自己的，财务能改，采购看不到。
    expect(pick('销售', 'commission')).toEqual(['read']);
    expect(pick('财务+销售', 'commission')).toEqual(['create', 'delete', 'read']);
    expect(pick('纯仓管', 'commission')).toEqual([]);
  });

  it('#414 护栏抓到的最大一个洞：customer_return 不再只有老板能用', async () => {
    // 补之前的状态：customer_return 整块在任何非老板预设里都不存在 —— 连 create 都没有。
    // 前端 ReversalsPage 已按 customer_return.create / .approve 判权限，
    // 所以销售的「新建客户退货」和仓管的「确认」按钮全是灰的。
    const rows = await test.database.query<{ preset_key: string; name: string; action: string }>(
      `SELECT p.preset_key, p.name, pp.action
         FROM position p
         JOIN position_permission pp ON pp.position_id = p.id
        WHERE p.tenant_id = $1
          AND pp.domain = 'customer_return'
          AND pp.granted = true
        ORDER BY p.preset_key, p.name, pp.action`,
      [DEMO_IDS.tenantId],
    );

    // 按预设名归组（两个 'sales' 的 preset_key 相同，只有 name 能区分）。
    const byName = new Map<string, Set<string>>();
    for (const row of rows.rows) {
      const key = `${row.preset_key}/${row.name}`;
      if (!byName.has(key)) byName.set(key, new Set());
      byName.get(key)!.add(row.action);
    }

    // 销售：能登记（客户先找销售），能看。
    expect([...(byName.get('sales/销售') ?? [])].sort()).toEqual(['create', 'read']);
    // 销售+仓管：一岗兼两职，登记与确认都要。
    expect([...(byName.get('sales/销售+仓管') ?? [])].sort()).toEqual(['approve', 'create', 'read']);
    // 纯仓管：只确认入库，不登记（create 归销售）。
    expect([...(byName.get('warehouse/纯仓管') ?? [])].sort()).toEqual(['approve', 'read']);

    // 财务刻意没有 —— 退款走结算模块（settlement），customer_return.approve 只管入库。
    // 写成反向断言，防有人「顺手补全」时把入库确认也放给财务。
    expect(byName.has('finance/财务+销售')).toBe(false);
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
