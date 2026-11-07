import { PGlite } from '@electric-sql/pglite';
import type { Database, QueryResultLike, SqlClient } from '../platform/db/client.js';
import { runMigrations } from '../platform/db/migrate.js';

/**
 * 测试专用：PGlite（内存 PG 18）上的 `Database` 适配器。
 *
 * 每个测试新建实例 —— PGlite 的 schema 不跨实例共享，迁移里的 CREATE ROLE / RLS 可以放心执行。
 * 这个文件随 `tsc` 一起编译进 dist，但生产入口不会 import 它。
 */

class PgliteDatabase implements Database {
  constructor(private readonly client: PGlite) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<T>> {
    const result = await this.client.query<T>(sql, params ? [...params] : undefined);
    return { rows: result.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) =>
      fn({
        async query<R = Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ): Promise<QueryResultLike<R>> {
          const result = await tx.query<R>(sql, params ? [...params] : undefined);
          return { rows: result.rows };
        },
        async exec(sql: string): Promise<void> {
          await tx.exec(sql);
        },
      }),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export interface TestDatabase {
  readonly database: Database;
  /** 原始 PGlite 句柄，供需要 `SET ROLE` 等底层能力时使用。 */
  readonly client: PGlite;
}

/**
 * 建一个全新的内存库并跑完全部迁移。
 */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const client = new PGlite();
  const database = new PgliteDatabase(client);
  if (options.migrate !== false) {
    await runMigrations(database);
  }
  return { database, client };
}
