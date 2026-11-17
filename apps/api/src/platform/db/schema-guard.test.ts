import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { testConfig } from '../config.js';
import { assertSchemaReady, REQUIRED_MIGRATIONS, SchemaOutOfDateError } from './schema-guard.js';

/**
 * 启动期结构守卫：代码依赖新列时，库落后必须**启动失败**，
 * 而不是让用户在业务路径上撞 500。
 */

describe('schema-guard 启动期结构检查', () => {
  const opened: TestDatabase[] = [];

  async function open(options?: { migrate?: boolean }): Promise<TestDatabase> {
    const test = await createTestDatabase(options);
    opened.push(test);
    return test;
  }

  afterAll(async () => {
    for (const test of opened) await test.database.close();
  });

  it('迁移齐全时通过', async () => {
    const test = await open();
    await expect(assertSchemaReady(test.database)).resolves.toBeUndefined();
  });

  it('缺 0026 时拒绝，并把缺失的迁移名写进提示', async () => {
    const test = await open();
    await test.database.query(`DELETE FROM schema_migrations WHERE id = $1`, [
      '0026_settlement_orders_settled_at.sql',
    ]);
    await expect(assertSchemaReady(test.database)).rejects.toThrow(SchemaOutOfDateError);
    await expect(assertSchemaReady(test.database)).rejects.toThrow(
      /缺少迁移 0026_settlement_orders_settled_at\.sql/,
    );
    expect(REQUIRED_MIGRATIONS).toContain('0026_settlement_orders_settled_at.sql');
  });

  it('库完全没跑过迁移时给出可执行的提示', async () => {
    const test = await open({ migrate: false });
    await expect(assertSchemaReady(test.database)).rejects.toThrow(/数据库还没有跑过迁移/);
    await expect(assertSchemaReady(test.database)).rejects.toThrow(/pnpm -C apps\/api migrate/);
  });

  it('buildApp 在有库时把结构落后变成启动失败（onReady）', async () => {
    const test = await open();
    await test.database.query(`DELETE FROM schema_migrations WHERE id = $1`, [
      '0026_settlement_orders_settled_at.sql',
    ]);
    const app = buildApp({ config: testConfig(), database: test.database });
    await expect(app.ready()).rejects.toThrow(SchemaOutOfDateError);
  });
});
