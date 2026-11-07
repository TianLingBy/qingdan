import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { DEMO_IDS, seed } from '../db/seed.js';
import {
  SESSION_TOUCH_INTERVAL_MS,
  createSession,
  hashSessionToken,
  resolveSession,
  revokeSession,
  touchSession,
} from './session-store.js';

/**
 * 会话存储（D59⑦）实测：
 *   - 令牌只在创建时返回一次，库里只存 sha256；
 *   - 解析/过期/撤销语义；
 *   - 滑动续期节流（5 分钟）与 expires_at 推进。
 */

const TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-04T08:00:00.000Z');

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

describe('session-store（令牌哈希 / 解析 / 撤销 / 滑动续期）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
  });

  afterAll(async () => {
    await test.database.close();
  });

  function create(now: Date = T0) {
    return createSession(test.database, {
      tenantId: DEMO_IDS.tenantId,
      employeeId: DEMO_IDS.ownerEmployeeId,
      ttlDays: TTL_DAYS,
      ip: '203.0.113.7',
      userAgent: 'vitest',
      now,
    });
  }

  it('createSession 生成 64 位 hex 令牌，库里只存 sha256（无明文）', async () => {
    const created = await create();

    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    expect(created.token).not.toBe(hashSessionToken(created.token));

    const row = await test.database.query<{ token_hash: string }>(
      'SELECT token_hash FROM session WHERE id = $1',
      [created.sessionId],
    );
    const storedHash = row.rows[0]!.token_hash;
    expect(storedHash).toBe(createHash('sha256').update(created.token, 'utf8').digest('hex'));
    expect(storedHash).not.toBe(created.token);

    // 整行序列化后也不应出现明文令牌（防“顺手多存一列”）。
    const raw = await test.database.query<{ row: string }>(
      'SELECT row_to_json(s)::text AS row FROM session s WHERE id = $1',
      [created.sessionId],
    );
    expect(raw.rows[0]!.row).not.toContain(created.token);
  });

  it('resolveSession 命中：返回租户 / 员工 / 到期时间', async () => {
    const created = await create();
    const resolved = await resolveSession(test.database, created.token, {
      now: new Date(T0.getTime() + 60_000),
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(created.sessionId);
    expect(resolved!.tenantId).toBe(DEMO_IDS.tenantId);
    expect(resolved!.employeeId).toBe(DEMO_IDS.ownerEmployeeId);
    expect(resolved!.revokedAt).toBeNull();
    expect(resolved!.expiresAt.getTime()).toBe(T0.getTime() + TTL_DAYS * DAY_MS);
    expect(created.expiresAt.getTime()).toBe(T0.getTime() + TTL_DAYS * DAY_MS);
  });

  it('resolveSession 未知令牌 → null', async () => {
    const resolved = await resolveSession(test.database, 'f'.repeat(64), { now: T0 });
    expect(resolved).toBeNull();
  });

  it('resolveSession 过期 → null（边界：到期时刻即失效）', async () => {
    const created = await create();
    const expiresAt = T0.getTime() + TTL_DAYS * DAY_MS;

    const stillValid = await resolveSession(test.database, created.token, {
      now: new Date(expiresAt - 1),
    });
    expect(stillValid).not.toBeNull();

    const expired = await resolveSession(test.database, created.token, {
      now: new Date(expiresAt),
    });
    expect(expired).toBeNull();
  });

  it('revokeSession 后立即失效（再次撤销返回 false）', async () => {
    const created = await create();
    const now = new Date(T0.getTime() + 1_000);

    expect(
      await revokeSession(test.database, {
        tenantId: DEMO_IDS.tenantId,
        sessionId: created.sessionId,
        now,
      }),
    ).toBe(true);

    // 即使“当前时间”早于过期时刻，撤销也必须立即生效。
    expect(
      await resolveSession(test.database, created.token, {
        now: new Date(T0.getTime() + 2_000),
      }),
    ).toBeNull();

    expect(
      await revokeSession(test.database, {
        tenantId: DEMO_IDS.tenantId,
        sessionId: created.sessionId,
        now,
      }),
    ).toBe(false);

    const row = await test.database.query<{ revoked_at: Date | string | null }>(
      'SELECT revoked_at FROM session WHERE id = $1',
      [created.sessionId],
    );
    expect(toDate(row.rows[0]!.revoked_at!)).toEqual(now);
  });

  it('touchSession 5 分钟内不重复写 last_seen_at，超过 5 分钟才写并推进 expires_at', async () => {
    const created = await create();
    const base = { tenantId: DEMO_IDS.tenantId, sessionId: created.sessionId, ttlDays: TTL_DAYS };

    // 首次（last_seen_at IS NULL）写入。
    expect(await touchSession(test.database, { ...base, now: T0 })).toBe(true);

    // 窗口内（+4 分钟）不写。
    const inWindow = new Date(T0.getTime() + SESSION_TOUCH_INTERVAL_MS - 60_000);
    expect(await touchSession(test.database, { ...base, now: inWindow })).toBe(false);

    const first = await test.database.query<{
      last_seen_at: Date | string;
      expires_at: Date | string;
    }>('SELECT last_seen_at, expires_at FROM session WHERE id = $1', [created.sessionId]);
    expect(toDate(first.rows[0]!.last_seen_at).getTime()).toBe(T0.getTime());
    expect(toDate(first.rows[0]!.expires_at).getTime()).toBe(T0.getTime() + TTL_DAYS * DAY_MS);

    // 超过窗口（+6 分钟）写入，并把 expires_at 推到 now + ttl。
    const beyond = new Date(T0.getTime() + SESSION_TOUCH_INTERVAL_MS + 60_000);
    expect(await touchSession(test.database, { ...base, now: beyond })).toBe(true);

    const second = await test.database.query<{
      last_seen_at: Date | string;
      expires_at: Date | string;
    }>('SELECT last_seen_at, expires_at FROM session WHERE id = $1', [created.sessionId]);
    expect(toDate(second.rows[0]!.last_seen_at).getTime()).toBe(beyond.getTime());
    expect(toDate(second.rows[0]!.expires_at).getTime()).toBe(
      beyond.getTime() + TTL_DAYS * DAY_MS,
    );
  });

  it('已撤销的会话不再续期', async () => {
    const created = await create();
    const base = { tenantId: DEMO_IDS.tenantId, sessionId: created.sessionId, ttlDays: TTL_DAYS };

    await revokeSession(test.database, {
      tenantId: DEMO_IDS.tenantId,
      sessionId: created.sessionId,
      now: T0,
    });

    expect(
      await touchSession(test.database, { ...base, now: new Date(T0.getTime() + 6 * 60_000) }),
    ).toBe(false);
  });
});
