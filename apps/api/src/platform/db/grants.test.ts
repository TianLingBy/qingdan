import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 0031 迁移的授权口径证明（P0-04）。
 *
 * 背景：0011 / 0014 对 qingdan_app 做了全表 REVOKE UPDATE，理由是「R 单 / S 单只追加」。
 * 但单据自身的 status / version 是状态机字段，完成动作必须能推进。
 * 0031 用列级 GRANT 只放开这两列。
 *
 * 这里以真实应用角色 qingdan_app 执行语句，验证：
 *   * status / version 可写；
 *   * 金额、明细列仍不可写；
 *   * DELETE 仍被拒。
 *
 * 注意：权限检查发生在语句解析期，所以 `WHERE false` 命中 0 行也能证明授权结果。
 */

const TABLES = ['customer_return', 'supplier_return'] as const;

describe('returns 状态列授权（0031）', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.client.exec('SET ROLE qingdan_app');
  });

  afterAll(async () => {
    await db.client.exec('RESET ROLE');
    await db.database.close();
  });

  for (const table of TABLES) {
    it(`${table}: status 与 version 可更新`, async () => {
      // 不抛错即为通过；权限检查在解析期完成，命中 0 行也足以证明授权结果。
      await db.client.exec(`UPDATE ${table} SET status = '已完成', version = version + 1 WHERE false`);
      expect(true).toBe(true);
    });

    it(`${table}: 金额列不可更新`, async () => {
      await expect(db.client.exec(`UPDATE ${table} SET refund_amount = 1 WHERE false`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    it(`${table}: 备注列不可更新`, async () => {
      await expect(db.client.exec(`UPDATE ${table} SET remark = 'x' WHERE false`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    it(`${table}: 不允许 DELETE`, async () => {
      await expect(db.client.exec(`DELETE FROM ${table} WHERE false`)).rejects.toThrow(
        /permission denied/i,
      );
    });
  }
});
