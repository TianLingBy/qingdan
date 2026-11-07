import { randomUUID } from 'node:crypto';
import { createPgDatabase, type SqlClient } from './client.js';
import { takeDocumentNo } from '../numbering/service.js';

/**
 * L3 真 PostgreSQL 集成检查（D57③ / #103）。
 *
 * 只在真实 PostgreSQL 上跑：`QINGDAN_TEST_DB`（或 `DATABASE_URL`）指向一个**可清空**的测试库，
 * 脚本自己迁移、造数，不依赖 PGlite。CI 的 `integration (ubuntu-latest, PostgreSQL 18)` job 会调用它。
 *
 * 覆盖四件事（都是 PGlite 测不出或测不准的）：
 *   1. 并发取号不重号（单行原子自增在真并发下成立）；
 *   2. 批次行锁（`FOR UPDATE` 真的把第二个写者挡住，而不是「看起来像」）；
 *   3. RLS 跨租户不可见（`SET ROLE qingdan_app` + `app.tenant_id`，未设置时 fail-closed）；
 *   4. 生成列（`remaining_qty` / `available_qty` 由库计算，应用层写它们必须被拒绝）。
 *
 * 任何一条断言失败都以非 0 退出，并打印 `FAIL <用例>：<细节>`。
 */

const databaseUrl = process.env.QINGDAN_TEST_DB ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log('SKIP db-concurrency：未设置 QINGDAN_TEST_DB / DATABASE_URL（本机没有真 PG 时属预期）。');
  process.exit(0);
}

let failures = 0;
let passed = 0;

function ok(name: string): void {
  passed += 1;
  console.log(`PASS ${name}`);
}

