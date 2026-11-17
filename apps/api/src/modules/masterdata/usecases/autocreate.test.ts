import { AppError, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { registerServices } from '../../../platform/services/registry.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import { inventoryServices } from '../../inventory/services/ports.js';
import { createInternalTradeOrder } from '../../internal-trade/usecases/internal-trade-orders.js';
import { createSalesOrder } from '../../sales/usecases/sales-orders.js';
import { parseDedupeNote, recordDedupeCandidate } from '../dedupe/queue.js';
import { resolveMasterdataDraft } from './autocreate.js';

/**
 * 「开单即建档」静默建档的集成测试（#302 块 C 前半段 / D100，设计 §八 用例 1–5 / 9 / 10）。
 *
 * 全部跑在 PGlite 内存库 + seed 演示租户上，走真实用例（含真实 SQL、真实事务、真实审计）。
 */

const PRODUCT_ID = '01900000-0000-7000-8000-000000004111';
const BATCH_ID = '01900000-0000-7000-8000-000000004121';
const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000004103';

/** 只有 sales.create、**没有** customer.create：设计 §六「静默建档不要求主数据 create」。 */
const SALES_ONLY_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'view_price'] },
];
const SALES_READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'sales', actions: ['read'] }];
const INTERNAL_TRADE_SCOPE: ScopeMatrix = [
  { domain: 'internal_trade', actions: ['read', 'create', 'view_price'] },
];

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_ID],
  qty: '1',
  unitPrice: '10',
  amount: '10',
};

const N_LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_ID],
  qty: '1',
  unitPrice: '10',
  amount: '10',
};

interface FakeRequestInput {
  readonly principal: Principal;
  readonly body?: unknown;
  readonly params?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

function makeRequest(input: FakeRequestInput): FastifyRequest {
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: {},
    body: input.body,
    headers: input.headers ?? {},
    ip: '127.0.0.1',
    auditSource: 'web',
    auditReason: null,
  } as unknown as FastifyRequest;
}

