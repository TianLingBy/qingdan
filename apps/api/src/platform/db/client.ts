import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

/**
 * 最小数据库抽象：生产走 `pg` 连接池 + drizzle；测试走 PGlite。
 *
 * 只暴露骨架真正用到的三件事：单语句查询、多语句脚本执行、事务。
 * 需要更多能力（如 COPY / LISTEN）时再扩展接口，不把驱动类型泄漏到业务模块。
 */

export interface QueryResultLike<T> {
  rows: T[];
}

export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<T>>;
  /** 允许一次执行多条语句（迁移脚本用）。 */
  exec(sql: string): Promise<void>;
}

export interface Database extends SqlClient {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function toRows<T>(rows: unknown): T[] {
  return rows as T[];
}

/** pg 连接池实现；`drizzle` 客户端与同一个 pool 绑定。 */
class PgDatabase implements Database {
  constructor(private readonly pool: Pool) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<T>> {
    const result = await this.pool.query(sql, params as unknown[] | undefined);
    return { rows: toRows<T>(result.rows) };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(pgClientSql(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function pgClientSql(client: PoolClient): SqlClient {
  return {
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<QueryResultLike<T>> {
      const result = await client.query(sql, params as unknown[] | undefined);
      return { rows: toRows<T>(result.rows) };
    },
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
  };
}

export interface PgDatabaseBundle {
  readonly database: Database;
  readonly pool: Pool;
  readonly orm: NodePgDatabase;
}

export function createPgDatabase(databaseUrl: string, options: { max?: number } = {}): PgDatabaseBundle {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    // 连接不上就快速失败：骨架阶段宁可启动失败，也不要挂半死。
    connectionTimeoutMillis: 10_000,
  });
  // 池里的 error 事件必须有人接，否则会以未捕获异常结束进程。
  pool.on('error', (error) => {
    // 交给上层日志：此处只保证不会因缺监听器崩进程。
    console.error('[db] 连接池空闲连接出错', error);
  });
  return {
    database: new PgDatabase(pool),
    pool,
    orm: drizzle(pool),
  };
}
