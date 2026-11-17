import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * RLS 实测（D57③）：用 `SET ROLE qingdan_app`（非 superuser、无 BYPASSRLS）验证
 *   - 只看到 current_setting('app.tenant_id') 对应租户的行；
 *   - 跨租户写入被 WITH CHECK 拒绝；
 *   - 未设置 tenant_id 时 fail-closed；
 *   - audit_log 只追加（UPDATE/DELETE 无权限）。
 */

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000a2';
const COMPANY_A = '01900000-0000-7000-8000-0000000000b1';
const COMPANY_B = '01900000-0000-7000-8000-0000000000b2';
const EMPLOYEE_A = '01900000-0000-7000-8000-0000000000c1';
const EMPLOYEE_B = '01900000-0000-7000-8000-0000000000c2';

async function asAppRole<T>(test: TestDatabase, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await test.database.exec('SET ROLE qingdan_app');
  try {
    await test.database.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    return await fn();
  } finally {
    await test.database.query(`SELECT set_config('app.tenant_id', '', false)`);
    await test.database.exec('RESET ROLE');
  }
}

describe('RLS 租户隔离（PGlite + 普通角色）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await test.database.transaction(async (tx) => {
      await tx.query(`INSERT INTO tenant (id, name, status) VALUES ($1, '租户A', '启用')`, [TENANT_A]);
      await tx.query(`INSERT INTO tenant (id, name, status) VALUES ($1, '租户B', '启用')`, [TENANT_B]);
      await tx.query(
        `INSERT INTO company (id, tenant_id, name, code) VALUES ($1, $2, '公司A', '0001')`,
        [COMPANY_A, TENANT_A],
      );
      await tx.query(
        `INSERT INTO company (id, tenant_id, name, code) VALUES ($1, $2, '公司B', '0001')`,
        [COMPANY_B, TENANT_B],
      );
      await tx.query(
        `INSERT INTO employee (id, tenant_id, employee_no, phone, name) VALUES ($1, $2, '000001', '10000000001', '员工A')`,
        [EMPLOYEE_A, TENANT_A],
      );
      await tx.query(
        `INSERT INTO employee (id, tenant_id, employee_no, phone, name) VALUES ($1, $2, '000001', '10000000002', '员工B')`,
        [EMPLOYEE_B, TENANT_B],
      );
    });
  });

  afterAll(async () => {
    await test.database.close();
  });

  beforeEach(async () => {
    // 每个用例从「未设置租户」开始，避免状态串味。
    await test.database.exec('RESET ROLE');
    await test.database.query(`SELECT set_config('app.tenant_id', '', false)`);
  });

  it('普通角色只看到本租户行（tenant=A 只看到 1 行）', async () => {
    const rows = await asAppRole(test, TENANT_A, async () => {
      const result = await test.database.query<{ id: string }>('SELECT id FROM employee ORDER BY id');
      return result.rows;
    });

    expect(rows.map((row) => row.id)).toEqual([EMPLOYEE_A]);

    const other = await asAppRole(test, TENANT_B, async () => {
      const result = await test.database.query<{ id: string }>('SELECT id FROM employee ORDER BY id');
      return result.rows;
    });
    expect(other.map((row) => row.id)).toEqual([EMPLOYEE_B]);
  });

  it('跨租户写入被 WITH CHECK 拒绝（员工B 不能在 tenant=A 上下文插入）', async () => {
    await expect(
      asAppRole(test, TENANT_A, async () => {
        await test.database.query(
          `INSERT INTO employee (id, tenant_id, employee_no, phone, name)
           VALUES ('01900000-0000-7000-8000-0000000000c3', $1, '000003', '10000000003', '越界员工')`,
          [TENANT_B],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    const count = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM employee WHERE id = '01900000-0000-7000-8000-0000000000c3'`,
    );
    expect(count.rows[0]!.n).toBe(0);
  });

  it('未设置 app.tenant_id 时 fail-closed：读 0 行、写被拒', async () => {
    const rows = await asAppRole(test, '', async () => {
      const result = await test.database.query<{ id: string }>('SELECT id FROM employee');
      return result.rows;
    });
    expect(rows).toHaveLength(0);

    await expect(
      asAppRole(test, '', async () => {
        await test.database.query(
          `INSERT INTO employee (id, tenant_id, employee_no, phone, name)
           VALUES ('01900000-0000-7000-8000-0000000000c4', $1, '000004', '10000000004', '无租户员工')`,
          [TENANT_A],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('audit_log 只追加：应用角色能 INSERT，UPDATE/DELETE 被权限拒绝', async () => {
    const privileges = await test.database.query<{
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT has_table_privilege('qingdan_app', 'audit_log', 'INSERT') AS can_insert,
              has_table_privilege('qingdan_app', 'audit_log', 'SELECT') AS can_select,
              has_table_privilege('qingdan_app', 'audit_log', 'UPDATE') AS can_update,
              has_table_privilege('qingdan_app', 'audit_log', 'DELETE') AS can_delete`,
    );
    const grants = privileges.rows[0]!;
    expect(grants.can_insert).toBe(true);
    expect(grants.can_update).toBe(false);
    expect(grants.can_delete).toBe(false);
    // 契约 D51「只授 INSERT」：查询端点落地前不给 SELECT。
    expect(grants.can_select).toBe(false);

    await asAppRole(test, TENANT_A, async () => {
      await test.database.query(
        `INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, source, action, object_type, result, request_id)
         VALUES ('01900000-0000-7000-8000-0000000000d1', $1, 'system', 'system', 'job', 'test.write', 'test', 'success', 'req-rls')`,
        [TENANT_A],
      );
    });

    await expect(
      asAppRole(test, TENANT_A, async () => {
        await test.database.query(`UPDATE audit_log SET result = 'fail'`);
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asAppRole(test, TENANT_A, async () => {
        await test.database.query('DELETE FROM audit_log');
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