function makeReply(): { reply: FastifyReply; state: { statusCode: number } } {
  const state = { statusCode: 200 };
  const reply = {
    status(code: number) {
      state.statusCode = code;
      return reply;
    },
    header() {
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
    scope: SALES_ONLY_SCOPE,
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

describe('masterdata 开单即建档（D100）', () => {
  let test: TestDatabase;

  async function createOrder(body: Record<string, unknown>, overrides: Partial<Principal> = {}) {
    const { reply, state } = makeReply();
    const ctx = {
      database: test.database,
      request: makeRequest({
        principal: principal(overrides),
        body: {
          companyId: DEMO_IDS.companyId,
          handlerId: DEMO_IDS.ownerEmployeeId,
          lines: [LINE],
          ...body,
        },
      }),
      reply,
    };
    const created = await createSalesOrder(ctx);
    return { created, status: state.statusCode };
  }

  async function customerRow(name: string) {
    const { rows } = await test.database.query<{
      id: string;
      origin: string;
      dedupe_state: string;
      company_id: string;
    }>(
      `SELECT id::text AS id, origin, dedupe_state, company_id::text AS company_id
         FROM customer
        WHERE name = $1`,
      [name],
    );
    return rows;
  }

  /** 直接调用静默建档（不走单据），用于没有单据入口的商品档案。 */
  async function draftOf(input: {
    kind: 'customer' | 'supplier' | 'processor' | 'product';
    draft: Record<string, unknown>;
  }): Promise<{ id: string }> {
    return test.database.transaction((tx) =>
      resolveMasterdataDraft(tx, principal(), {
        kind: input.kind,
        companyId: DEMO_IDS.companyId,
        draft: input.draft as never,
      }),
    );
  }

  async function queueRowsFor(kind: string, id: string) {
    const { rows } = await test.database.query<{
      left_id: string;
      right_id: string;
      score: string;
      note: string | null;
    }>(
      `SELECT left_id::text AS left_id, right_id::text AS right_id, score::text AS score, note
         FROM masterdata_dedupe
        WHERE kind = $1 AND (left_id = $2::uuid OR right_id = $2::uuid)`,
      [kind, id],
    );
    return rows;
  }

  beforeAll(async () => {
    registerServices(inventoryServices);
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '用例商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'C-UNIT-A', '8', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [BATCH_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, PRODUCT_ID, DEMO_IDS.ownerEmployeeId],
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('用例1：有 sales.create、没有 customer.create，带 customerDraft 存单成功且引用新客户', async () => {
    const { created, status } = await createOrder({
      customerDraft: { name: '静默客户甲', contactPhone: '13800138001' },
    });

    expect(status).toBe(201);
    const rows = await customerRow('静默客户甲');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin: 'order',
      dedupe_state: 'pending',
      company_id: DEMO_IDS.companyId,
    });
    expect(created.customerId).toBe(rows[0]!.id);
    expect(created.customerName).toBe('静默客户甲');
  });

  it('用例2：无 sales.create → 403，单据与主数据都没落库', async () => {
    const before = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sales_order`,
    );

    const { reply } = makeReply();
    const ctx = {
      database: test.database,
      request: makeRequest({
        principal: principal({ scope: SALES_READ_ONLY_SCOPE }),
        body: {
          companyId: DEMO_IDS.companyId,
          handlerId: DEMO_IDS.ownerEmployeeId,
          lines: [LINE],
          customerDraft: { name: '越权客户' },
        },
      }),
      reply,
    };
    await expectAppError(createSalesOrder(ctx), 'FORBIDDEN');

    expect(await customerRow('越权客户')).toHaveLength(0);
    const after = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sales_order`,
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it('用例3：响应体里不出现 created / isNew / archived / 已建档', async () => {
    const { created } = await createOrder({
      customerDraft: { name: '响应体客户' },
    });

    const body = JSON.stringify(created);
    for (const word of ['"created"', 'isNew', 'archived', '已建档']) {
      expect(body.includes(word)).toBe(false);
    }
    // 反证：真的建了档，只是没告诉调用方。
    expect(await customerRow('响应体客户')).toHaveLength(1);
  });

  it('用例4：同名客户二次录入 → 队列恰好一条、score=1.0、matched_by=name_only', async () => {
    await createOrder({ customerDraft: { name: '张记建材' } });
    const { created } = await createOrder({ customerDraft: { name: '张记建材' } });

    expect(await customerRow('张记建材')).toHaveLength(2);
    const rows = await queueRowsFor('customer', created.customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe('1.000');
    const parsed = parseDedupeNote(rows[0]!.note);
    expect(parsed).toEqual({ matchedBy: 'name_only', note: null });
  });

  it('用例5：电话相同名字不同 → name_phone；同名商品规格不同 → note=同名不同规格', async () => {
    await draftOf({
      kind: 'customer',
      draft: { name: '甲记批发', contactPhone: '13800138005' },
    });
    const second = await draftOf({
      kind: 'customer',
      draft: { name: '乙记批发', contactPhone: '138-0013-8005' },
    });
    const customerQueue = await queueRowsFor('customer', second.id);
    expect(customerQueue).toHaveLength(1);
    expect(parseDedupeNote(customerQueue[0]!.note)).toEqual({
      matchedBy: 'name_phone',
      note: null,
    });

    await draftOf({
      kind: 'product',
      draft: { name: '螺纹钢', spec: 'HRB400 φ20', unit: '吨' },
    });
    const sameName = await draftOf({
      kind: 'product',
      draft: { name: '螺纹钢', spec: 'HRB500 φ20', unit: '吨' },
    });
    const productQueue = await queueRowsFor('product', sameName.id);
    expect(productQueue).toHaveLength(1);
    expect(productQueue[0]!.score).toBe('1.000');
    expect(parseDedupeNote(productQueue[0]!.note)).toEqual({
      matchedBy: 'name_only',
      note: '同名不同规格',
    });
  });

  it('用例9：N 单传 companyDraft → 422「公司只能选不能建」，且没有落任何单据', async () => {
    const { reply } = makeReply();
    const ctx = {
      database: test.database,
      request: makeRequest({
        principal: principal({ scope: INTERNAL_TRADE_SCOPE }),
        body: {
          companyDraft: { name: '新公司' },
          fromCompanyId: DEMO_IDS.companyId,
          toCompanyId: OTHER_COMPANY_ID,
          handlerId: DEMO_IDS.ownerEmployeeId,
          lines: [N_LINE],
          internalPrice: '10',
        },
      }),
      reply,
    };

    await expect(createInternalTradeOrder(ctx)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: '公司只能选不能建',
      details: { field: 'companyDraft' },
    });

    const companies = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM company WHERE name = '新公司'`,
    );
    expect(companies.rows[0]!.count).toBe('0');
    const orders = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM internal_trade_order`,
    );
    expect(orders.rows[0]!.count).toBe('0');
  });

  it('用例10：两条单建同名客户 → 两个客户都在、队列恰好一条（UNIQUE 生效）', async () => {
    // 说明：PGlite 是单连接，真并发事务会互相踩 BEGIN（见 testing/pglite.ts），
    // 所以这里按「先后两次开单」复现同一对子被命中两次的场景，再直接重复写一次队列，
    // 验证的是 UNIQUE (kind, left_id, right_id) 这一层保证——与真并发的争用点相同。
    const first = await createOrder({ customerDraft: { name: '并发客户' } });
    const second = await createOrder({ customerDraft: { name: '并发客户' } });

    expect(await customerRow('并发客户')).toHaveLength(2);
    const rows = await queueRowsFor('customer', second.created.customerId);
    expect(rows).toHaveLength(1);

    const [leftId, rightId] = [first.created.customerId, second.created.customerId].sort();
    await test.database.transaction((tx) =>
      recordDedupeCandidate(tx, {
        tenantId: DEMO_IDS.tenantId,
        companyId: DEMO_IDS.companyId,
        kind: 'customer',
        leftId: rightId!, // 故意反向传：实现内部要按字典序归一
        rightId: leftId!,
        score: 1,
        matchedBy: 'name_only',
      }),
    );
    const after = await queueRowsFor('customer', second.created.customerId);
    expect(after).toHaveLength(1);
    expect(after[0]!.score).toBe('1.000');
  });

  it('二选一：customerId 与 customerDraft 都给 / 都不给 → 422 且 details.field=customerId', async () => {
    await expect(
      createOrder({
        customerId: '01900000-0000-7000-8000-000000004199',
        customerDraft: { name: '两个都给' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'customerId' } });

    await expect(createOrder({})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'customerId' },
    });
  });

  it('公司不可见 → FORBIDDEN，且不建档案', async () => {
    await expect(
      test.database.transaction((tx) =>
        resolveMasterdataDraft(tx, principal(), {
          kind: 'customer',
          companyId: '01900000-0000-7000-8000-000000004198',
          draft: { name: '别司客户' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await customerRow('别司客户')).toHaveLength(0);
  });
});
