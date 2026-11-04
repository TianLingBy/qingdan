import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { recordAudit } from '../../platform/audit/writer.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * M1-D 操作日志查询（D51 / D54② / D59①）：
 *   - 只读 audit_log_view，租户隔离（造两个租户的日志验证）；
 *   - 游标分页 + occurred_at DESC；
 *   - 查询本身每次写一条敏感读审计，且不递归。
 */

const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';
const OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000000f1';

interface AuditLogItem {
  id: string;
  tenantId: string | null;
  action: string;
  objectType: string;
  result: string;
  time: string;
}

interface AuditRow {
  action: string;
  object_type: string;
  result: string;
  actor_id: string;
  tenant_id: string | null;
}

async function login(app: FastifyInstance, phone: string, requestId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

describe('platform 操作日志查询（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    app = buildApp({
      config: testConfig(),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-audit-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-audit-login-sales');
    // 清掉登录审计，后面的分页断言只针对本用例造的数据。
    await test.database.exec('TRUNCATE audit_outbox, audit_log');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  async function insertAudit(
    tenantId: string,
    action: string,
    occurredAt: string,
  ): Promise<void> {
    await recordAudit(test.database, {
      tenantId,
      actorType: 'employee',
      actorId: DEMO_IDS.ownerEmployeeId,
      source: 'api',
      action,
      objectType: 'test_object',
      objectId: null,
      result: 'success',
      requestId: `seed-${action}`,
      occurredAt: new Date(occurredAt),
    });
  }

  it('无 audit.read 权限 → 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      headers: { cookie: salesCookie, 'x-request-id': 'req-audit-forbidden' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });

    // 敏感读被拒也要留痕（统一失败钩子），成功路径不重复记。
    const failed = await test.database.query<AuditRow>(
      `SELECT action, object_type, result, actor_id, tenant_id
         FROM audit_log WHERE request_id = $1`,
      ['req-audit-forbidden'],
    );
    expect(failed.rows).toEqual([
      {
        action: 'platform.audit.read',
        object_type: 'audit_log',
        result: 'fail',
        actor_id: DEMO_IDS.salesEmployeeId,
        tenant_id: DEMO_IDS.tenantId,
      },
    ]);

    // 清掉这条失败审计，后面的分页断言只针对本用例造的数据（与 beforeAll 口径一致）。
    await test.database.exec('TRUNCATE audit_outbox, audit_log');
  });

  it('只返回本租户日志；游标分页生效；每次查询写一条敏感读审计', async () => {
    await insertAudit(DEMO_IDS.tenantId, 'test.audit.first', '2020-01-01T00:00:00.000Z');
    await insertAudit(DEMO_IDS.tenantId, 'test.audit.second', '2020-01-02T00:00:00.000Z');
    await insertAudit(DEMO_IDS.tenantId, 'test.audit.third', '2020-01-03T00:00:00.000Z');
    // 其它租户的日志更新时间最新：若隔离失效，它一定出现在第一页第一行。
    await insertAudit(OTHER_TENANT_ID, 'test.audit.other-tenant', '2020-01-04T00:00:00.000Z');

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?limit=2',
      headers: { cookie: ownerCookie, 'x-request-id': 'req-audit-page1' },
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json() as { items: AuditLogItem[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(2);
    expect(page1.items.map((item) => item.action)).toEqual([
      'test.audit.third',
      'test.audit.second',
    ]);
    expect(page1.items.every((item) => item.tenantId === DEMO_IDS.tenantId)).toBe(true);
    expect(page1.items.some((item) => item.tenantId === OTHER_TENANT_ID)).toBe(false);
    expect(page1.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-logs?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      headers: { cookie: ownerCookie, 'x-request-id': 'req-audit-page2' },
    });
    expect(second.statusCode).toBe(200);
    const page2 = second.json() as { items: AuditLogItem[]; nextCursor: string | null };
    expect(page2.items.map((item) => item.action)).toEqual(['test.audit.first']);
    expect(page2.items.every((item) => item.tenantId === DEMO_IDS.tenantId)).toBe(true);
    expect(page2.nextCursor).toBeNull();

    // 两个分页请求各产生、且只产生一条敏感读审计（写日志不触发递归查询）。
    const audits = await test.database.query<AuditRow>(
      `SELECT action, object_type, result, actor_id, tenant_id
         FROM audit_log
        WHERE request_id IN ($1, $2)
        ORDER BY request_id`,
      ['req-audit-page1', 'req-audit-page2'],
    );
    expect(audits.rows).toEqual([
      {
        action: 'platform.audit.read',
        object_type: 'audit_log',
        result: 'success',
        actor_id: DEMO_IDS.ownerEmployeeId,
        tenant_id: DEMO_IDS.tenantId,
      },
      {
        action: 'platform.audit.read',
        object_type: 'audit_log',
        result: 'success',
        actor_id: DEMO_IDS.ownerEmployeeId,
        tenant_id: DEMO_IDS.tenantId,
      },
    ]);
  });
});