function fail(name: string, detail: unknown): void {
  failures += 1;
  const message = detail instanceof Error ? `${detail.message}` : String(detail);
  console.log(`FAIL ${name}：${message}`);
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    ok(name);
  } catch (error) {
    fail(name, error);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function main(): Promise<void> {
  const { database, pool } = createPgDatabase(databaseUrl!, { max: 12 });
  try {
    // --- 造数：两张租户、各一家公司，用来验 RLS 与跨租户隔离 -----------------
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const companyA = randomUUID();
    const productA = randomUUID();

    await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO tenant (id, name, plan, status) VALUES ($1, 'L3 租户 A', '基础版', '启用'), ($2, 'L3 租户 B', '基础版', '启用')`,
        [tenantA, tenantB],
      );
      await tx.query(
        `INSERT INTO company (id, tenant_id, name, code, level, status) VALUES ($1, $2, 'L3 公司 A', '9001', 1, '启用')`,
        [companyA, tenantA],
      );
      await tx.query(
        `INSERT INTO product (id, tenant_id, company_id, name, specification, unit, status) VALUES ($1, $2, $3, 'L3 商品', '标准', '个', '启用')`,
        [productA, tenantA, companyA],
      );
    });

    // --- 1. 并发取号：20 个独立事务同时取号，必须 20 个不同的号 ---------------
    await check('并发取号不重号（20 并发）', async () => {
      const taken = await Promise.all(
        Array.from({ length: 20 }, () =>
          database.transaction((tx: SqlClient) => takeDocumentNo(tx, 'E', companyA, new Date())),
        ),
      );
      const unique = new Set(taken);
      assert(taken.length === 20, `期望取到 20 个号，实际 ${taken.length}`);
      assert(unique.size === 20, `出现重号：${taken.join(', ')}`);
      const suffixes = taken.map((no) => Number(no.slice(-4))).sort((a, b) => a - b);
      const first = suffixes[0] ?? 0;
      assert(
        suffixes.every((value, index) => value === first + index),
        `流水号不连续：${suffixes.join(',')}`,
      );
      console.log(`  取号结果（前 3 / 共 20）：${taken.slice(0, 3).join(', ')} …`);
    });

    // --- 2. 行锁：A 事务持有 FOR UPDATE 时，B 的写必须被挡住 -------------------
    await check('批次行锁（FOR UPDATE 挡住第二个写者）', async () => {
      const batchId = randomUUID();
      await database.query(
        `INSERT INTO inventory_batch (id, tenant_id, company_id, product_id, batch_no, inbound_qty)
         VALUES ($1, $2, $3, $4, 'L3-LOCK-1', 10)`,
        [batchId, tenantA, companyA, productA],
      );

      let releaseHolder: () => void = () => undefined;
      const holderReleased = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let lockTaken: () => void = () => undefined;
      const holderHasLock = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });

      const holder = database.transaction(async (tx) => {
        await tx.query(`SELECT id FROM inventory_batch WHERE id = $1 FOR UPDATE`, [batchId]);
        lockTaken();
        await holderReleased; // 一直持有行锁，直到 B 试过写
        await tx.query(`UPDATE inventory_batch SET referenced_qty = referenced_qty + 1 WHERE id = $1`, [
          batchId,
        ]);
      });

      await holderHasLock;
      let blocked = false;
      try {
        await database.transaction(async (tx) => {
          await tx.query(`SET LOCAL statement_timeout = '400ms'`);
          await tx.query(
            `UPDATE inventory_batch SET referenced_qty = referenced_qty + 1 WHERE id = $1`,
            [batchId],
          );
        });
      } catch (error) {
        blocked = sqlStateOf(error) === '57014'; // query_canceled = statement_timeout
        if (!blocked) throw new Error(`期望被锁挡住（57014），实际错误：${String(error)}`);
      }
      releaseHolder();
      await holder;
      assert(blocked, '第二个写者没有被行锁挡住：FOR UPDATE 未生效');
    });

    // --- 3. RLS：qingdan_app 只能看到 app.tenant_id 对应的租户 -----------------
    await check('RLS 跨租户不可见（qingdan_app + app.tenant_id）', async () => {
      await database.query(
        `INSERT INTO inventory_batch (id, tenant_id, company_id, product_id, batch_no, inbound_qty)
         VALUES ($1, $2, $3, $4, 'L3-RLS-1', 5)`,
        [randomUUID(), tenantA, companyA, productA],
      );

      const visibleA = await database.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE qingdan_app');
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
        const result = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM inventory_batch WHERE tenant_id = $1`,
          [tenantA],
        );
        return Number(result.rows[0]?.n ?? 0);
      });
      assert(visibleA >= 1, `租户 A 看不到自己的批次（RLS 过严）：${visibleA}`);

      const visibleB = await database.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE qingdan_app');
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
        const result = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM inventory_batch WHERE tenant_id = $1`,
          [tenantB],
        );
        return Number(result.rows[0]?.n ?? 0);
      });
      assert(visibleB === 0, `跨租户可见：租户 A 看到了租户 B 的 ${visibleB} 行`);

      const noTenant = await database.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE qingdan_app');
        const result = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM inventory_batch`);
        return Number(result.rows[0]?.n ?? 0);
      });
      assert(noTenant === 0, `未设置 app.tenant_id 时仍能看到 ${noTenant} 行（应 fail-closed）`);
    });

    // --- 4. 生成列：库算出来的量正确，应用层写入必须被拒绝 ---------------------
    await check('生成列 remaining/available 由库计算，写入被拒', async () => {
      const batchId = randomUUID();
      await database.query(
        `INSERT INTO inventory_batch
           (id, tenant_id, company_id, product_id, batch_no, inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty)
         VALUES ($1, $2, $3, $4, 'L3-GEN-1', 10, 3, 2, 1)`,
        [batchId, tenantA, companyA, productA],
      );
      const row = await database.query<{ remaining_qty: string; available_qty: string }>(
        `SELECT remaining_qty::text AS remaining_qty, available_qty::text AS available_qty
         FROM inventory_batch WHERE id = $1`,
        [batchId],
      );
      assert(row.rows[0]?.remaining_qty === '7', `remaining_qty 期望 7，实际 ${row.rows[0]?.remaining_qty}`);
      assert(row.rows[0]?.available_qty === '4', `available_qty 期望 4，实际 ${row.rows[0]?.available_qty}`);

      let rejected = false;
      try {
        await database.query(`UPDATE inventory_batch SET available_qty = 0 WHERE id = $1`, [batchId]);
      } catch (error) {
        rejected = sqlStateOf(error) === '428C9' || sqlStateOf(error) === '42601';
      }
      assert(rejected, '应用层直接写 available_qty 竟然成功了：生成列保护失效');
    });
  } finally {
    await pool.end().catch(() => undefined);
    await database.close().catch(() => undefined);
  }

  console.log(`\n结果：${passed} passed, ${failures} failed`);
  if (failures > 0) {
    console.log('FAIL db-concurrency：存在未通过的断言（见上）。');
    process.exit(1);
  }
  console.log('OK db-concurrency：真 PostgreSQL 四项检查全部通过。');
}

main().catch((error: unknown) => {
  console.error('FAIL db-concurrency：脚本异常终止', error);
  process.exit(1);
});
