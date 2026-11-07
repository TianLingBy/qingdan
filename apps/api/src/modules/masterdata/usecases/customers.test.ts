import { AppError, type Customer, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import { createCustomer, deleteCustomer, getCustomer, listCustomers, updateCustomer } from './customers.js';

/**
 * 客户用例 / 数据访问（D15 / D49 / D51 / D52① / D54② / D63）。
 *
 * 直接调用用例（路由接线是下一步），用最小 request/reply 替身喂入认证层已算好的 Principal；
 * 数据库用 PGlite + 全量迁移 + seed 演示租户。
 */

const COMPANY_2_ID = '01900000-0000-7000-8000-000000000099';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'customer', actions: ['read', 'create', 'update', 'delete'] },
];

const READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'customer', actions: ['read'] }];
const CREATE_ONLY_SCOPE: ScopeMatrix = [{ domain: 'customer', actions: ['read', 'create'] }];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

function makeRequest(input: FakeRequestInput): FastifyRequest {
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
    headers: input.headers ?? {},
    ip: '127.0.0.1',
    auditSource: 'web',
    auditReason: null,
  } as unknown as FastifyRequest;
}

function makeReply(): {
  reply: FastifyReply;
  state: { statusCode: number; headers: Record<string, string> };
} {
  const state = { statusCode: 200, headers: {} as Record<string, string> };
  const reply = {
    status(code: number) {
      state.statusCode = code;
      return reply;
    },
    header(name: string, value: string) {
      state.headers[name] = value;
      return reply;
    },
    send() {
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    actorType: 'employee',
    actorId: DEMO_IDS.ownerEmployeeId,
    tenantId: DEMO_IDS.tenantId,
    employeeId: DEMO_IDS.ownerEmployeeId,
    credentialId: 'session-test',
    companyIds: [DEMO_IDS.companyId],
    scope: FULL_SCOPE,
    source: 'web',
    credentialType: 'session',
    sessionRenewed: false,
    ...overrides,
  };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('masterdata 客户用例（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;

  function readCtx(overrides: Partial<Principal> = {}, parts: Partial<FakeRequestInput> = {}) {
    return {
      database: test.database,
      request: makeRequest({ principal: principal(overrides), ...parts }),
    };
  }

  function writeCtx(overrides: Partial<Principal> = {}, parts: Partial<FakeRequestInput> = {}) {
    const { reply, state } = makeReply();
    return {
      ctx: {
        database: test.database,
        request: makeRequest({ principal: principal(overrides), ...parts }),
        reply,
      },
      state,
    };
  }

  async function createOne(
    input: Record<string, unknown> = {},
    overrides: Partial<Principal> = {},
  ): Promise<Customer> {
    const { ctx } = writeCtx(overrides, {
      body: { companyId: DEMO_IDS.companyId, name: '测试客户', ...input },
    });
    return createCustomer(ctx);
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // 第二家公司用于跨公司隔离测试（与 products.test 同款做法）。
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY_2_ID, DEMO_IDS.tenantId],
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('新增 → 详情：可空字段保持 null，账期 0 合法，版本从 1 起，201', async () => {
    const { ctx, state } = writeCtx(
      {},
      {
        body: {
          companyId: DEMO_IDS.companyId,
          name: '鲜果商行',
          customerNo: 'C-001',
          contactName: '刘姐',
          contactPhone: '13800000000',
          creditTermDays: 0,
        },
      },
    );
    const created = await createCustomer(ctx);
    expect(state.statusCode).toBe(201);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.companyId).toBe(DEMO_IDS.companyId);
    expect(created.customerNo).toBe('C-001');
    expect(created.creditTermDays).toBe(0);
    expect(created.status).toBe('启用');
    expect(created.version).toBe(1);

    const detail = await getCustomer(readCtx({}, { params: { id: created.id } }));
    expect(detail).toEqual(created);

    // 未填账期 = 未定（null），不是 0（D63）。
    const unspecified = await createOne({ name: '未定账期客户' });
    expect(unspecified.creditTermDays).toBeNull();
    expect(unspecified.customerNo).toBeNull();
    expect(unspecified.contactName).toBeNull();
    expect(unspecified.contactPhone).toBeNull();
  });

  it('D63：负数账期被拒（create / update），0 合法', async () => {
    await expectAppError(
      createCustomer(
        writeCtx({}, {
          body: { companyId: DEMO_IDS.companyId, name: '负账期客户', creditTermDays: -1 },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const created = await createOne({ name: '账期客户', creditTermDays: 30 });
    expect(created.creditTermDays).toBe(30);

    await expectAppError(
      updateCustomer(
        writeCtx({}, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { creditTermDays: -5 },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const zero = await updateCustomer(
      writeCtx({}, {
        params: { id: created.id },
        headers: { 'if-match': '"1"' },
        body: { creditTermDays: 0 },
      }).ctx,
    );
    expect(zero.creditTermDays).toBe(0);
    expect(zero.version).toBe(2);
  });

  it('D49：keyword 匹配名称/联系人/联系电话，不按 customer_no 检索', async () => {
    await createOne({
      name: '青禾农场',
      customerNo: 'ZZZ-777',
      contactName: '陈经理',
      contactPhone: '13911112222',
    });
    await createOne({
      name: '南岸超市',
      customerNo: 'AAA-111',
      contactName: '周会计',
      contactPhone: '13733334444',
    });

    const byNo = await listCustomers(readCtx({}, { query: { keyword: 'ZZZ' } }));
    expect(byNo.items).toHaveLength(0);

    const byName = await listCustomers(readCtx({}, { query: { keyword: '青禾' } }));
    expect(byName.items.map((item) => item.name)).toEqual(['青禾农场']);

    const byContact = await listCustomers(readCtx({}, { query: { keyword: '周会计' } }));
    expect(byContact.items.map((item) => item.name)).toEqual(['南岸超市']);

    const byPhone = await listCustomers(readCtx({}, { query: { keyword: '1391111' } }));
    expect(byPhone.items.map((item) => item.name)).toEqual(['青禾农场']);

    // 带通配符的字面量不会被当成模式：`%` 只匹配真的含 `%` 的字段。
    const wildcard = await listCustomers(readCtx({}, { query: { keyword: '%' } }));
    expect(wildcard.items).toHaveLength(0);
  });

  it('状态过滤与游标分页：两页无重叠', async () => {
    for (const name of ['分页甲', '分页乙', '分页丙']) await createOne({ name });
    await createOne({ name: '分页停用', status: '停用' });

    const enabled = await listCustomers(readCtx({}, { query: { status: '启用' } }));
    expect(enabled.items.every((item) => item.status === '启用')).toBe(true);
    const disabled = await listCustomers(readCtx({}, { query: { status: '停用' } }));
    expect(disabled.items.every((item) => item.status === '停用')).toBe(true);

    const first = await listCustomers(readCtx({}, { query: { limit: 2 } }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listCustomers(
      readCtx({}, { query: { limit: 2, cursor: first.nextCursor! } }),
    );
    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.every((item) => !firstIds.has(item.id))).toBe(true);
    expect(typeof second.nextCursor === 'string' || second.nextCursor === null).toBe(true);
  });

  it('D15：跨公司不可读改删；创建到不可见公司 → 403', async () => {
    const created = await createOne({ name: '一司客户' });
    const other = {
      scope: FULL_SCOPE,
      companyIds: [COMPANY_2_ID],
    } as const;

    await expectAppError(
      getCustomer(readCtx(other, { params: { id: created.id } })),
      'NOT_FOUND',
    );
    const list = await listCustomers(readCtx(other));
    expect(list.items.some((item) => item.id === created.id)).toBe(false);

    await expectAppError(
      updateCustomer(
        writeCtx(other, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { name: '越权改名' },
        }).ctx,
      ),
      'NOT_FOUND',
    );
    await expectAppError(
      deleteCustomer(
        writeCtx(other, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'NOT_FOUND',
    );

    await expectAppError(
      createCustomer(
        writeCtx(other, {
          body: { companyId: DEMO_IDS.companyId, name: '越权创建' },
        }).ctx,
      ),
      'FORBIDDEN',
    );

    // 显式点不可见公司 → 空列表（范围过滤优先），而非越权数据。
    const explicit = await listCustomers(readCtx(other, { query: { companyId: DEMO_IDS.companyId } }));
    expect(explicit.items).toEqual([]);
  });

  it('权限：无 customer.read → 403；缺写动作 → 403', async () => {
    const created = await createOne({ name: '权限客户' });
    const noCustomerScope: ScopeMatrix = [{ domain: 'product', actions: ['read'] }];

    await expectAppError(listCustomers(readCtx({ scope: noCustomerScope })), 'FORBIDDEN');
    await expectAppError(
      getCustomer(readCtx({ scope: noCustomerScope }, { params: { id: created.id } })),
      'FORBIDDEN',
    );

    await expectAppError(
      createCustomer(
        writeCtx({ scope: READ_ONLY_SCOPE }, { body: { companyId: DEMO_IDS.companyId, name: 'x' } }).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      updateCustomer(
        writeCtx(
          { scope: CREATE_ONLY_SCOPE },
          { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { name: 'x' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      deleteCustomer(
        writeCtx(
          { scope: CREATE_ONLY_SCOPE },
          { params: { id: created.id }, headers: { 'if-match': '"1"' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );
  });

  it('乐观锁：缺 If-Match → 428；不匹配 → 409；成功后版本 +1 并回 ETag', async () => {
    const created = await createOne({ name: '并发客户' });

    await expectAppError(
      updateCustomer(writeCtx({}, { params: { id: created.id }, body: { name: '缺前置' } }).ctx),
      'PRECONDITION_REQUIRED',
    );
    await expectAppError(
      updateCustomer(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '1' }, body: { name: '弱 ETag' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
    await expectAppError(
      updateCustomer(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"9"' }, body: { name: '旧版本' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );

    const { ctx, state } = writeCtx(
      {},
      {
        params: { id: created.id },
        headers: { 'if-match': '"1"' },
        body: { name: '改名后', contactName: '新联系人' },
      },
    );
    const updated = await updateCustomer(ctx);
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('改名后');
    expect(updated.contactName).toBe('新联系人');
    expect(updated.companyId).toBe(DEMO_IDS.companyId);
    expect(state.headers.ETag).toBe('"2"');

    await expectAppError(
      updateCustomer(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { name: '再次旧版本' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
  });

  it('软删除：status 置「停用」、版本 +1，行仍在（不物理删除）', async () => {
    const created = await createOne({ name: '待停用客户' });
    const { ctx, state } = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': '"1"' } },
    );
    const deleted = await deleteCustomer(ctx);

    expect(deleted.status).toBe('停用');
    expect(deleted.version).toBe(2);
    expect(state.headers.ETag).toBe('"2"');

    const row = await test.database.query<{ status: string; version: number }>(
      'SELECT status, version FROM customer WHERE id = $1',
      [created.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ status: '停用', version: 2 });

    // 停用后仍可按 id 读取（只是不出现在单据选客户弹窗，由调用方按 status 过滤）。
    const detail = await getCustomer(readCtx({}, { params: { id: created.id } }));
    expect(detail.status).toBe('停用');

    // 用旧版本再删 → 409。
    await expectAppError(
      deleteCustomer(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
  });

  it('D52①/D54⑥：AI 直接停用 → AI_ACTION_FORBIDDEN，客户状态不变', async () => {
    const created = await createOne({ name: 'AI 停用客户' });
    const aiPrincipal = principal({
      actorType: 'ai',
      credentialId: 'api-token-test',
      credentialType: 'api_token',
      source: 'api',
    });

    await expectAppError(
      deleteCustomer(
        writeCtx(aiPrincipal, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM customer WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.status).toBe('启用');
  });

  it('D51/D54②：create/update/delete 写审计；普通列表/详情不写', async () => {
    const before = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'customer'",
      [DEMO_IDS.tenantId],
    );

    const created = await createOne({ name: '审计客户' });
    await updateCustomer(
      writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { contactName: '新联系人' } }).ctx,
    );
    await deleteCustomer(
      writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"2"' } }).ctx,
    );

    const afterWrites = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'customer'",
      [DEMO_IDS.tenantId],
    );
    expect(afterWrites.rows[0]!.count - before.rows[0]!.count).toBe(3);

    const events = await test.database.query<{
      action: string;
      object_id: string;
      result: string;
      company_id: string | null;
    }>(
      `SELECT action, object_id, result, company_id
         FROM audit_log
        WHERE tenant_id = $1 AND object_type = 'customer' AND object_id = $2
        ORDER BY occurred_at, action`,
      [DEMO_IDS.tenantId, created.id],
    );
    expect(events.rows.map((row) => row.action).sort()).toEqual([
      'customer.create',
      'customer.delete',
      'customer.update',
    ]);
    expect(events.rows.every((row) => row.result === 'success')).toBe(true);
    expect(events.rows.every((row) => row.company_id === DEMO_IDS.companyId)).toBe(true);

    // 普通读不记审计。
    await listCustomers(readCtx());
    await getCustomer(readCtx({}, { params: { id: created.id } }));

    const afterReads = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'customer'",
      [DEMO_IDS.tenantId],
    );
    expect(afterReads.rows[0]!.count).toBe(afterWrites.rows[0]!.count);
  });
});
