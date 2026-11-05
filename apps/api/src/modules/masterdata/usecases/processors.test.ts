import { AppError, type Processor, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import * as repo from '../repo-processors.js';
import {
  createProcessor,
  createQuote,
  deleteProcessor,
  getProcessor,
  listProcessors,
  listQuotes,
  updateProcessor,
} from './processors.js';
import * as usecases from './processors.js';

/**
 * 加工厂 + 报价记录用例 / 数据访问（D15 / D49 / D51 / D52① / D54② / D64）。
 *
 * 直接调用用例（路由接线不在本任务范围），用最小 request/reply 替身喂入认证层
 * 已算好的 Principal；数据库用 PGlite + 全量迁移 + seed 演示租户。
 */

const COMPANY_2_ID = '01900000-0000-7000-8000-000000000098';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'processor', actions: ['read', 'create', 'update', 'delete'] },
];

const READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'processor', actions: ['read'] }];

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

describe('masterdata 加工厂 + 报价记录（PGlite + seed 演示租户）', () => {
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
  ): Promise<Processor> {
    const { ctx } = writeCtx(overrides, {
      body: { companyId: DEMO_IDS.companyId, name: '测试加工厂', ...input },
    });
    return createProcessor(ctx);
  }

  async function createOneQuote(
    processorId: string,
    input: Record<string, unknown> = {},
    overrides: Partial<Principal> = {},
  ) {
    const { ctx, state } = writeCtx(overrides, {
      body: {
        companyId: DEMO_IDS.companyId,
        processorId,
        quoteDate: '2026-01-10',
        processName: '切割',
        unitPrice: '12.5',
        ...input,
      },
    });
    return { quote: await createQuote(ctx), state };
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // 第二家公司用于跨公司隔离测试（与 suppliers.test 同款做法）。
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

  it('新增 → 详情：可空字段保持 null，版本从 1 起，201', async () => {
    const { ctx, state } = writeCtx(
      {},
      {
        body: {
          companyId: DEMO_IDS.companyId,
          name: '青禾加工厂',
          processorNo: 'P-001',
          contactName: '王师傅',
        },
      },
    );
    const created = await createProcessor(ctx);
    expect(state.statusCode).toBe(201);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.companyId).toBe(DEMO_IDS.companyId);
    expect(created.processorNo).toBe('P-001');
    expect(created.contactName).toBe('王师傅');
    expect(created.status).toBe('启用');
    expect(created.version).toBe(1);

    const detail = await getProcessor(readCtx({}, { params: { id: created.id } }));
    expect(detail).toEqual(created);

    const minimal = await createOne({ name: '最小加工厂' });
    expect(minimal.processorNo).toBeNull();
    expect(minimal.contactName).toBeNull();
  });

  it('D64④ / D64② 迁移形状：主表无价格列；报价表 RLS + 比价索引 + FK restrict', async () => {
    const processorColumns = await test.database.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'processor'
        ORDER BY ordinal_position`,
    );
    const columns = processorColumns.rows.map((row) => row.column_name);
    expect(columns).toEqual([
      'id',
      'tenant_id',
      'company_id',
      'processor_no',
      'name',
      'contact_name',
      'status',
      'version',
      'created_at',
      'updated_at',
    ]);
    // D64④：加工厂主表只存基础资料，不得出现价格 / 金额列。
    expect(columns.some((name) => /price|cost|amount|fee|money/i.test(name))).toBe(false);

    // D49：processor_no 不建检索索引，更没有唯一索引。
    const processorIndexes = await test.database.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'processor'",
    );
    expect(processorIndexes.rows.some((row) => row.indexdef.includes('processor_no'))).toBe(false);

    // D64③：比价索引按「租户 + 公司 + 工序 + 日期」。
    const quoteIndexes = await test.database.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'processor_quote'",
    );
    expect(
      quoteIndexes.rows.some((row) =>
        row.indexdef.includes('(tenant_id, company_id, process_name, quote_date)'),
      ),
    ).toBe(true);

    const rls = await test.database.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN ('processor', 'processor_quote')
        ORDER BY relname`,
    );
    expect(rls.rows).toEqual([
      { relname: 'processor', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'processor_quote', relrowsecurity: true, relforcerowsecurity: true },
    ]);

    // D64④：加工厂被报价引用后不能被物理删除（ON DELETE RESTRICT）。
    const fk = await test.database.query<{ confdeltype: string }>(
      `SELECT confdeltype
         FROM pg_constraint
        WHERE conname = 'processor_quote_processor_id_fkey'`,
    );
    expect(fk.rows[0]?.confdeltype).toBe('r');
  });

  it('D49：keyword 匹配名称/联系人，不按 processor_no 检索', async () => {
    await createOne({ name: '东岸加工厂', processorNo: 'PRO-ZZZ-777', contactName: '李师傅' });
    await createOne({ name: '西岭加工厂', processorNo: 'PRO-AAA-111', contactName: '赵师傅' });

    const byNo = await listProcessors(readCtx({}, { query: { keyword: 'PRO-ZZZ' } }));
    expect(byNo.items).toHaveLength(0);

    const byName = await listProcessors(readCtx({}, { query: { keyword: '东岸' } }));
    expect(byName.items.map((item) => item.name)).toEqual(['东岸加工厂']);

    const byContact = await listProcessors(readCtx({}, { query: { keyword: '赵师傅' } }));
    expect(byContact.items.map((item) => item.name)).toEqual(['西岭加工厂']);

    // 通配符按字面量处理。
    const wildcard = await listProcessors(readCtx({}, { query: { keyword: '%' } }));
    expect(wildcard.items).toHaveLength(0);
  });

  it('状态过滤与游标分页：两页无重叠', async () => {
    for (const name of ['分页甲加工厂', '分页乙加工厂', '分页丙加工厂']) await createOne({ name });
    await createOne({ name: '分页停用加工厂', status: '停用' });

    const enabled = await listProcessors(readCtx({}, { query: { status: '启用' } }));
    expect(enabled.items.every((item) => item.status === '启用')).toBe(true);
    const disabled = await listProcessors(readCtx({}, { query: { status: '停用' } }));
    expect(disabled.items.every((item) => item.status === '停用')).toBe(true);

    const first = await listProcessors(readCtx({}, { query: { limit: 2 } }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listProcessors(
      readCtx({}, { query: { limit: 2, cursor: first.nextCursor! } }),
    );
    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.every((item) => !firstIds.has(item.id))).toBe(true);
  });

  it('D15：跨公司不可读改删；创建到不可见公司 → 403', async () => {
    const created = await createOne({ name: '一司加工厂' });
    const other = { scope: FULL_SCOPE, companyIds: [COMPANY_2_ID] } as const;

    await expectAppError(
      getProcessor(readCtx(other, { params: { id: created.id } })),
      'NOT_FOUND',
    );
    const list = await listProcessors(readCtx(other));
    expect(list.items.some((item) => item.id === created.id)).toBe(false);

    await expectAppError(
      updateProcessor(
        writeCtx(other, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { name: '越权改名' },
        }).ctx,
      ),
      'NOT_FOUND',
    );
    await expectAppError(
      deleteProcessor(
        writeCtx(other, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'NOT_FOUND',
    );

    await expectAppError(
      createProcessor(
        writeCtx(other, { body: { companyId: DEMO_IDS.companyId, name: '越权创建' } }).ctx,
      ),
      'FORBIDDEN',
    );

    const explicit = await listProcessors(
      readCtx(other, { query: { companyId: DEMO_IDS.companyId } }),
    );
    expect(explicit.items).toEqual([]);
  });

  it('权限：无 processor.read → 403；缺写动作 → 403（含报价）', async () => {
    const created = await createOne({ name: '权限加工厂' });
    const noProcessorScope: ScopeMatrix = [{ domain: 'supplier', actions: ['read'] }];

    await expectAppError(listProcessors(readCtx({ scope: noProcessorScope })), 'FORBIDDEN');
    await expectAppError(
      getProcessor(readCtx({ scope: noProcessorScope }, { params: { id: created.id } })),
      'FORBIDDEN',
    );
    await expectAppError(listQuotes(readCtx({ scope: noProcessorScope })), 'FORBIDDEN');

    await expectAppError(
      createProcessor(
        writeCtx({ scope: READ_ONLY_SCOPE }, { body: { companyId: DEMO_IDS.companyId, name: 'x' } })
          .ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      updateProcessor(
        writeCtx(
          { scope: READ_ONLY_SCOPE },
          { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { name: 'x' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      deleteProcessor(
        writeCtx(
          { scope: READ_ONLY_SCOPE },
          { params: { id: created.id }, headers: { 'if-match': '"1"' } },
        ).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      createQuote(
        writeCtx(
          { scope: READ_ONLY_SCOPE },
          {
            body: {
              companyId: DEMO_IDS.companyId,
              processorId: created.id,
              quoteDate: '2026-01-10',
              processName: '切割',
              unitPrice: '1',
            },
          },
        ).ctx,
      ),
      'FORBIDDEN',
    );
  });

  it('乐观锁：缺 If-Match → 428；不匹配 → 409；成功后版本 +1 并回 ETag', async () => {
    const created = await createOne({ name: '并发加工厂' });

    await expectAppError(
      updateProcessor(writeCtx({}, { params: { id: created.id }, body: { name: '缺前置' } }).ctx),
      'PRECONDITION_REQUIRED',
    );
    await expectAppError(
      updateProcessor(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '1' }, body: { name: '弱 ETag' } })
          .ctx,
      ),
      'VERSION_CONFLICT',
    );
    await expectAppError(
      updateProcessor(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"9"' }, body: { name: '旧版本' } })
          .ctx,
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
    const updated = await updateProcessor(ctx);
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('改名后');
    expect(updated.contactName).toBe('新联系人');
    expect(updated.companyId).toBe(DEMO_IDS.companyId);
    expect(state.headers.ETag).toBe('"2"');
  });

  it('软删除：status 置「停用」、版本 +1，行仍在（不物理删除）', async () => {
    const created = await createOne({ name: '待停用加工厂' });
    const { ctx, state } = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': '"1"' } },
    );
    const deleted = await deleteProcessor(ctx);

    expect(deleted.status).toBe('停用');
    expect(deleted.version).toBe(2);
    expect(state.headers.ETag).toBe('"2"');

    const row = await test.database.query<{ status: string; version: number }>(
      'SELECT status, version FROM processor WHERE id = $1',
      [created.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ status: '停用', version: 2 });

    const detail = await getProcessor(readCtx({}, { params: { id: created.id } }));
    expect(detail.status).toBe('停用');

    await expectAppError(
      deleteProcessor(
        writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'VERSION_CONFLICT',
    );
  });

  it('D52①/D54⑥：AI 直接停用 → AI_ACTION_FORBIDDEN，加工厂状态不变', async () => {
    const created = await createOne({ name: 'AI 停用加工厂' });
    const aiPrincipal = principal({
      actorType: 'ai',
      credentialId: 'api-token-test',
      credentialType: 'api_token',
      source: 'api',
    });

    await expectAppError(
      deleteProcessor(
        writeCtx(aiPrincipal, { params: { id: created.id }, headers: { 'if-match': '"1"' } }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM processor WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.status).toBe('启用');
  });

  it('D51/D54②：加工厂 create/update/delete 写审计；普通列表/详情不写', async () => {
    const before = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'processor'",
      [DEMO_IDS.tenantId],
    );

    const created = await createOne({ name: '审计加工厂' });
    await updateProcessor(
      writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"1"' }, body: { contactName: '新联系人' } })
        .ctx,
    );
    await deleteProcessor(
      writeCtx({}, { params: { id: created.id }, headers: { 'if-match': '"2"' } }).ctx,
    );

    const afterWrites = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'processor'",
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
        WHERE tenant_id = $1 AND object_type = 'processor' AND object_id = $2
        ORDER BY occurred_at, action`,
      [DEMO_IDS.tenantId, created.id],
    );
    expect(events.rows.map((row) => row.action).sort()).toEqual([
      'processor.create',
      'processor.delete',
      'processor.update',
    ]);
    expect(events.rows.every((row) => row.result === 'success')).toBe(true);
    expect(events.rows.every((row) => row.company_id === DEMO_IDS.companyId)).toBe(true);

    await listProcessors(readCtx());
    await getProcessor(readCtx({}, { params: { id: created.id } }));

    const afterReads = await test.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1 AND object_type = 'processor'",
      [DEMO_IDS.tenantId],
    );
    expect(afterReads.rows[0]!.count).toBe(afterWrites.rows[0]!.count);
  });

  it('报价创建：decimal 字符串保精度落表，201，并写报价审计', async () => {
    const processor = await createOne({ name: '报价加工厂' });
    const { quote, state } = await createOneQuote(processor.id, {
      quoteDate: '2026-01-31',
      processName: '切割',
      unitPrice: '12.5',
    });

    expect(state.statusCode).toBe(201);
    expect(quote.companyId).toBe(DEMO_IDS.companyId);
    expect(quote.processorId).toBe(processor.id);
    expect(quote.quoteDate).toBe('2026-01-31');
    expect(quote.processName).toBe('切割');
    // D54：numeric(18,6) 以字符串返回，保持 6 位小数（不是 number）。
    expect(quote.unitPrice).toBe('12.500000');
    expect(quote.remark).toBeNull();
    expect(quote.version).toBe(1);

    const audit = await test.database.query<{ action: string; company_id: string | null }>(
      `SELECT action, company_id
         FROM audit_log
        WHERE tenant_id = $1 AND object_type = 'processor_quote' AND object_id = $2`,
      [DEMO_IDS.tenantId, quote.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'processor.quote.create',
      company_id: DEMO_IDS.companyId,
    });
  });

  it('报价跨公司校验：不可见加工厂 → 404；公司不一致 → 422；跨公司报价列表不可见', async () => {
    const other = { scope: FULL_SCOPE, companyIds: [COMPANY_2_ID] } as const;
    const processor2 = await createOne(
      { companyId: COMPANY_2_ID, name: '二司加工厂' },
      { companyIds: [COMPANY_2_ID] },
    );
    await createOneQuote(
      processor2.id,
      { companyId: COMPANY_2_ID, processName: '跨公司工序', quoteDate: '2026-01-10' },
      other,
    );

    // 给不可见公司的加工厂报价：companyId 不可见 → 403（服务端先挡公司）。
    await expectAppError(
      createQuote(
        writeCtx(
          {},
          {
            body: {
              companyId: COMPANY_2_ID,
              processorId: processor2.id,
              quoteDate: '2026-01-10',
              processName: '切割',
              unitPrice: '1',
            },
          },
        ).ctx,
      ),
      'FORBIDDEN',
    );

    // 公司可见但加工厂不可见 → 404（不泄露存在性）。
    await expectAppError(
      createQuote(
        writeCtx(
          {},
          {
            body: {
              companyId: DEMO_IDS.companyId,
              processorId: processor2.id,
              quoteDate: '2026-01-10',
              processName: '切割',
              unitPrice: '1',
            },
          },
        ).ctx,
      ),
      'NOT_FOUND',
    );

    // 同时可见两家公司，但报价归属公司与加工厂不一致 → 422。
    const both = principal({ companyIds: [DEMO_IDS.companyId, COMPANY_2_ID] });
    const processor1 = await createOne({ name: '一司对账加工厂' });
    await expectAppError(
      createQuote(
        writeCtx(
          { companyIds: both.companyIds },
          {
            body: {
              companyId: COMPANY_2_ID,
              processorId: processor1.id,
              quoteDate: '2026-01-10',
              processName: '切割',
              unitPrice: '1',
            },
          },
        ).ctx,
      ),
      'VALIDATION_FAILED',
    );

    // 公司隔离：一司的报价列表看不到二司的报价。
    const isolated = await listQuotes(readCtx({}, { query: { processName: '跨公司工序' } }));
    expect(isolated.items).toEqual([]);
  });

  it('D64③：报价按工序 + 日期区间跨加工厂过滤，并按 unit_price 升序比价', async () => {
    const processorA = await createOne({ name: '比价甲加工厂' });
    const processorB = await createOne({ name: '比价乙加工厂' });

    await createOneQuote(processorA.id, {
      quoteDate: '2026-01-10',
      processName: '比价切割',
      unitPrice: '12.5',
    });
    await createOneQuote(processorB.id, {
      quoteDate: '2026-01-15',
      processName: '比价切割',
      unitPrice: '10.25',
    });
    await createOneQuote(processorB.id, {
      quoteDate: '2026-01-31',
      processName: '比价切割',
      unitPrice: '11',
    });
    // 区间外 / 其他工序：都不应出现在结果里。
    await createOneQuote(processorA.id, {
      quoteDate: '2026-02-10',
      processName: '比价切割',
      unitPrice: '9.75',
    });
    await createOneQuote(processorB.id, {
      quoteDate: '2026-01-12',
      processName: '比价包装',
      unitPrice: '1',
    });

    const result = await listQuotes(
      readCtx({}, {
        query: {
          processName: '比价切割',
          from: '2026-01-01',
          to: '2026-01-31',
        },
      }),
    );

    // 跨两家加工厂、日期区间两端都包含（01-31），按 decimal 单价升序。
    expect(result.items.map((item) => item.unitPrice)).toEqual([
      '10.250000',
      '11.000000',
      '12.500000',
    ]);
    expect(new Set(result.items.map((item) => item.processorId))).toEqual(
      new Set([processorA.id, processorB.id]),
    );
    expect(result.items.every((item) => item.processName === '比价切割')).toBe(true);
  });

  it('报价按 processorId 过滤 + 游标分页：两页无重叠', async () => {
    const processor = await createOne({ name: '分页报价加工厂' });
    for (const [index, date] of ['2026-03-01', '2026-03-02', '2026-03-03'].entries()) {
      await createOneQuote(processor.id, {
        quoteDate: date,
        processName: '分页工序',
        unitPrice: String(index + 1),
      });
    }

    const all = await listQuotes(readCtx({}, { query: { processorId: processor.id } }));
    expect(all.items).toHaveLength(3);
    expect(all.items.every((item) => item.processorId === processor.id)).toBe(true);

    const first = await listQuotes(
      readCtx({}, { query: { processorId: processor.id, limit: 2 } }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listQuotes(
      readCtx({}, {
        query: { processorId: processor.id, limit: 2, cursor: first.nextCursor! },
      }),
    );
    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.every((item) => !firstIds.has(item.id))).toBe(true);
    expect(first.items.length + second.items.length).toBe(3);
  });

  it('D64③：比价按单价排序时，游标续页仍严格按价格顺序且不重不漏', async () => {
    const processorA = await createOne({ name: '比价翻页甲加工厂' });
    const processorB = await createOne({ name: '比价翻页乙加工厂' });

    // 插入顺序与价格顺序故意错开，确认是按 unit_price 而不是按 id 续页。
    const prices = ['30', '10', '20', '40'];
    for (const [index, price] of prices.entries()) {
      await createOneQuote(index % 2 === 0 ? processorA.id : processorB.id, {
        quoteDate: `2026-04-0${index + 1}`,
        processName: '比价翻页工序',
        unitPrice: price,
      });
    }

    const first = await listQuotes(
      readCtx({}, { query: { processName: '比价翻页工序', limit: 2 } }),
    );
    expect(first.items.map((item) => item.unitPrice)).toEqual(['10.000000', '20.000000']);
    expect(first.nextCursor).not.toBeNull();

    const second = await listQuotes(
      readCtx({}, {
        query: { processName: '比价翻页工序', limit: 2, cursor: first.nextCursor! },
      }),
    );
    expect(second.items.map((item) => item.unitPrice)).toEqual(['30.000000', '40.000000']);
    expect(second.nextCursor).toBeNull();

    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.every((item) => !firstIds.has(item.id))).toBe(true);
  });

  it('D64④：报价不可改不可删（repo / 用例均无 update/delete 方法）', () => {
    const repositoryExports = Object.keys(repo);
    expect(repositoryExports).not.toContain('updateQuote');
    expect(repositoryExports).not.toContain('deleteQuote');
    expect(repositoryExports).not.toContain('softDeleteQuote');

    const usecaseExports = Object.keys(usecases);
    expect(usecaseExports).not.toContain('updateQuote');
    expect(usecaseExports).not.toContain('deleteQuote');
  });

  it('单价校验：负数、超 6 位小数、超长整数位都被拒（D54）', async () => {
    const processor = await createOne({ name: '单价校验加工厂' });
    const base = {
      companyId: DEMO_IDS.companyId,
      processorId: processor.id,
      quoteDate: '2026-01-10',
      processName: '切割',
    };

    for (const unitPrice of ['-1', '1.1234567', '1234567890123', 'abc', '']) {
      await expectAppError(
        createQuote(writeCtx({}, { body: { ...base, unitPrice } }).ctx),
        'VALIDATION_FAILED',
      );
    }

    // 边界值可存：12 位整数 + 6 位小数。
    const { quote } = await createOneQuote(processor.id, {
      processName: '边界工序',
      unitPrice: '123456789012.123456',
    });
    expect(quote.unitPrice).toBe('123456789012.123456');
  });
});
