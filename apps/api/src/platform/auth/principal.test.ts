import { randomBytes } from 'node:crypto';
import { allowsScope, type ScopeMatrix } from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { testConfig } from '../config.js';
import { DEMO_IDS, seed } from '../db/seed.js';
import { resolvePrincipal } from './principal.js';
import {
  SESSION_TOUCH_INTERVAL_MS,
  createSession,
  hashSessionToken,
  revokeSession,
} from './session-store.js';

/**
 * 请求主体解析（D59②⑦⑧ / D52.1）实测：
 *   - Bearer 优先且不回退 Cookie；
 *   - API Token status / 过期 / IP 白名单；
 *   - Cookie 会话 actorType=employee、Bearer actorType=ai；
 *   - token scope 与员工权限取交集（只能收窄，不能放大）。
 */

const T0 = new Date('2026-11-04T08:00:00.000Z');
const TTL_DAYS = 7;
const OPTIONS = { sessionTtlDays: TTL_DAYS, now: T0 } as const;

interface IssueTokenInput {
  readonly employeeId?: string;
  readonly scope?: ScopeMatrix;
  readonly status?: 'active' | 'revoked' | 'expired';
  readonly expiresAt?: Date | null;
  readonly ipAllowlist?: string[] | null;
}

describe('principal（凭证解析与权限交集）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
  });

  afterAll(async () => {
    await test.database.close();
  });

  function sessionFor(employeeId: string = DEMO_IDS.salesEmployeeId) {
    return createSession(test.database, {
      tenantId: DEMO_IDS.tenantId,
      employeeId,
      ttlDays: TTL_DAYS,
      now: T0,
    });
  }

  async function issueToken(input: IssueTokenInput = {}): Promise<{ id: string; token: string }> {
    const id = uuidv7();
    const token = randomBytes(32).toString('hex');
    await test.database.query(
      `INSERT INTO api_token
         (id, tenant_id, employee_id, name, scope, token_hash, expires_at, ip_allowlist, status, created_by)
       VALUES ($1, $2, $3, 'vitest token', $4::jsonb, $5, $6, $7, $8, $3)`,
      [
        id,
        DEMO_IDS.tenantId,
        input.employeeId ?? DEMO_IDS.salesEmployeeId,
        JSON.stringify(input.scope ?? []),
        hashSessionToken(token),
        input.expiresAt ?? null,
        input.ipAllowlist ?? null,
        input.status ?? 'active',
      ],
    );
    return { id, token };
  }

  it('Bearer 优先于 Cookie：Bearer 无效 → 401，不回退 Cookie', async () => {
    const session = await sessionFor();

    await expect(
      resolvePrincipal(
        test.database,
        {
          authorization: 'Bearer not-a-real-token',
          cookie: `qingdan_session=${session.token}`,
        },
        OPTIONS,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('Bearer 有效时即使带 Cookie 也按 AI 凭证解析（actorType=ai）', async () => {
    const session = await sessionFor();
    const { id, token } = await issueToken({
      scope: [{ domain: 'sales', actions: ['read'] }],
      ipAllowlist: ['203.0.113.7'],
    });

    const principal = await resolvePrincipal(
      test.database,
      {
        authorization: `Bearer ${token}`,
        cookie: `qingdan_session=${session.token}`,
        ip: '203.0.113.7',
        client: 'cli',
      },
      OPTIONS,
    );

    expect(principal.actorType).toBe('ai');
    expect(principal.credentialType).toBe('api_token');
    expect(principal.credentialId).toBe(id);
    expect(principal.actorId).toBe(DEMO_IDS.salesEmployeeId);
    expect(principal.employeeId).toBe(DEMO_IDS.salesEmployeeId);
    expect(principal.tenantId).toBe(DEMO_IDS.tenantId);
    expect(principal.source).toBe('cli');
    expect(principal.companyIds).toEqual([DEMO_IDS.companyId]);
  });

  it('Bearer status=revoked → 401', async () => {
    const { token } = await issueToken({ status: 'revoked' });

    await expect(
      resolvePrincipal(test.database, { authorization: `Bearer ${token}` }, OPTIONS),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('Bearer 已过期 → 401', async () => {
    const { token } = await issueToken({ expiresAt: new Date(T0.getTime() - 1_000) });

    await expect(
      resolvePrincipal(test.database, { authorization: `Bearer ${token}` }, OPTIONS),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('Bearer ip_allowlist 不命中 → 401（命中才放行）', async () => {
    const { token } = await issueToken({ ipAllowlist: ['10.0.0.1'] });

    await expect(
      resolvePrincipal(
        test.database,
        { authorization: `Bearer ${token}`, ip: '203.0.113.9' },
        OPTIONS,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // 缺失 IP 也视为不命中。
    await expect(
      resolvePrincipal(test.database, { authorization: `Bearer ${token}` }, OPTIONS),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('Cookie 会话 → actorType=employee，companyIds / scope 来自员工权限', async () => {
    const session = await sessionFor(DEMO_IDS.salesEmployeeId);

    const principal = await resolvePrincipal(
      test.database,
      { cookie: `qingdan_session=${session.token}`, client: 'web' },
      OPTIONS,
    );

    expect(principal.actorType).toBe('employee');
    expect(principal.credentialType).toBe('session');
    expect(principal.credentialId).toBe(session.sessionId);
    expect(principal.actorId).toBe(DEMO_IDS.salesEmployeeId);
    expect(principal.tenantId).toBe(DEMO_IDS.tenantId);
    expect(principal.source).toBe('web');
    expect(principal.companyIds).toEqual([DEMO_IDS.companyId]);
    expect(allowsScope(principal.scope, 'sales', 'read')).toBe(true);
    expect(allowsScope(principal.scope, 'customer', 'read')).toBe(true);
  });

  it('滑动续期：实际写入时带出 sessionRenewed=true，5 分钟窗口内为 false', async () => {
    const session = await sessionFor();
    const cookie = `qingdan_session=${session.token}`;

    // 新建会话 last_seen_at 为空 → 首次解析实际写入。
    const first = await resolvePrincipal(test.database, { cookie }, OPTIONS);
    expect(first.sessionRenewed).toBe(true);

    // 窗口内不重复写。
    const inWindow = new Date(T0.getTime() + SESSION_TOUCH_INTERVAL_MS - 60_000);
    const second = await resolvePrincipal(test.database, { cookie }, { ...OPTIONS, now: inWindow });
    expect(second.sessionRenewed).toBe(false);

    // 超出窗口再次写入。
    const beyond = new Date(T0.getTime() + SESSION_TOUCH_INTERVAL_MS + 60_000);
    const third = await resolvePrincipal(test.database, { cookie }, { ...OPTIONS, now: beyond });
    expect(third.sessionRenewed).toBe(true);

    // API Token 没有会话续期语义。
    const { token } = await issueToken({ scope: [{ domain: 'sales', actions: ['read'] }] });
    const ai = await resolvePrincipal(
      test.database,
      { authorization: `Bearer ${token}` },
      OPTIONS,
    );
    expect(ai.sessionRenewed).toBe(false);
  });

  it('Cookie 会话被撤销后立即 401', async () => {
    const session = await sessionFor();
    await revokeSession(test.database, {
      tenantId: DEMO_IDS.tenantId,
      sessionId: session.sessionId,
      now: T0,
    });

    await expect(
      resolvePrincipal(
        test.database,
        { cookie: `qingdan_session=${session.token}` },
        OPTIONS,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('缺少任何凭证 → 401', async () => {
    await expect(resolvePrincipal(test.database, {}, OPTIONS)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    await expect(
      resolvePrincipal(test.database, { authorization: 'Bearer   ' }, OPTIONS),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('token scope 与员工权限取交集：更窄的 scope 收窄结果，也不能放大', async () => {
    const narrow: ScopeMatrix = [{ domain: 'sales', actions: ['read'] }];
    const narrowToken = await issueToken({ scope: narrow });
    const narrowed = await resolvePrincipal(
      test.database,
      { authorization: `Bearer ${narrowToken.token}` },
      OPTIONS,
    );

    // 员工本来有 sales.create / customer.read，token 更窄 → 全部被收窄掉。
    expect(narrowed.scope).toEqual([{ domain: 'sales', actions: ['read'] }]);
    expect(allowsScope(narrowed.scope, 'sales', 'create')).toBe(false);
    expect(allowsScope(narrowed.scope, 'customer', 'read')).toBe(false);

    // token 写了员工没有的动作（sales.approve）也不能补出来；员工有的 settlement.read 保留。
    const widerToken = await issueToken({
      scope: [
        { domain: 'sales', actions: ['read', 'approve'] },
        { domain: 'settlement', actions: ['read'] },
      ],
    });
    const intersected = await resolvePrincipal(
      test.database,
      { authorization: `Bearer ${widerToken.token}` },
      OPTIONS,
    );

    expect(allowsScope(intersected.scope, 'sales', 'read')).toBe(true);
    expect(allowsScope(intersected.scope, 'sales', 'approve')).toBe(false);
    expect(allowsScope(intersected.scope, 'settlement', 'read')).toBe(true);
    expect(allowsScope(intersected.scope, 'settlement', 'approve')).toBe(false);
  });
});
