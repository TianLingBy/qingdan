import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { appendAudit, flushAuditOutbox, recordAuditFailure, withAudit, type AuditEvent } from './writer.js';

function baseEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    tenantId: null,
    actorType: 'employee',
    actorId: '00000000-0000-7000-8000-000000000001',
    source: 'web',
    action: 'sales.create',
    objectType: 'sales_order',
    objectId: null,
    result: 'success',
    requestId: 'req-audit-1',
    ...overrides,
  };
}

describe('审计追加器（outbox → audit_log）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await test.database.exec('CREATE TABLE biz_probe (id text PRIMARY KEY)');
  });

  afterAll(async () => {
    await test.database.close();
  });

  beforeEach(async () => {
    await test.database.exec('TRUNCATE biz_probe, audit_outbox, audit_log');
  });

  it('事务内写 outbox，提交后搬进 audit_log，outbox 清空', async () => {
    const value = await withAudit(test.database, baseEvent(), async (tx) => {
      await tx.query(`INSERT INTO biz_probe (id) VALUES ('p1')`);
      return 'ok';
    });

    expect(value).toBe('ok');
    const outbox = await test.database.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_outbox');
    expect(outbox.rows[0]!.n).toBe(0);

    const logs = await test.database.query<{ action: string; result: string; source: string }>(
      'SELECT action, result, source FROM audit_log',
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toEqual({ action: 'sales.create', result: 'success', source: 'web' });

    const probe = await test.database.query<{ n: number }>('SELECT count(*)::int AS n FROM biz_probe');
    expect(probe.rows[0]!.n).toBe(1);
  });

  it('审计写入失败 → 业务事务回滚、异常上抛（D55⑤，绝不静默吞掉）', async () => {
    await expect(
      withAudit(test.database, baseEvent({ companyId: 'not-a-uuid' }), async (tx) => {
        await tx.query(`INSERT INTO biz_probe (id) VALUES ('p2')`);
      }),
    ).rejects.toThrow();

    // 业务写入必须被回滚，且没有留下半截审计。
    const probe = await test.database.query<{ n: number }>('SELECT count(*)::int AS n FROM biz_probe');
    expect(probe.rows[0]!.n).toBe(0);
    const outbox = await test.database.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_outbox');
    expect(outbox.rows[0]!.n).toBe(0);
    const logs = await test.database.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log');
    expect(logs.rows[0]!.n).toBe(0);
  });

  it('失败路径直接写 result=fail（无业务事务）', async () => {
    await recordAuditFailure(
      test.database,
      baseEvent({ result: 'success', errorCode: 'VALIDATION_FAILED', reason: '参数缺失' }),
    );

    const logs = await test.database.query<{ result: string; error_code: string; reason: string }>(
      'SELECT result, error_code, reason FROM audit_log',
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toEqual({
      result: 'fail',
      error_code: 'VALIDATION_FAILED',
      reason: '参数缺失',
    });
  });

  it('重复搬 outbox 幂等（不会产生第二条日志）', async () => {
    let auditId = '';
    await test.database.transaction(async (tx) => {
      auditId = await appendAudit(tx, baseEvent({ id: '01900000-0000-7000-8000-0000000000e1' }));
    });
    await flushAuditOutbox(test.database, auditId, null);
    await flushAuditOutbox(test.database, auditId, null);

    const logs = await test.database.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log');
    expect(logs.rows[0]!.n).toBe(1);
    const outbox = await test.database.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_outbox');
    expect(outbox.rows[0]!.n).toBe(0);
  });

  it('搬运时租户不匹配 → 抛错，不再静默成功（D55⑤）', async () => {
    const auditId = await test.database.transaction((tx) =>
      appendAudit(tx, baseEvent({ id: '01900000-0000-7000-8000-0000000000e2' })),
    );
    await expect(
      flushAuditOutbox(test.database, auditId, '01900000-0000-7000-8000-0000000000ff'),
    ).rejects.toThrow(/审计搬运失败/);
  });
});