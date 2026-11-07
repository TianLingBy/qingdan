import { AppError, type InternalTradeOrder, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { registerServices, resetServices } from '../../../platform/services/registry.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../testing/pglite.js';
import { inventoryServices } from '../../inventory/services/ports.js';
import {
  cancelInternalTradeOrder,
  createInternalTradeOrder,
  getInternalTradeOrder,
  shipInternalTradeOrder,
} from './internal-trade-orders.js';

/**
 * N 单发货 / 在途占用（D31 / D68③ / D73）。
 *
 * 覆盖：状态推进、按行均分锁在途占用（末批承余）、可用量由生成列自动跟随、
 * 重复发货 / 版本冲突 / 缺 If-Match、可用量不足整单回滚（含已锁批次回滚）、
 * 只有发出公司可发货、以及在途单取消必须释放占用（否则可用量被永久锁死）。
 *
 * 每个用例用**自己的批次**，避免用例之间共享在途量导致断言依赖执行顺序。
 */

const TO_COMPANY_ID = '01900000-0000-7000-8000-000000006101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000006111';

const FULL_SCOPE: ScopeMatrix = [
  {
    domain: 'internal_trade',
    actions: ['read', 'create', 'update', 'delete'],
  },
];

const READ_ONLY_SCOPE: ScopeMatrix = [
  { domain: 'internal_trade', actions: ['read'] },
];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
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
    auditReason: '发货测试',
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
    companyIds: [DEMO_IDS.companyId, TO_COMPANY_ID],
    scope: FULL_SCOPE,
    source: 'web',
    credentialType: 'session',
    sessionRenewed: false,
    ...overrides,
  };
}

