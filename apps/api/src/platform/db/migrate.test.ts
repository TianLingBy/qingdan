import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { loadMigrationFiles, runMigrations } from './migrate.js';

const CORE_TABLES = [
  'tenant',
  'company',
  'employee',
  'position',
  'position_permission',
  'employee_company_position',
  'employee_permission_override',
  'session',
  'api_token',
  'audit_outbox',
  'audit_log',
  'idempotency_key',
  'number_sequence',
];

describe('纯 SQL 迁移 runner（PGlite / 内存 PG18）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('迁移可跑通，schema_migrations 记录与迁移文件一一对应', async () => {
    const files = await loadMigrationFiles();
    expect(files.length).toBeGreaterThan(0);

    const applied = await test.database.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM schema_migrations ORDER BY id',
    );
    expect(applied.rows.map((row) => row.id)).toEqual(files.map((file) => file.id));
    expect(applied.rows.map((row) => row.checksum)).toEqual(files.map((file) => file.checksum));
  });

  it('核心表全部建出（13 张业务表 + schema_migrations）', async () => {
    const result = await test.database.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = result.rows.map((row) => row.tablename);
    for (const table of CORE_TABLES) {
      expect(names).toContain(table);
    }
    expect(names).toContain('schema_migrations');
  });

  it('重复执行迁移 = 全部跳过（前向 only、幂等）', async () => {
    const files = await loadMigrationFiles();
    const report = await runMigrations(test.database);
    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual(files.map((file) => file.id));
  });

  it('金额精度口径已固化：domain amount = numeric(18,6)', async () => {
    const result = await test.database.query<{ domain_name: string; numeric_precision: number; numeric_scale: number }>(
      `SELECT domain_name, numeric_precision, numeric_scale
       FROM information_schema.domains
       WHERE domain_name = 'amount'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ numeric_precision: 18, numeric_scale: 6 });
  });

  it('processing 单保留完成时的材料成本与损失金额快照', async () => {
    const result = await test.database.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'processing_order'
         AND column_name IN ('material_cost_amount', 'loss_amount')
       ORDER BY column_name`,
    );
    expect(result.rows).toEqual([
      { column_name: 'loss_amount', is_nullable: 'YES' },
      { column_name: 'material_cost_amount', is_nullable: 'YES' },
    ]);
  });

  it('核心表已开 RLS + FORCE RLS，并有 tenant_isolation 策略', async () => {
    const tables = await test.database.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])`,
      [['employee', 'audit_log', 'api_token', 'number_sequence']],
    );
    expect(tables.rows).toHaveLength(4);
    for (const row of tables.rows) {
      expect(row.relrowsecurity, `${row.relname} 未开 RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} 未开 FORCE RLS`).toBe(true);
    }

    const policies = await test.database.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies WHERE policyname = 'tenant_isolation'`,
    );
    const withPolicy = new Set(policies.rows.map((row) => row.tablename));
    for (const table of ['employee', 'audit_log', 'api_token', 'number_sequence']) {
      expect(withPolicy.has(table), `${table} 缺 tenant_isolation 策略`).toBe(true);
    }
  });

  it('库存核心表（0008）：生成列由数据库维护，流水只追加（D67 / D2① / D38 / D47）', async () => {
    const tables = await test.database.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])
       ORDER BY relname`,
      [['inventory_batch', 'inventory_flow']],
    );
    expect(tables.rows.map((row) => row.relname)).toEqual(['inventory_batch', 'inventory_flow']);
    for (const row of tables.rows) {
      expect(row.relrowsecurity, `${row.relname} 未开 RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} 未开 FORCE RLS`).toBe(true);
    }

    const generated = await test.database.query<{
      column_name: string;
      is_generated: string;
    }>(
      `SELECT column_name, is_generated
       FROM information_schema.columns
       WHERE table_name = 'inventory_batch'
         AND column_name = ANY($1::text[])
       ORDER BY column_name`,
      [['available_qty', 'remaining_qty']],
    );
    expect(generated.rows).toEqual([
      { column_name: 'available_qty', is_generated: 'ALWAYS' },
      { column_name: 'remaining_qty', is_generated: 'ALWAYS' },
    ]);

    const privileges = await test.database.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT has_table_privilege('qingdan_app', 'inventory_flow', 'SELECT') AS can_select,
              has_table_privilege('qingdan_app', 'inventory_flow', 'INSERT') AS can_insert,
              has_table_privilege('qingdan_app', 'inventory_flow', 'UPDATE') AS can_update,
              has_table_privilege('qingdan_app', 'inventory_flow', 'DELETE') AS can_delete`,
    );
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
    });
  });

  it('批次必填字段（0009）：locked_unit_cost / custodian_id 均为 NOT NULL（契约第一批 §7）', async () => {
    const result = await test.database.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'inventory_batch'
         AND column_name = ANY($1::text[])
       ORDER BY column_name`,
      [['locked_unit_cost', 'custodian_id']],
    );
    expect(result.rows).toEqual([
      { column_name: 'custodian_id', is_nullable: 'NO' },
      { column_name: 'locked_unit_cost', is_nullable: 'NO' },
    ]);
  });

  it('历史迁移被改动 → checksum 不一致直接失败（防漂移）', async () => {
    const files = await loadMigrationFiles();
    const first = files[0]!;
    await test.database.query('UPDATE schema_migrations SET checksum = $2 WHERE id = $1', [
      first.id,
      'corrupted-checksum',
    ]);

    await expect(runMigrations(test.database)).rejects.toThrow(/checksum/);

    // 还原，避免影响同文件内其它测试（beforeAll 共享实例）。
    await test.database.query('UPDATE schema_migrations SET checksum = $2 WHERE id = $1', [
      first.id,
      first.checksum,
    ]);
  });
});
