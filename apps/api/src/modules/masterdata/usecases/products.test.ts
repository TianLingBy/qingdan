import { AppError, type Product, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import { createProduct, deleteProduct, getProduct, listProducts, updateProduct } from './products.js';

/**
 * 商品用例 / 数据访问（D15 / D27 / D49 / D51 / D52① / D54）。
 *
 * 直接调用用例（路由接线是下一步），用最小 request/reply 替身喂入认证层已算好的 Principal；
 * 数据库用 PGlite + 全量迁移 + seed 演示租户。
 */

const COMPANY_2_ID = '01900000-0000-7000-8000-000000000099';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'product', actions: ['read', 'create', 'update', 'delete', 'view_price'] },
];

const READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'product', actions: ['read'] }];
const WRITE_NO_PRICE_SCOPE: ScopeMatrix = [
  { domain: 'product', actions: ['read', 'create', 'update'] },
];

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

describe('masterdata 商品用例（PGlite + seed 演示租户）', () => {
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
  ): Promise<Product> {
    const { ctx } = writeCtx(overrides, {
      body: { companyId: DEMO_IDS.companyId, name: '测试商品', unit: '件', ...input },
    });
    return createProduct(ctx);
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // 第二家公司用于跨公司隔离测试（与 employees.test 同款做法）。
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

  it('新增 → 详情：金额保持 decimal 字符串，版本从 1 起，201', async () => {
    const { ctx, state } = writeCtx(
      {},
      {
        body: {
          companyId: DEMO_IDS.companyId,
          name: '红富士苹果',
          unit: '件',
          productNo: 'APPLE-001',
          aliases: ['苹果'],
          defaultSalePrice: '12.50',
        },
      },
    );
    const created = await createProduct(ctx);
    expect(state.statusCode).toBe(201);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.companyId).toBe(DEMO_IDS.companyId);
    expect(created.status).toBe('启用');
    expect(created.version).toBe(1);
    expect(typeof created.defaultSalePrice).toBe('string');
    expect(Number(created.defaultSalePrice)).toBe(12.5);

    const detail = await getProduct(readCtx({}, { params: { id: created.id } }));
    expect(detail).toEqual(created);
  });

  it('D49：keyword 只匹配名称/别名，不按 product_no 检索', async () => {
    await createOne({ name: '香蕉', productNo: 'BANANA-001', aliases: ['黄色'] });
    await createOne({ name: '翠玉梨', productNo: 'PEAR-001', aliases: ['梨子'] });

    const byNo = await listProducts(readCtx({}, { query: { keyword: 'BANANA' } }));
    expect(byNo.items).toHaveLength(0);

    const byName = await listProducts(readCtx({}, { query: { keyword: '翠玉' } }));
    expect(byName.items.map((item) => item.name)).toEqual(['翠玉梨']);

    const byAlias = await listProducts(readCtx({}, { query: { keyword: '梨子' } }));
    expect(byAlias.items.map((item) => item.name)).toEqual(['翠玉梨']);

    // 带通配符的字面量不会被当成模式：`%` 只匹配真的含 `%` 的字段。
    const wildcard = await listProducts(readCtx({}, { query: { keyword: '%' } }));
    expect(wildcard.items).toHaveLength(0);
  });

  it('状态过滤与游标分页：两页无重叠', async () => {
    for (const name of ['分页甲', '分页乙', '分页丙']) await createOne({ name });
    await createOne({ name: '分页停用', status: '停用' });

    const enabled = await listProducts(readCtx({}, { query: { status: '启用' } }));
    expect(enabled.items.every((item) => item.status === '启用')).toBe(true);
    const disabled = await listProducts(readCtx({}, { query: { status: '停用' } }));
    expect(disabled.items.every((item) => item.status === '停用')).toBe(true);

    const first = await listProducts(readCtx({}, { query: { limit: 2 } }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listProducts(
      readCtx({}, { query: { limit: 2, cursor: first.nextCursor! } }),
    );
    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.every((item) => !firstIds.has(item.id))).toBe(true);
    expect(typeof second.nextCursor === 'string' || second.nextCursor === null).toBe(true);
  });

  it('D27：无 view_price → 列表/详情 defaultSalePrice 为 null；写价格需看价权限', async () => {
    const created = await createOne({ name: '看价商品', defaultSalePrice: '9.90' });

    const detail = await getProduct(
      readCtx({ scope: READ_ONLY_SCOPE }, { params: { id: created.id } }),
    );
    expect(detail).toHaveProperty('defaultSalePrice');
    expect(detail.defaultSalePrice).toBeNull();

    const list = await listProducts(readCtx({ scope: READ_ONLY_SCOPE }));
    const masked = list.items.find((item) => item.id === created.id)!;
    expect(masked.defaultSalePrice).toBeNull();

    // 老板（含 view_price）仍能看到原值。
    const ownerView = await getProduct(readCtx({}, { params: { id: created.id } }));
    expect(Number(ownerView.defaultSalePrice)).toBe(9.9);

    // 有写权限但无看价权限：创建/修改金额直接 403，不静默丢弃。
    await expectAppError(
      createProduct(
        writeCtx({ scope: WRITE_NO_PRICE_SCOPE }, {
          body: { companyId: DEMO_IDS.companyId, name: '越价创建', unit: '件', defaultSalePrice: '1.00' },
        }).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      updateProduct(
        writeCtx({ scope: WRITE_NO_PRICE_SCOPE }, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { defaultSalePrice: '8.88' },
        }).ctx,
      ),
      'FORBIDDEN',
    );
  });

  it('D15：跨公司不可读改删；创建到不可见公司 → 403', async () => {
    const created = await createOne({ name: '一司商品' });
    const other = {
      scope: FULL_SCOPE,
      companyIds: [COMPANY_2_ID],
    } as const;

    await expectAppError(
      getProduct(readCtx(other, { params: { id: created.id } })),
      'NOT_FOUND',
    );
    const list = await listProducts(readCtx(other));
    expect(list.items.some((item) => item.id === created.id)).toBe(false);

    await expectAppError(
      updateProduct(
        writeCtx(other, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { name: '越权改名' },
        }).ctx,
      ),
      'NOT_FOUND',
    );
    await expectAppError(
      deleteProduct(
        writeCtx(other, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'NOT_FOUND',
    );

    await expectAppError(
      createProduct(
        writeCtx(other, {
          body: { companyId: DEMO_IDS.companyId, name: '越权创建', unit: '件' },
        }).ctx,
      ),
      'FORBIDDEN',
    );

    // 显式点不可见公司 → 空列表（范围过滤优先），而非越权数据。
    const explicit = await listProducts(readCtx(other, { query: { companyId: DEMO_IDS.companyId } }));
    expect(explicit.items).toEqual([]);
  });

  it('权限：无 product.read → 403；无写动作 → 403', async () => {
    const created = await createOne({ name: '权限商品' });
    const noProductScope: ScopeMatrix = [{ domain: 'customer', actions: ['read'] }];

    await expectAppError(listProducts(readCtx({ scope: noProductScope })), 'FORBIDDEN');
    await expectAppError(
      getProduct(readCtx({ scope: noProductScope }, { params: { id: created.id } })),
      'FORBIDDEN',
    );

    await expectAppError(
      createProduct(
        writeCtx(
          { scope: READ_ONLY_SCOPE },
          { body: { companyId: DEMO_IDS.companyId, name: 'x', unit: '件' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      updateProduct(
        writeCtx(
          { scope: READ_ONLY_SCOPE },
          { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { name: 'x' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      deleteProduct(
        writeCtx(
          { scope: READ_ONLY_SCOPE },
          { params: { id: created.id }, headers: { 'if-match': '"1"' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );
  });

  it('乐观锁：缺 If-Match → 428；不匹配 → 409；成功后版本 +1 并回 ETag', async () => {
    const created = await createOne({ name: '并发商品', unit: '件' });

    await expectAppError(
      updateProduct(writeCtx({}, { params: { id: created.id }, body: { name: '缺前置' } }).ctx),
      'PRECONDITION_REQUIRED',
    );
    await expectAppError(
      updateProduct(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '1' }, body: { name: '弱 ETag' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
    await expectAppError(
      updateProduct(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"9"' }, body: { name: '旧版本' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );

    const { ctx, state } = writeCtx(
      {},
      {
        params: { id: created.id },
        headers: { 'if-match': '"1"' },
        body: { name: '改名后', aliases: ['新别名'] },
      },
    );
    const updated = await updateProduct(ctx);
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('改名后');
    expect(updated.aliases).toEqual(['新别名']);
    expect(updated.companyId).toBe(DEMO_IDS.companyId);
    expect(state.headers.ETag).toBe('"2"');

    await expectAppError(
      updateProduct(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { name: '再次旧版本' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
  });

  it('软删除：status 置「停用」、版本 +1，行仍在（不物理删除）', async () => {
    const created = await createOne({ name: '待停用商品' });
    const { ctx, state } = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': '"1"' } },
    );
    const deleted = await deleteProduct(ctx);

    expect(deleted.status).toBe('停用');
    expect(deleted.version).toBe(2);
    expect(state.headers.ETag).toBe('"2"');

    const row = await test.database.query<{ status: string; version: number }>(
      'SELECT status, version FROM product WHERE id = $1',
      [created.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ status: '停用', version: 2 });

    // 停用后仍可按 id 读取（只是不出现在单据选对象弹窗，由调用方按 status 过滤）。
    const detail = await getProduct(readCtx({}, { params: { id: created.id } }));
    expect(detail.status).toBe('停用');

    // 用旧版本再删 → 409。
    await expectAppError(
      deleteProduct(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
  });

  it('D52①/D54⑥：AI 直接停用 → AI_ACTION_FORBIDDEN，商品状态不变', async () => {
    const created = await createOne({ name: 'AI 停用商品' });
    const aiPrincipal = principal({
      actorType: 'ai',
      credentialId: 'api-token-test',
      credentialType: 'api_token',
      source: 'api',
    });

    await expectAppError(
      deleteProduct(
        writeCtx(aiPrincipal, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM product WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.status).toBe('启用');
  });

  it('D51/D54②：create/update/delete 写审计；普通列表/详情不写', async () => {
    const before = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'product'",
      [DEMO_IDS.tenantId],
    );

    const created = await createOne({ name: '审计商品' });
    await updateProduct(
      writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { unit: '箱' } }).ctx,
    );
    await deleteProduct(
      writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"2"' } }).ctx,
    );

    const afterWrites = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'product'",
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
        WHERE tenant_id = $1 AND object_type = 'product' AND object_id = $2
        ORDER BY occurred_at, action`,
      [DEMO_IDS.tenantId, created.id],
    );
    expect(events.rows.map((row) => row.action).sort()).toEqual([
      'product.create',
      'product.delete',
      'product.update',
    ]);
    expect(events.rows.every((row) => row.result === 'success')).toBe(true);
    expect(events.rows.every((row) => row.company_id === DEMO_IDS.companyId)).toBe(true);

    // 普通读不记审计。
    await listProducts(readCtx());
    await getProduct(readCtx({}, { params: { id: created.id } }));

    const afterReads = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'product'",
      [DEMO_IDS.tenantId],
    );
    expect(afterReads.rows[0]!.count).toBe(afterWrites.rows[0]!.count);
  });
});
