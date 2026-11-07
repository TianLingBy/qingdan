import {
  AppError,
  type PurchaseOrder,
  type PurchaseOrderDetail,
  type ScopeMatrix,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  updatePurchaseOrder,
} from './purchase-orders.js';

/**
 * 采购单 A 用例 / 数据访问（D15 / D16 / D21 / D39 / D51 / D52 / D54）。
 *
 * 直接调用用例，用最小 request/reply 替身喂入认证层已算好的 Principal；
 * 数据库用 PGlite + 全量迁移 + seed 演示租户。
 */

const SUPPLIER_ID = '01900000-0000-7000-8000-000000000301';
const SUPPLIER_2_ID = '01900000-0000-7000-8000-000000000302';
const PRODUCT_ID = '01900000-0000-7000-8000-000000000311';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000000312';
const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000000303';
const BATCH_ID = '01900000-0000-7000-8000-000000000321';
const FLOW_ID = '01900000-0000-7000-8000-000000000322';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'purchase', actions: ['read', 'create', 'update', 'delete', 'view_price'] },
];
const READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'purchase', actions: ['read', 'view_price'] }];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly auditReason?: string | null;
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
    auditReason: input.auditReason ?? null,
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

function aiPrincipal(overrides: Partial<Principal> = {}): Principal {
  return principal({
    actorType: 'ai',
    credentialId: 'token-test',
    ...overrides,
  });
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

const LINE = {
  productId: PRODUCT_ID,
  qty: '2',
  unitPrice: '12.5',
  // 输入金额故意与 qty × unitPrice 不一致：服务端按契约以 SQL 计算为准。
  amount: '999',
};

const FEE = {
  feeName: '运费',
  qty: '2',
  unitPrice: '10',
  amount: '20',
  remark: null,
};

describe('purchase 采购单用例（PGlite + seed 演示租户）', () => {
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
  ): Promise<PurchaseOrder> {
    const { ctx, state } = writeCtx(overrides, {
      body: {
        companyId: DEMO_IDS.companyId,
        supplierId: SUPPLIER_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        ...input,
      },
    });
    const created = await createPurchaseOrder(ctx);
    expect(state.statusCode).toBe(201);
    return created;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
    );
    for (const [id, companyId, name] of [
      [SUPPLIER_ID, DEMO_IDS.companyId, '用例供应商'],
      [SUPPLIER_2_ID, OTHER_COMPANY_ID, '二司供应商'],
    ] as const) {
      await test.database.query(
        `INSERT INTO supplier
           (id, tenant_id, company_id, supplier_no, name, supplied_materials, status)
         VALUES ($1, $2, $3, NULL, $4, '{}', '启用')
         ON CONFLICT (id) DO NOTHING`,
        [id, DEMO_IDS.tenantId, companyId, name],
      );
    }
    for (const [id, name] of [
      [PRODUCT_ID, '用例商品'],
      [PRODUCT_2_ID, '用例商品二'],
    ] as const) {
      await test.database.query(
        `INSERT INTO product
           (id, tenant_id, company_id, product_no, name, aliases, unit, status)
         VALUES ($1, $2, $3, NULL, $4, '{}', '件', '启用')
         ON CONFLICT (id) DO NOTHING`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, name],
      );
    }
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('开单：201、单号服务端生成、金额由 SQL 计算、负数费用需备注、审计落库', async () => {
    const created = await createOne({
      lines: [LINE, { productId: PRODUCT_2_ID, qty: '3', unitPrice: '1.5', amount: '1' }],
      fees: [FEE, { feeName: '供应商返利', qty: '1', unitPrice: '5', amount: '-5', remark: '返利' }],
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.tenantId).toBe(DEMO_IDS.tenantId);
    expect(created.companyId).toBe(DEMO_IDS.companyId);
    expect(created.orderNo).toMatch(/^A-0001-\d{8}-\d{4}$/);
    expect(created.status).toBe('进行中');
    expect(created.supplierName).toBe('用例供应商');
    expect(created.version).toBe(1);
    expect(created.lines).toHaveLength(2);
    expect(created.lines[0]).toMatchObject({ productId: PRODUCT_ID, qty: '2', unitPrice: '12.5' });
    expect(Number(created.lines[0]?.amount)).toBe(25);
    expect(Number(created.lines[1]?.amount)).toBe(4.5);
    expect(created.fees).toHaveLength(2);
    expect(created.fees[1]).toMatchObject({ feeName: '供应商返利', amount: '-5', remark: '返利' });
    expect(Number(created.goodsAmount)).toBe(29.5);
    expect(Number(created.feeAmount)).toBe(15);
    expect(Number(created.totalAmount)).toBe(44.5);

    // D51：成功审计落到 audit_log（outbox 已搬运）。
    const audit = await test.database.query<{ action: string; object_type: string; result: string }>(
      `SELECT action, object_type, result FROM audit_log WHERE object_id = $1 AND action <> 'amount.detail'`,
      [created.id],
    );
    expect(audit.rows).toEqual([
      { action: 'purchase.order.create', object_type: 'purchase_order', result: 'success' },
    ]);

    // D39：负数费用无备注 → 契约层拒绝。
    await expectAppError(
      createPurchaseOrder(
        writeCtx({}, {
          body: {
            companyId: DEMO_IDS.companyId,
            supplierId: SUPPLIER_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            lines: [LINE],
            fees: [{ feeName: '返利', qty: '1', unitPrice: '5', amount: '-5' }],
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );
  });

  it('开单：AI 凭证拒绝（D52.1）；跨公司归属 403；供应商跨公司 422；无权限 403', async () => {
    await expectAppError(
      createPurchaseOrder(
        writeCtx({}, {
          principal: aiPrincipal(),
          auditReason: 'AI 尝试开单',
          body: {
            companyId: DEMO_IDS.companyId,
            supplierId: SUPPLIER_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            lines: [LINE],
          },
        }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    await expectAppError(
      createPurchaseOrder(
        writeCtx({}, {
          body: {
            companyId: OTHER_COMPANY_ID,
            supplierId: SUPPLIER_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            lines: [LINE],
          },
        }).ctx,
      ),
      'FORBIDDEN',
    );

    await expectAppError(
      createPurchaseOrder(
        writeCtx({}, {
          body: {
            companyId: DEMO_IDS.companyId,
            supplierId: SUPPLIER_2_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            lines: [LINE],
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createPurchaseOrder(
        writeCtx({ scope: READ_ONLY_SCOPE }, {
          body: {
            companyId: DEMO_IDS.companyId,
            supplierId: SUPPLIER_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            lines: [LINE],
          },
        }).ctx,
      ),
      'FORBIDDEN',
    );
  });

  it('详情 / 列表：cancelable 由 canCancel 推导；按供应商 / 状态 / 关键字过滤；普通读不记审计', async () => {
    const created = await createOne({ fees: [FEE] });

    const detail = await getPurchaseOrder(
      readCtx({}, { params: { id: created.id } }),
    ) as PurchaseOrderDetail;
    expect(detail.id).toBe(created.id);
    expect(detail.lines).toHaveLength(1);
    expect(detail.cancelable).toEqual({ allowed: true, reason: null });

    const bySupplier = await listPurchaseOrders(
      readCtx({}, { query: { supplierId: SUPPLIER_ID } }),
    );
    expect(bySupplier.items.map((item) => item.id)).toContain(created.id);
    expect(bySupplier.items[0]?.lines).toHaveLength(1);

    const byStatus = await listPurchaseOrders(
      readCtx({}, { query: { status: '进行中' } }),
    );
    expect(byStatus.items.map((item) => item.id)).toContain(created.id);

    const noMatch = await listPurchaseOrders(
      readCtx({}, { query: { keyword: '不存在的单号' } }),
    );
    expect(noMatch.items).toHaveLength(0);

    const byOrderNo = await listPurchaseOrders(
      readCtx({}, { query: { keyword: created.orderNo } }),
    );
    expect(byOrderNo.items.map((item) => item.id)).toEqual([created.id]);

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE action IN ('purchase.order.list.read', 'purchase.order.detail.read')`,
    );
    expect(audit.rows[0]?.count).toBe('0');
  });

  it('修改：If-Match 必填、版本冲突 409、仅进行中可改、明细替换后重新聚合', async () => {
    const created = await createOne();

    await expectAppError(
      updatePurchaseOrder(
        writeCtx({}, { params: { id: created.id }, body: { handlerId: DEMO_IDS.ownerEmployeeId } })
          .ctx,
      ),
      'PRECONDITION_REQUIRED',
    );

    await expectAppError(
      updatePurchaseOrder(
        writeCtx({}, {
          params: { id: created.id },
          headers: { 'if-match': '"9"' },
          body: { handlerId: DEMO_IDS.ownerEmployeeId },
        }).ctx,
      ),
      'VERSION_CONFLICT',
    );

    const { ctx, state } = writeCtx({}, {
      params: { id: created.id },
      headers: { 'if-match': '"1"' },
      body: {
        lines: [{ productId: PRODUCT_2_ID, qty: '4', unitPrice: '2.25', amount: '0' }],
        fees: [{ feeName: '杂费', qty: '1', unitPrice: '3', amount: '3' }],
      },
    });
    const updated = await updatePurchaseOrder(ctx);
    expect(state.headers.ETag).toBe('"2"');
    expect(updated.version).toBe(2);
    expect(updated.lines).toHaveLength(1);
    expect(Number(updated.lines[0]?.amount)).toBe(9);
    expect(Number(updated.goodsAmount)).toBe(9);
    expect(Number(updated.feeAmount)).toBe(3);
    expect(Number(updated.totalAmount)).toBe(12);

    // 重复用旧版本 → 409。
    await expectAppError(
      updatePurchaseOrder(
        writeCtx({}, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { handlerId: DEMO_IDS.ownerEmployeeId },
        }).ctx,
      ),
      'VERSION_CONFLICT',
    );

    // 已完成单不可改（D4）。
    const completed = await createOne();
    await test.database.query(`UPDATE purchase_order SET status = '已完成' WHERE id = $1`, [
      completed.id,
    ]);
    await expectAppError(
      updatePurchaseOrder(
        writeCtx({}, {
          params: { id: completed.id },
          headers: { 'if-match': '"1"' },
          body: { handlerId: DEMO_IDS.ownerEmployeeId },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE action = 'purchase.order.update' AND object_id = $1 AND result = 'success'`,
      [created.id],
    );
    expect(audit.rows[0]?.count).toBe('1');
  });

  it('取消：D21 有下游 → 409；已完成 / 已取消 → 422；AI 禁止；成功置已取消并记审计', async () => {
    // 有直接下游（库存流水来源为 A 单）。
    const withDownstream = await createOne();
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'PO-DOWNSTREAM-1', '10', '10', '0', '0', '0', $5)`,
      [BATCH_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, PRODUCT_ID, DEMO_IDS.ownerEmployeeId],
    );
    await test.database.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id, handled_by)
       VALUES ($1, $2, $3, $4, '10', 'A', $5, $6)`,
      [FLOW_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, BATCH_ID, withDownstream.id, DEMO_IDS.ownerEmployeeId],
    );

    await expectAppError(
      cancelPurchaseOrder(
        writeCtx({}, {
          params: { id: withDownstream.id },
          headers: { 'if-match': '"1"' },
        }).ctx,
      ),
      'VERSION_CONFLICT',
    );

    // 已完成不可取消。
    const completed = await createOne();
    await test.database.query(`UPDATE purchase_order SET status = '已完成' WHERE id = $1`, [
      completed.id,
    ]);
    await expectAppError(
      cancelPurchaseOrder(
        writeCtx({}, {
          params: { id: completed.id },
          headers: { 'if-match': '"1"' },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    // AI 禁止取消（D52.1）。
    const aiTarget = await createOne();
    await expectAppError(
      cancelPurchaseOrder(
        writeCtx({}, {
          principal: aiPrincipal(),
          auditReason: 'AI 尝试取消',
          params: { id: aiTarget.id },
          headers: { 'if-match': '"1"' },
        }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    // 正常取消。
    const created = await createOne();
    const { ctx, state } = writeCtx({}, {
      params: { id: created.id },
      headers: { 'if-match': '"1"' },
    });
    const cancelled = await cancelPurchaseOrder(ctx);
    expect(state.headers.ETag).toBe('"2"');
    expect(cancelled.status).toBe('已取消');
    expect(cancelled.version).toBe(2);

    // 已取消不可再次取消。
    await expectAppError(
      cancelPurchaseOrder(
        writeCtx({}, {
          params: { id: created.id },
          headers: { 'if-match': '"2"' },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result FROM audit_log WHERE object_id = $1 AND action <> 'amount.detail' ORDER BY action`,
      [created.id],
    );
    expect(audit.rows).toContainEqual({ action: 'purchase.order.cancel', result: 'success' });
    expect(audit.rows).toContainEqual({ action: 'purchase.order.create', result: 'success' });

    // 详情里的 cancelable 同步为 already_cancelled。
    const detail = (await getPurchaseOrder(
      readCtx({}, { params: { id: created.id } }),
    )) as PurchaseOrderDetail;
    expect(detail.cancelable).toEqual({ allowed: false, reason: 'already_cancelled' });
  });

  it('D15：跨公司详情 / 修改 / 取消等同不存在', async () => {
    const created = await createOne();
    const outside = principal({ companyIds: [OTHER_COMPANY_ID] });

    await expectAppError(
      getPurchaseOrder(readCtx(outside, { params: { id: created.id } })),
      'NOT_FOUND',
    );
    await expectAppError(
      updatePurchaseOrder(
        writeCtx(outside, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { handlerId: DEMO_IDS.ownerEmployeeId },
        }).ctx,
      ),
      'NOT_FOUND',
    );
    await expectAppError(
      cancelPurchaseOrder(
        writeCtx(outside, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
        }).ctx,
      ),
      'NOT_FOUND',
    );

    const list = await listPurchaseOrders(
      readCtx(outside, { query: { keyword: created.orderNo } }),
    );
    expect(list.items).toHaveLength(0);
  });
});
