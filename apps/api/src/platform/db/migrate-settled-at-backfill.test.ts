import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_IDS, seed } from '../db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { MIGRATIONS_DIR, runMigrations } from './migrate.js';

/**
 * 0026_settlement_orders_settled_at.sql 的历史回填与 fail-closed 行为。
 *
 * 两个场景都在「只剩 0026 还没跑」的库上验证：
 *   ① 有 settlement.order.confirm 成功审计 → settled_at 取该审计的 occurred_at（不是 updated_at）；
 *   ② 没有审计证据 → 迁移直接失败，不拿 updated_at 冒充，并给出人工核对提示。
 *
 * 做法：先把 0001-0025 拷到临时目录跑一遍，插入历史数据，再把 0026 加进去跑第二次。
 */

const LATEST = '0026_settlement_orders_settled_at.sql';
const SETTLEMENT_ID = '01900000-0000-7000-8000-00000000a601';
const AUDIT_ID = '01900000-0000-7000-8000-00000000a602';
const AUDIT_TIME = '2026-03-10T02:00:00Z';
/** 与确认时间故意不同的 updated_at：回填若误用 updated_at 就会被这条断言抓住。 */
const UPDATED_AT = '2026-07-01T00:00:00Z';

let test: TestDatabase;
let pre2345Dir: string;
let with0026Dir: string;

async function copyMigrations(target: string, includeLatest: boolean): Promise<void> {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of entries) {
    if (!includeLatest && name === LATEST) continue;
    await copyFile(path.join(MIGRATIONS_DIR, name), path.join(target, name));
  }
}

async function insertSettledOrder(): Promise<void> {
  await test.database.query(
    `INSERT INTO settlement_order
       (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
        status, total_sale_amount, total_cost_amount, gross_profit, gross_margin_rate,
        related_loss_amount, related_loss_amount_snapshot, net_profit,
        commission_rate_snapshot, commission_amount, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, 'C-BACKFILL-1', 'E', $1::uuid,
             '已结算', '1000', '700', '300', '0.3', '50', '50', '250', '0', '0',
             $4::timestamptz)`,
    [SETTLEMENT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, UPDATED_AT],
  );
}

async function insertConfirmAudit(): Promise<void> {
  await test.database.query(
    `INSERT INTO audit_log
       (id, occurred_at, tenant_id, company_id, actor_type, actor_id, source,
        action, object_type, object_id, result, request_id)
     VALUES ($1::uuid, $2::timestamptz, $3, $4::uuid, 'employee', $5, 'web',
             'settlement.order.confirm', 'settlement_order', $6, 'success', 'req-backfill')`,
    [AUDIT_ID, AUDIT_TIME, DEMO_IDS.tenantId, DEMO_IDS.companyId, DEMO_IDS.ownerEmployeeId, SETTLEMENT_ID],
  );
}

beforeEach(async () => {
  test = await createTestDatabase({ migrate: false });
  pre2345Dir = await mkdtemp(path.join(tmpdir(), 'qingdan-mig-pre-'));
  with0026Dir = await mkdtemp(path.join(tmpdir(), 'qingdan-mig-post-'));
  await copyMigrations(pre2345Dir, false);
  await copyMigrations(with0026Dir, true);
  await runMigrations(test.database, { dir: pre2345Dir });
  await seed(test.database);
});

afterEach(async () => {
  await rm(pre2345Dir, { recursive: true, force: true });
  await rm(with0026Dir, { recursive: true, force: true });
  await test.database.close();
});

describe('0026 settled_at 迁移', () => {
  it('回填用确认审计的 occurred_at，不用被触发器刷过的 updated_at', async () => {
    await insertSettledOrder();
    await insertConfirmAudit();

    const report = await runMigrations(test.database, { dir: with0026Dir });
    expect(report.applied).toEqual([LATEST]);

    const row = await test.database.query<{ settled_at: string | Date; updated_at: string | Date }>(
      `SELECT settled_at, updated_at FROM settlement_order WHERE id = $1::uuid`,
      [SETTLEMENT_ID],
    );
    // 回填值来自审计时刻，与插入时写死的 updated_at（7 月）不同 → 证明没拿 updated_at 顶替。
    expect(new Date(row.rows[0]!.settled_at).toISOString()).toBe(new Date(AUDIT_TIME).toISOString());
    expect(new Date(row.rows[0]!.settled_at).toISOString()).not.toBe(
      new Date(UPDATED_AT).toISOString(),
    );
    // 顺带钉住本次迁移要解决的那条行为：回填 UPDATE 也会触发 touch_updated_at，
    // 所以 updated_at 被刷成了「现在」——这正是它不能用来推断结算时间的原因。
    expect(new Date(row.rows[0]!.updated_at).getTime()).toBeGreaterThan(
      new Date(UPDATED_AT).getTime(),
    );
  });

  it('没有审计证据的「已结算」行 → 迁移失败并提示人工核对', async () => {
    await insertSettledOrder();

    await expect(runMigrations(test.database, { dir: with0026Dir })).rejects.toThrow(
      /settled_at 回填失败/,
    );

    // 失败是整文件回滚：列都不该留下，库回到 0025 的样子。
    const column = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
        WHERE table_name = 'settlement_order' AND column_name = 'settled_at'`,
    );
    expect(column.rows[0]!.count).toBe('0');
  });
});
