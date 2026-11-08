import { allowsScope, type ScopeMatrix } from '@qingdan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { computeAuthz } from './service.js';

const TENANT = '01900000-0000-7000-8000-000000000201';
const TENANT_OTHER = '01900000-0000-7000-8000-000000000202';
const COMPANY_A = '01900000-0000-7000-8000-000000000203';
const COMPANY_B = '01900000-0000-7000-8000-000000000204';
const POSITION_SALES = '01900000-0000-7000-8000-000000000211';
const POSITION_WAREHOUSE = '01900000-0000-7000-8000-000000000212';
const EMP_SALES = '01900000-0000-7000-8000-000000000221';
const EMP_DISABLED = '01900000-0000-7000-8000-000000000222';
const EMP_OWNER = '01900000-0000-7000-8000-000000000223';

describe('权限判定（D15 / D50 / D52.1，三层合并 + token 交集）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await test.database.transaction(async (tx) => {
      await tx.query(`INSERT INTO tenant (id, name, plan, status) VALUES ($1, '权限租户', '基础版', '启用')`, [TENANT]);
      await tx.query(`INSERT INTO tenant (id, name, plan, status) VALUES ($1, '别的租户', '基础版', '启用')`, [TENANT_OTHER]);
      await tx.query(`INSERT INTO company (id, tenant_id, name, code) VALUES ($1, $2, '公司A', '0001')`, [COMPANY_A, TENANT]);
      await tx.query(`INSERT INTO company (id, tenant_id, name, code) VALUES ($1, $2, '公司B', '0002')`, [COMPANY_B, TENANT]);

      await tx.query(
        `INSERT INTO position (id, tenant_id, name, kind, is_system) VALUES ($1, $2, '销售', '预设', true)`,
        [POSITION_SALES, TENANT],
      );
      await tx.query(
        `INSERT INTO position (id, tenant_id, name, kind, is_system) VALUES ($1, $2, '纯仓管', '预设', true)`,
        [POSITION_WAREHOUSE, TENANT],
      );
      for (const [domain, action] of [
        ['sales', 'read'],
        ['sales', 'create'],
        ['customer', 'read'],
      ] as const) {
        await tx.query(
          `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
           VALUES ($1, $2, $3, $4, true)`,
          [TENANT, POSITION_SALES, domain, action],
        );
      }
      await tx.query(
        `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
         VALUES ($1, $2, 'inventory_qty', 'read', true)`,
        [TENANT, POSITION_WAREHOUSE],
      );

      const employees: [string, string, string, boolean, '在职' | '停用'][] = [
        [EMP_SALES, '000001', '销售甲', false, '在职'],
        [EMP_DISABLED, '000002', '停用乙', false, '停用'],
        [EMP_OWNER, '000003', '老板丙', true, '在职'],
      ];
      for (const [id, employeeNo, name, isOwner, status] of employees) {
        await tx.query(
          `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, TENANT, employeeNo, `1000000${employeeNo.slice(-4)}`, name, status, isOwner],
        );
      }
      // 销售：绑定公司 A + 销售岗。老板靠 is_owner 短路取全租户公司，不需要绑定行。
      await tx.query(
        `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
         VALUES ($1, $2, $3, $4)`,
        [TENANT, EMP_SALES, COMPANY_A, POSITION_SALES],
      );
      await tx.query(
        `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
         VALUES ($1, $2, $3, $4)`,
        [TENANT, EMP_DISABLED, COMPANY_A, POSITION_SALES],
      );

      // 个人覆盖（D50）：减 sales.create、加 sales.update（覆盖优先于岗位并集）。
      await tx.query(
        `INSERT INTO employee_permission_override (tenant_id, employee_id, domain, action, granted, operator_id)
         VALUES ($1, $2, 'sales', 'create', false, $3), ($1, $2, 'sales', 'update', true, $3)`,
        [TENANT, EMP_SALES, EMP_OWNER],
      );
    });
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('① 岗位并集 + ② 个人覆盖 ⊕：减项生效、加项生效', async () => {
    const result = await computeAuthz(test.database, { employeeId: EMP_SALES, tenantId: TENANT });
    expect(result).not.toBeNull();

    expect(result!.companyIds).toEqual([COMPANY_A]);
    expect(allowsScope(result!.scope, 'sales', 'read')).toBe(true);
    expect(allowsScope(result!.scope, 'customer', 'read')).toBe(true);
    // 个人覆盖 granted=false 减掉岗位基线
    expect(allowsScope(result!.scope, 'sales', 'create')).toBe(false);
    // 个人覆盖 granted=true 在基线之上加
    expect(allowsScope(result!.scope, 'sales', 'update')).toBe(true);
    // 未绑定岗位的域不会凭空出现
    expect(allowsScope(result!.scope, 'inventory_qty', 'read')).toBe(false);
  });

  it('多岗并集：同一公司再绑仓管岗，下一次请求立即多出库存读权限（不缓存）', async () => {
    await test.database.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2, $3, $4)`,
      [TENANT, EMP_SALES, COMPANY_A, POSITION_WAREHOUSE],
    );

    const result = await computeAuthz(test.database, { employeeId: EMP_SALES, tenantId: TENANT });
    expect(allowsScope(result!.scope, 'inventory_qty', 'read')).toBe(true);
  });

  it('③ 公司集合只含绑定公司（未绑定的 B 公司不可见）', async () => {
    const result = await computeAuthz(test.database, { employeeId: EMP_SALES, tenantId: TENANT });
    expect(result!.companyIds).not.toContain(COMPANY_B);
  });

  it('老板短路：公司集合 = 全租户公司', async () => {
    const result = await computeAuthz(test.database, { employeeId: EMP_OWNER, tenantId: TENANT });
    expect(result).not.toBeNull();
    expect(result!.companyIds).toEqual([COMPANY_A, COMPANY_B].sort());
  });

  it('老板全权限免配：scope 覆盖全部功能域 × 全部动作（D15 / F8）', async () => {
    const result = await computeAuthz(test.database, { employeeId: EMP_OWNER, tenantId: TENANT });
    expect(result).not.toBeNull();
    // 24 个功能域全部可读；每个域 8 个动作齐全（老板不依赖岗位绑定）
    expect(result!.scope).toHaveLength(24);
    for (const entry of result!.scope) {
      expect(entry.actions).toHaveLength(8);
    }
  });

  it('token scope 交集：只保留 scope 内动作，且不能放大员工权限', async () => {
    const tokenScope: ScopeMatrix = [
      { domain: 'sales', actions: ['read', 'approve'] },
      { domain: 'settlement', actions: ['create'] },
    ];
    const result = await computeAuthz(test.database, {
      employeeId: EMP_SALES,
      tenantId: TENANT,
      tokenScope,
    });

    expect(result).not.toBeNull();
    expect(allowsScope(result!.scope, 'sales', 'read')).toBe(true);
    // 员工本来就没有 approve / settlement.create，token 写进去也不能补出来（D52.1 不放大）。
    expect(allowsScope(result!.scope, 'sales', 'approve')).toBe(false);
    expect(allowsScope(result!.scope, 'settlement', 'create')).toBe(false);
    // 员工有、scope 没有的动作被收窄掉。
    expect(allowsScope(result!.scope, 'customer', 'read')).toBe(false);
    expect(result!.scope.map((entry) => entry.domain)).toEqual(['sales']);
  });

  it('员工停用 → null（D52.1②：立即失效，不等缓存过期）', async () => {
    const result = await computeAuthz(test.database, { employeeId: EMP_DISABLED, tenantId: TENANT });
    expect(result).toBeNull();
  });

  it('跨租户查询 → null（员工不属于该租户）', async () => {
    const result = await computeAuthz(test.database, { employeeId: EMP_SALES, tenantId: TENANT_OTHER });
    expect(result).toBeNull();
  });
});