async function expectAppError(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const promise = action();
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('internal-trade N 单发货（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let batchSeq = 0;

  function writeCtx(
    overrides: Partial<Principal> = {},
    parts: Partial<FakeRequestInput> = {},
  ) {
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

  /** 每个用例自建批次（可用量固定），避免用例之间互相影响在途量。 */
  async function freshBatch(inbound = '1000'): Promise<string> {
    batchSeq += 1;
    const id = `01900000-0000-7000-8000-0000000062${String(batchSeq).padStart(2, '0')}`;
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, $5, '10', $6, '0', '0', '0', $7)`,
      [
        id,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        `N-SHIP-${batchSeq}`,
        inbound,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
    return id;
  }

  async function createOne(
    qty: string,
    batchIds: readonly string[],
  ): Promise<InternalTradeOrder> {
    const { ctx } = writeCtx({}, {
      body: {
        fromCompanyId: DEMO_IDS.companyId,
        toCompanyId: TO_COMPANY_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [
          {
            productId: PRODUCT_ID,
            batchIds: [...batchIds],
            qty,
            unitPrice: '10',
            amount: '0',
          },
        ],
        internalPrice: '10',
      },
    });
    return await createInternalTradeOrder(ctx);
  }

  async function batchState(batchId: string) {
    const result = await test.database.query<{
      in_transit_qty: string;
      available_qty: string;
      company_id: string;
    }>(
      `SELECT trim_scale(in_transit_qty) AS in_transit_qty,
              trim_scale(available_qty) AS available_qty,
              company_id
         FROM inventory_batch
        WHERE id = $1`,
      [batchId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`批次 ${batchId} 不存在`);
    return row;
  }

  async function readOrder(id: string): Promise<InternalTradeOrder> {
    return await getInternalTradeOrder({
      database: test.database,
      request: makeRequest({ principal: principal(), params: { id } }),
    }) as InternalTradeOrder;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    // D70：端口由模块注册；用例测试不走 registerModules，这里显式注册 inventory 端口。
    resetServices();
    registerServices(inventoryServices);

    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '内部交易接收公司2', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [TO_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '发货测试商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
  });

  afterAll(async () => {
    resetServices();
    await test.database.close();
  });

  it('发货：进行中 → 在途，按行均分锁在途占用、可用量自动跟随、审计落库、不写库存流水', async () => {
    const batchA = await freshBatch();
    const batchB = await freshBatch();
    const created = await createOne('2', [batchA, batchB]);
    expect(created.inTransitQty).toBe('0');

    const { ctx, state } = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': `"${created.version}"` } },
    );
    const shipped = await shipInternalTradeOrder(ctx);

    expect(shipped.status).toBe('在途');
    expect(shipped.inTransitQty).toBe('2');
    expect(shipped.version).toBe(created.version + 1);
    expect(state.headers.ETag).toBe(`"${shipped.version}"`);

    // 批次仍归发出公司（D68③：转司要到到货确认），在途各 1，可用量 1000-1
    expect(await batchState(batchA)).toMatchObject({
      in_transit_qty: '1',
      available_qty: '999',
      company_id: DEMO_IDS.companyId,
    });
    expect(await batchState(batchB)).toMatchObject({
      in_transit_qty: '1',
      available_qty: '999',
    });

    const audit = await test.database.query<{ changes: unknown }>(
      `SELECT changes
         FROM audit_log
        WHERE object_id = $1
          AND action = 'internal_trade.order.ship'
        ORDER BY created_at DESC
        LIMIT 1`,
      [created.id],
    );
    expect(audit.rows[0]?.changes).toMatchObject({
      beforeStatus: '进行中',
      afterStatus: '在途',
      inTransitQty: '2',
      reservedBatchCount: 2,
    });

    // 在途占用不是库存变动 → 不写 inventory_flow
    const flows = await test.database.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM inventory_flow
        WHERE source_doc_id = $1`,
      [created.id],
    );
    expect(flows.rows[0]?.count).toBe(0);
  });

  it('除不尽：数量 1 分到三个批次 → 0.333333 / 0.333333 / 0.333334，末批承余量', async () => {
    const batchA = await freshBatch();
    const batchB = await freshBatch();
    const batchC = await freshBatch();
    const created = await createOne('1', [batchA, batchB, batchC]);

    const { ctx } = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': `"${created.version}"` } },
    );
    const shipped = await shipInternalTradeOrder(ctx);

    expect(shipped.status).toBe('在途');
    expect(shipped.inTransitQty).toBe('1');
    expect((await batchState(batchA)).in_transit_qty).toBe('0.333333');
    expect((await batchState(batchB)).in_transit_qty).toBe('0.333333');
    expect((await batchState(batchC)).in_transit_qty).toBe('0.333334');
  });

  it('重复发货 422；版本过期 409；缺 If-Match 428', async () => {
    const created = await createOne('1', [await freshBatch()]);

    const first = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': `"${created.version}"` } },
    );
    const shipped = await shipInternalTradeOrder(first.ctx);

    const again = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': `"${shipped.version}"` } },
    );
    await expectAppError(() => shipInternalTradeOrder(again.ctx), 'VALIDATION_FAILED');

    const stale = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': '"99"' } },
    );
    await expectAppError(() => shipInternalTradeOrder(stale.ctx), 'VERSION_CONFLICT');

    const missing = writeCtx({}, { params: { id: created.id } });
    await expectAppError(() => shipInternalTradeOrder(missing.ctx), 'PRECONDITION_REQUIRED');
  });

  it('权限：只读 scope 403；AI 禁止；只有发出公司可发货（接收方 403）；失败不留痕', async () => {
    const batch = await freshBatch();
    const created = await createOne('1', [batch]);
    const headers = { 'if-match': `"${created.version}"` };

    const readOnly = writeCtx({ scope: READ_ONLY_SCOPE }, { params: { id: created.id }, headers });
    await expectAppError(() => shipInternalTradeOrder(readOnly.ctx), 'FORBIDDEN');

    const ai = writeCtx(
      { actorType: 'ai', credentialId: 'token-test' },
      { params: { id: created.id }, headers },
    );
    await expectAppError(() => shipInternalTradeOrder(ai.ctx), 'AI_ACTION_FORBIDDEN');

    const receiverOnly = writeCtx(
      { companyIds: [TO_COMPANY_ID] },
      { params: { id: created.id }, headers },
    );
    await expectAppError(() => shipInternalTradeOrder(receiverOnly.ctx), 'FORBIDDEN');

    // 三次失败后状态与在途量必须原样
    const detail = await readOrder(created.id);
    expect(detail.status).toBe('进行中');
    expect(detail.inTransitQty).toBe('0');
    expect((await batchState(batch)).in_transit_qty).toBe('0');
  });

  it('可用量不足 409，整单回滚：前面已锁的批次也一起回滚', async () => {
    const roomy = await freshBatch();
    const tight = await freshBatch('0.5');
    // 均分后两批各锁 1，tight 只有 0.5 → 第二笔失败，必须把 roomy 已锁的 1 回滚掉
    const created = await createOne('2', [roomy, tight]);

    const { ctx } = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': `"${created.version}"` } },
    );
    await expectAppError(() => shipInternalTradeOrder(ctx), 'VERSION_CONFLICT');

    expect((await batchState(roomy)).in_transit_qty).toBe('0');
    expect((await batchState(tight)).in_transit_qty).toBe('0');
    const detail = await readOrder(created.id);
    expect(detail.status).toBe('进行中');
    expect(detail.inTransitQty).toBe('0');
  });

  it('取消在途单必须释放占用：在途量归零、批次可用量恢复（D68③）', async () => {
    const batchA = await freshBatch();
    const batchB = await freshBatch();
    const created = await createOne('2', [batchA, batchB]);

    const shippedCtx = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': `"${created.version}"` } },
    );
    const shipped = await shipInternalTradeOrder(shippedCtx.ctx);
    expect((await batchState(batchA)).available_qty).toBe('999');

    const cancelCtx = writeCtx(
      {},
      { params: { id: created.id }, headers: { 'if-match': `"${shipped.version}"` } },
    );
    const cancelled = await cancelInternalTradeOrder(cancelCtx.ctx);

    expect(cancelled.status).toBe('已取消');
    expect(cancelled.inTransitQty).toBe('0');
    expect(await batchState(batchA)).toMatchObject({
      in_transit_qty: '0',
      available_qty: '1000',
    });
    expect(await batchState(batchB)).toMatchObject({
      in_transit_qty: '0',
      available_qty: '1000',
    });

    // 取消也是在途占用的释放，不写库存流水
    const flows = await test.database.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM inventory_flow
        WHERE source_doc_id = $1`,
      [created.id],
    );
    expect(flows.rows[0]?.count).toBe(0);
  });
});
