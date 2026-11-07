import { AppError, type ScopeMatrix, type Supplier } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import { createSupplier, deleteSupplier, getSupplier, listSuppliers, updateSupplier } from './suppliers.js';

/**
 * 供应商用例 / 数据访问（D15 / D49 / D51 / D52① / D54②）。
 *
 * 直接调用用例（路由接线是下一步），用最小 request/reply 替身喂入认证层已算好的 Principal；
 * 数据库用 PGlite + 全量迁移 + seed 演示租户。
 */

const COMPANY_2_ID = '01900000-0000-7000-8000-000000000098';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'supplier', actions: ['read', 'create', 'update', 'delete'] },
];

const READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'supplier', actions: ['read'] }];
const CREATE_ONLY_SCOPE: ScopeMatrix = [{ domain: 'supplier', actions: ['read', 'create'] }];

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

describe('masterdata 供应商用例（PGlite + seed 演示租户）', () => {
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
  ): Promise<Supplier> {
    const { ctx } = writeCtx(overrides, {
      body: { companyId: DEMO_IDS.companyId, name: '测试供应商', ...input },
    });
    return createSupplier(ctx);
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // 第二家公司用于跨公司隔离测试（与 customers.test 同款做法）。
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

  it('新增 → 详情：可空字段保持 null，供货物料默认空数组，版本从 1 起，201', async () => {
    const { ctx, state } = writeCtx(
      {},
      {
        body: {
          companyId: DEMO_IDS.companyId,
          name: '青禾农资',
          supplierNo: 'S-001',
          contactName: '王经理',
          contactPhone: '13800000001',
          suppliedMaterials: ['化肥', '种子'],
        },
      },
    );
    const created = await createSupplier(ctx);
    expect(state.statusCode).toBe(201);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.companyId).toBe(DEMO_IDS.companyId);
    expect(created.supplierNo).toBe('S-001');
    expect(created.suppliedMaterials).toEqual(['化肥', '种子']);
    expect(created.status).toBe('启用');
    expect(created.version).toBe(1);

    const detail = await getSupplier(readCtx({}, { params: { id: created.id } }));
    expect(detail).toEqual(created);

    // 未填的字段落 null；未填供货物料 = 空数组（不是 null）。
    const minimal = await createOne({ name: '最小供应商' });
    expect(minimal.supplierNo).toBeNull();
    expect(minimal.contactName).toBeNull();
    expect(minimal.contactPhone).toBeNull();
    expect(minimal.suppliedMaterials).toEqual([]);
  });

  it('供货物料越界：21 项 / 单项 65 字被拒；20 项 / 单项 64 字可存', async () => {
    await expectAppError(
      createSupplier(
        writeCtx({}, {
          body: {
            companyId: DEMO_IDS.companyId,
            name: '物料过多供应商',
            suppliedMaterials: Array.from({ length: 21 }, (_, index) => `物料${index}`),
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      createSupplier(
        writeCtx({}, {
          body: {
            companyId: DEMO_IDS.companyId,
            name: '物料过长供应商',
            suppliedMaterials: ['x'.repeat(65)],
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const max = await createOne({
      name: '物料边界供应商',
      suppliedMaterials: Array.from({ length: 20 }, (_, index) => `物料${index}`),
    });
    expect(max.suppliedMaterials).toHaveLength(20);

    await expectAppError(
      updateSupplier(
        writeCtx({}, {
          params: { id: max.id },
          headers: { 'if-match': '"1"' },
          body: { suppliedMaterials: ['x'.repeat(65)] },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const updated = await updateSupplier(
      writeCtx({}, {
        params: { id: max.id },
        headers: { 'if-match': '"1"' },
        body: { suppliedMaterials: ['y'.repeat(64)] },
      }).ctx,
    );
    expect(updated.suppliedMaterials).toEqual(['y'.repeat(64)]);
    expect(updated.version).toBe(2);
  });

  it('D49：keyword 匹配名称/联系人/联系电话，不按 supplier_no 检索', async () => {
    await createOne({
      name: '东岸果蔬',
      supplierNo: 'SUP-ZZZ-777',
      contactName: '李经理',
      contactPhone: '13911112222',
    });
    await createOne({
      name: '西岭冷链',
      supplierNo: 'SUP-AAA-111',
      contactName: '赵会计',
      contactPhone: '13733334444',
    });

    const byNo = await listSuppliers(readCtx({}, { query: { keyword: 'SUP-ZZZ' } }));
    expect(byNo.items).toHaveLength(0);

    const byName = await listSuppliers(readCtx({}, { query: { keyword: '东岸' } }));
    expect(byName.items.map((item) => item.name)).toEqual(['东岸果蔬']);

    const byContact = await listSuppliers(readCtx({}, { query: { keyword: '赵会计' } }));
    expect(byContact.items.map((item) => item.name)).toEqual(['西岭冷链']);

    const byPhone = await listSuppliers(readCtx({}, { query: { keyword: '1391111' } }));
    expect(byPhone.items.map((item) => item.name)).toEqual(['东岸果蔬']);

    // 带通配符的字面量不会被当成模式：`%` 只匹配真的含 `%` 的字段。
    const wildcard = await listSuppliers(readCtx({}, { query: { keyword: '%' } }));
    expect(wildcard.items).toHaveLength(0);
  });

  it('状态过滤与游标分页：两页无重叠', async () => {
    for (const name of ['分页甲供应商', '分页乙供应商', '分页丙供应商']) await createOne({ name });
    await createOne({ name: '分页停用供应商', status: '停用' });

    const enabled = await listSuppliers(readCtx({}, { query: { status: '启用' } }));
    expect(enabled.items.every((item) => item.status === '启用')).toBe(true);
    const disabled = await listSuppliers(readCtx({}, { query: { status: '停用' } }));
    expect(disabled.items.every((item) => item.status === '停用')).toBe(true);

    const first = await listSuppliers(readCtx({}, { query: { limit: 2 } }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listSuppliers(
      readCtx({}, { query: { limit: 2, cursor: first.nextCursor! } }),
    );
    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.every((item) => !firstIds.has(item.id))).toBe(true);
    expect(typeof second.nextCursor === 'string' || second.nextCursor === null).toBe(true);
  });

  it('D15：跨公司不可读改删；创建到不可见公司 → 403', async () => {
    const created = await createOne({ name: '一司供应商' });
    const other = {
      scope: FULL_SCOPE,
      companyIds: [COMPANY_2_ID],
    } as const;

    await expectAppError(
      getSupplier(readCtx(other, { params: { id: created.id } })),
      'NOT_FOUND',
    );
    const list = await listSuppliers(readCtx(other));
    expect(list.items.some((item) => item.id === created.id)).toBe(false);

    await expectAppError(
      updateSupplier(
        writeCtx(other, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { name: '越权改名' },
        }).ctx,
      ),
      'NOT_FOUND',
    );
    await expectAppError(
      deleteSupplier(
        writeCtx(other, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'NOT_FOUND',
    );

    await expectAppError(
      createSupplier(
        writeCtx(other, {
          body: { companyId: DEMO_IDS.companyId, name: '越权创建' },
        }).ctx,
      ),
      'FORBIDDEN',
    );

    // 显式点不可见公司 → 空列表（范围过滤优先），而非越权数据。
    const explicit = await listSuppliers(
      readCtx(other, { query: { companyId: DEMO_IDS.companyId } }),
    );
    expect(explicit.items).toEqual([]);
  });

  it('权限：无 supplier.read → 403；缺写动作 → 403', async () => {
    const created = await createOne({ name: '权限供应商' });
    const noSupplierScope: ScopeMatrix = [{ domain: 'customer', actions: ['read'] }];

    await expectAppError(listSuppliers(readCtx({ scope: noSupplierScope })), 'FORBIDDEN');
    await expectAppError(
      getSupplier(readCtx({ scope: noSupplierScope }, { params: { id: created.id } })),
      'FORBIDDEN',
    );

    await expectAppError(
      createSupplier(
        writeCtx({ scope: READ_ONLY_SCOPE }, { body: { companyId: DEMO_IDS.companyId, name: 'x' } }).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      updateSupplier(
        writeCtx(
          { scope: CREATE_ONLY_SCOPE },
          { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { name: 'x' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      deleteSupplier(
        writeCtx(
          { scope: CREATE_ONLY_SCOPE },
          { params: { id: created.id }, headers: { 'if-match': '"1"' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );
  });

  it('乐观锁：缺 If-Match → 428；不匹配 → 409；成功后版本 +1 并回 ETag', async () => {
    const created = await createOne({ name: '并发供应商' });

    await expectAppError(
      updateSupplier(writeCtx({}, { params: { id: created.id }, body: { name: '缺前置' } }).ctx),
      'PRECONDITION_REQUIRED',
    );
    await expectAppError(
      updateSupplier(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '1' }, body: { name: '弱 ETag' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
    await expectAppError(
      updateSupplier(
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
    const updated = await updateSupplier(ctx);
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('改名后');
    expect(updated.contactName).toBe('新联系人');
    expect(updated.companyId).toBe(DEMO_IDS.companyId);
    expect(state.headers.ETag).toBe('"2"');

    await expectAppError(
      updateSupplier(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { name: '再次旧版本' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
  });

  it('软删除：status 置「停用」、版本 +1，行仍在（不物理删除）', async () => {
    const created = await createOne({ name: '待停用供应商' });
    const { ctx, state } = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': '"1"' } },
    );
    const deleted = await deleteSupplier(ctx);

    expect(deleted.status).toBe('停用');
    expect(deleted.version).toBe(2);
    expect(state.headers.ETag).toBe('"2"');

    const row = await test.database.query<{ status: string; version: number }>(
      'SELECT status, version FROM supplier WHERE id = $1',
      [created.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ status: '停用', version: 2 });

    // 停用后仍可按 id 读取（是否出现在选供应商弹窗由调用方按 status 过滤）。
    const detail = await getSupplier(readCtx({}, { params: { id: created.id } }));
    expect(detail.status).toBe('停用');

    // 用旧版本再删 → 409。
    await expectAppError(
      deleteSupplier(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
  });

  it('D52①/D54⑥：AI 直接停用 → AI_ACTION_FORBIDDEN，供应商状态不变', async () => {
    const created = await createOne({ name: 'AI 停用供应商' });
    const aiPrincipal = principal({
      actorType: 'ai',
      credentialId: 'api-token-test',
      credentialType: 'api_token',
      source: 'api',
    });

    await expectAppError(
      deleteSupplier(
        writeCtx(aiPrincipal, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM supplier WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.status).toBe('启用');
  });

  it('D51/D54②：create/update/delete 写审计；普通列表/详情不写', async () => {
    const before = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'supplier'",
      [DEMO_IDS.tenantId],
    );

    const created = await createOne({ name: '审计供应商' });
    await updateSupplier(
      writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { contactName: '新联系人' } }).ctx,
    );
    await deleteSupplier(
      writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"2"' } }).ctx,
    );

    const afterWrites = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'supplier'",
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
        WHERE tenant_id = $1 AND object_type = 'supplier' AND object_id = $2
        ORDER BY occurred_at, action`,
      [DEMO_IDS.tenantId, created.id],
    );
    expect(events.rows.map((row) => row.action).sort()).toEqual([
      'supplier.create',
      'supplier.delete',
      'supplier.update',
    ]);
    expect(events.rows.every((row) => row.result === 'success')).toBe(true);
    expect(events.rows.every((row) => row.company_id === DEMO_IDS.companyId)).toBe(true);

    // 普通读不记审计。
    await listSuppliers(readCtx());
    await getSupplier(readCtx({}, { params: { id: created.id } }));

    const afterReads = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'supplier'",
      [DEMO_IDS.tenantId],
    );
    expect(afterReads.rows[0]!.count).toBe(afterWrites.rows[0]!.count);
  });
});
