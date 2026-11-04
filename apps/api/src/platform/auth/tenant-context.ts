import type { Database, SqlClient } from '../db/client.js';

/**
 * 在**同一连接**上设置 `app.tenant_id` 后执行回调（D55① RLS 兜底）。
 *
 * 用事务包住：`set_config(..., true)` 是事务局部设置，事务结束自动清空，
 * 避免连接池里的连接把租户上下文带给下一个请求。
 */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return fn(tx);
  });
}
