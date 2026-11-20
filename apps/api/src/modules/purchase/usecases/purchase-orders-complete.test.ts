import { registerServices, resetServices } from '../../../platform/services/registry.js';
import { inventoryServices } from '../../inventory/services/ports.js';
import { AppError, type PurchaseOrder, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import {
  completePurchaseOrder,
  createPurchaseOrder,
  receivePurchaseOrder,
  revokePurchaseOrderShip,
  shipPurchaseOrder,
} from './purchase-orders.js';

/**
 * 采购单 A 完成（#99 A 链路）：逐行建批次 + 入库流水；D84 起费用按明细金额占比摊入锁价。
 *
 * 断言覆盖库存、流水、批次成本、费用分摊审计；重复完成/旧版本/AI 凭证必须被拒且无副作用。
 */

const SUPPLIER_ID = '01900000-0000-7000-8000-000000000301';
const PRODUCT_ID = '01900000-0000-7000-8000-000000000311';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000000312';
const PROCESSOR_ID = '01900000-0000-7000-8000-000000000313';

const FULL_SCOPE: ScopeMatrix = [
  {
    domain: 'purchase',
    actions: ['read', 'create', 'update', 'approve', 'ship', 'delete', 'view_price'],
  },
];
const UPDATE_ONLY_SCOPE: ScopeMatrix = [
  { domain: 'purchase', actions: ['read', 'create', 'update', 'view_price'] },
];

const REVOKE_REASON = '司机临时取消，货退回厂里';

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /** 真实请求由 X-Reason 头解析出来；撤销发货必填。 */
  readonly auditReason?: string | null;
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
    auditReason: input.auditReason ?? null,
  } as unknown as FastifyRequest;
}

function makeReply(): { reply: FastifyReply; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const reply = {
    status() {
      return reply;
    },
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
    send() {
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, headers };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    actorType: 'employee',
    actorId: DEMO_IDS.ownerEmployeeId,
    tenantId: DEMO_IDS.tenantId,
    employeeId: DEMO_IDS.ownerEmployeeId,
    credentialId: 'purchase-complete-session-test',
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

describe('purchase A 采购单完成用例（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;

  async function createOne(
    lines: { productId: string; qty: string; unitPrice: string; amount: string }[] = [
      { productId: PRODUCT_ID, qty: '2', unitPrice: '12.5', amount: '999' },
      { productId: PRODUCT_2_ID, qty: '3', unitPrice: '1.5', amount: '1' },
    ],
    fees: { feeName: string; qty: string; unitPrice: string; amount: string }[] = [],
  ): Promise<PurchaseOrder> {
    const { reply } = makeReply();
    return createPurchaseOrder({
      database: test.database,
      request: makeRequest({
        principal: principal(),
        body: {
          companyId: DEMO_IDS.companyId,
          supplierId: SUPPLIER_ID,
          handlerId: DEMO_IDS.ownerEmployeeId,
          lines,
          fees,
        },
      }),
      reply,
    });
  }

  async function finish(
    id: string,
    version: number | null,
    overrides: Partial<Principal> = {},
  ): Promise<{ order: PurchaseOrder; headers: Record<string, string> }> {
    const { reply, headers } = makeReply();
    const request = makeRequest({
      principal: principal(overrides),
      params: { id },
      headers: version === null ? {} : { 'if-match': `"${version}"` },
    });
    const order = await completePurchaseOrder({
      database: test.database,
      request,
      reply,
    });
    return { order, headers };
  }

  async function ship(
    id: string,
    lines: Array<{ lineNo: number; transitTo: 'warehouse' | 'processor'; processorId?: string }>,
    version = 1,
    overrides: Partial<Principal> = {},
  ): Promise<PurchaseOrder> {
    const { reply } = makeReply();
    return shipPurchaseOrder({
      database: test.database,
      request: makeRequest({
        principal: principal(overrides),
        params: { id },
        headers: { 'if-match': `"${version}"` },
        body: { lines },
      }),
      reply,
    });
  }

  async function receive(
    id: string,
    version = 2,
    overrides: Partial<Principal> = {},
  ): Promise<PurchaseOrder> {
    const { reply } = makeReply();
    return receivePurchaseOrder({
      database: test.database,
      request: makeRequest({
        principal: principal(overrides),
        params: { id },
        headers: { 'if-match': `"${version}"` },
      }),
      reply,
    });
  }

  async function revoke(
    id: string,
    version = 2,
    overrides: Partial<Principal> = {},
    auditReason: string | null = REVOKE_REASON,
  ): Promise<PurchaseOrder> {
    const { reply } = makeReply();
    return revokePurchaseOrderShip({
      database: test.database,
      request: makeRequest({
        principal: principal(overrides),
        params: { id },
        headers: { 'if-match': `"${version}"` },
        auditReason,
      }),
      reply,
    });
  }

  async function batchCount(): Promise<number> {
    const result = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_batch`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  /** 某个 A 单建出的批次，按商品 id 排序（与明细顺序一致）。 */
  async function batchesOf(orderId: string): Promise<
    {
      product_id: string;
      locked_unit_cost: string;
      inbound_qty: string;
      in_transit_qty: string;
      available_qty: string;
      held_by_processor_id: string | null;
      custodian_id: string;
    }[]
  > {
    const result = await test.database.query<{
      product_id: string;
      locked_unit_cost: string;
      inbound_qty: string;
      in_transit_qty: string;
      available_qty: string;
      held_by_processor_id: string | null;
      custodian_id: string;
    }>(
      `SELECT DISTINCT b.id::text AS id,
              b.product_id::text AS product_id,
              trim_scale(b.locked_unit_cost)::text AS locked_unit_cost,
              trim_scale(b.inbound_qty)::text AS inbound_qty,
              trim_scale(b.in_transit_qty)::text AS in_transit_qty,
              trim_scale(b.available_qty)::text AS available_qty,
              b.held_by_processor_id::text AS held_by_processor_id,
              b.custodian_id::text AS custodian_id
         FROM inventory_flow f
         JOIN inventory_batch b ON b.id = f.batch_id
        WHERE f.source_doc_type = 'A'
          AND f.source_doc_id = $1
        ORDER BY 2, 1`,
      [orderId],
    );
    return result.rows;
  }

  interface FeeAllocationAudit {
    basis: 'byAmount' | 'byQty';
    feeTotal: string;
    lines: {
      lineNo: number;
      qty: string;
      unitPrice: string;
      feeShare: string;
      adjustedUnitCost: string;
    }[];
  }

  async function feeAllocationOf(orderId: string): Promise<FeeAllocationAudit> {
    const result = await test.database.query<{ changes: { feeAllocation: FeeAllocationAudit } }>(
      `SELECT changes
         FROM audit_log
        WHERE object_id = $1
          AND action = 'purchase.order.complete'`,
      [orderId],
    );
    const changes = result.rows[0]?.changes;
    if (!changes?.feeAllocation) throw new Error('完成审计里没有 feeAllocation');
    return changes.feeAllocation;
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    registerServices(inventoryServices);
    await test.database.query(
      `INSERT INTO supplier
         (id, tenant_id, company_id, supplier_no, name, supplied_materials)
       VALUES ($1, $2, $3, NULL, '完成用例供应商', '{}')
       ON CONFLICT (id) DO NOTHING`,
      [SUPPLIER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO processor
         (id, tenant_id, company_id, processor_no, name, contact_name)
       VALUES ($1, $2, $3, NULL, '完成用例加工厂', '王五')
       ON CONFLICT (id) DO NOTHING`,
      [PROCESSOR_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    for (const [id, name] of [
      [PRODUCT_ID, '完成用例商品'],
      [PRODUCT_2_ID, '完成用例商品二'],
    ] as const) {
      await test.database.query(
        `INSERT INTO product
           (id, tenant_id, company_id, product_no, name, aliases, unit)
         VALUES ($1, $2, $3, NULL, $4, '{}', '件')
         ON CONFLICT (id) DO NOTHING`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, name],
      );
    }
  });

  afterAll(async () => {
    resetServices();
    await test?.database.close();
  });

  it('发货按行去向建在途批次；到货后转可用且保留加工厂持有人', async () => {
    const order = await createOne();
    const shipped = await ship(order.id, [
      { lineNo: 1, transitTo: 'processor', processorId: PROCESSOR_ID },
      { lineNo: 2, transitTo: 'warehouse' },
    ]);
    expect(shipped).toMatchObject({ status: '在途', version: 2 });

    const transitBatches = await batchesOf(order.id);
    expect(transitBatches).toHaveLength(2);
    expect(transitBatches[0]).toMatchObject({
      product_id: PRODUCT_ID,
      in_transit_qty: '2',
      available_qty: '0',
      held_by_processor_id: PROCESSOR_ID,
      custodian_id: DEMO_IDS.ownerEmployeeId,
    });
    expect(transitBatches[1]).toMatchObject({
      product_id: PRODUCT_2_ID,
      in_transit_qty: '3',
      available_qty: '0',
      held_by_processor_id: null,
      custodian_id: DEMO_IDS.ownerEmployeeId,
    });

    const received = await receive(order.id, 2);
    expect(received).toMatchObject({ status: '已完成', version: 3 });
    const arrived = await batchesOf(order.id);
    expect(arrived.map((row) => row.in_transit_qty)).toEqual(['0', '0']);
    expect(arrived.map((row) => row.available_qty)).toEqual(['2', '3']);
    expect(arrived[0]?.held_by_processor_id).toBe(PROCESSOR_ID);

    await expectAppError(revoke(order.id, 3), 'STATE_CONFLICT');
  });

  it('撤销发货把在途批次冲回，订单回到进行中并可继续改单', async () => {
    const order = await createOne();
    await ship(order.id, [{ lineNo: 1, transitTo: 'warehouse' }]);
    const revoked = await revoke(order.id, 2);
    expect(revoked).toMatchObject({ status: '进行中', version: 3 });

    const batches = await batchesOf(order.id);
    expect(batches).toHaveLength(2);
    expect(batches.every((row) => row.in_transit_qty === '0')).toBe(true);
    expect(batches.every((row) => row.inbound_qty === '0')).toBe(true);
    expect(batches.every((row) => row.available_qty === '0')).toBe(true);
    const flows = await test.database.query<{ delta: string }>(
      `SELECT trim_scale(delta)::text AS delta
         FROM inventory_flow
        WHERE source_doc_type = 'A' AND source_doc_id = $1::uuid
        ORDER BY occurred_at, id`,
      [order.id],
    );
    expect(flows.rows.map((row) => row.delta)).toEqual(['2', '3', '-2', '-3']);
  });

  it('撤销发货必须带 1–200 字原因：缺失 / 空白 / 超长在开事务前拒绝，合法原因写进审计', async () => {
    const order = await createOne();
    await ship(order.id, [{ lineNo: 1, transitTo: 'warehouse' }]);

    // D94 ⑤：`ai.reasonRequired` 只拦 AI 凭证，人工用 curl 仍可能绕过页面。
    await expect(revoke(order.id, 2, {}, null)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { header: 'X-Reason' },
    });
    await expect(revoke(order.id, 2, {}, '   ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { header: 'X-Reason' },
    });
    await expect(revoke(order.id, 2, {}, '退'.repeat(201))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { header: 'X-Reason', actualLength: 201 },
    });

    // 校验在 withAudit 之前：失败不开事务，订单仍在途、也没有撤销审计行。
    const state = await test.database.query<{ status: string }>(
      'SELECT status FROM purchase_order WHERE id = $1',
      [order.id],
    );
    expect(state.rows[0]?.status).toBe('在途');

    const revoked = await revoke(order.id, 2, {}, `  ${REVOKE_REASON}  `);
    expect(revoked).toMatchObject({ status: '进行中', version: 3 });

    const audit = await test.database.query<{ reason: string }>(
      `SELECT changes->>'reason' AS reason
         FROM audit_log
        WHERE action = 'purchase.order.ship.revoke'
          AND object_id = $1
          AND result = 'success'`,
      [order.id],
    );
    // 写进审计的是 trim 后的原因，不是原样回放头里的空白。
    expect(audit.rows[0]?.reason).toBe(REVOKE_REASON);
  });

  it('完成与到货确认收紧权限：只有 update 没有 approve/ship → 403', async () => {
    // D106：经手人自己的单可以推进，所以「没有 approve / ship」的拒绝必须换一个不是经手人的身份。
    const notHandler = {
      scope: UPDATE_ONLY_SCOPE,
      actorId: DEMO_IDS.managerEmployeeId,
      employeeId: DEMO_IDS.managerEmployeeId,
    };
    const direct = await createOne();
    await expectAppError(finish(direct.id, 1, notHandler), 'FORBIDDEN');

    const shipOnlyDenied = await createOne();
    await expectAppError(
      ship(shipOnlyDenied.id, [{ lineNo: 1, transitTo: 'warehouse' }], 1, notHandler),
      'FORBIDDEN',
    );

    const receiveDenied = await createOne();
    await ship(receiveDenied.id, [{ lineNo: 1, transitTo: 'warehouse' }]);
    await expectAppError(receive(receiveDenied.id, 2, notHandler), 'FORBIDDEN');
  });

  it('D106 经手人自带豁免：一个权限点都没有，也是自己开的单就能完成 / 发货 / 收货', async () => {
    // 一个权限点都不给：能通过只可能来自「本单经手人」这一半。
    const handlerOnly = { scope: [] as ScopeMatrix };

    const completed = await createOne();
    await expect(finish(completed.id, 1, handlerOnly)).resolves.toMatchObject({
      order: { status: '已完成' },
    });

    const shipped = await createOne();
    await ship(shipped.id, [{ lineNo: 1, transitTo: 'warehouse' }], 1, handlerOnly);
    await expect(receive(shipped.id, 2, handlerOnly)).resolves.toMatchObject({
      status: '已完成',
    });
  });

  it('完成：逐行建批次 + 入库流水，成本锁定单价、保管人=经手人、完成审计', async () => {
    const order = await createOne();
    const before = await batchCount();
    const { order: completed, headers } = await finish(order.id, 1);

    expect(completed).toMatchObject({ status: '已完成', version: 2 });
    expect(headers.ETag).toBe('"2"');
    expect(await batchCount()).toBe(before + 2);

    const rows = (
      await test.database.query(
        `SELECT b.product_id::text AS product_id,
                trim_scale(b.locked_unit_cost)::text AS locked_unit_cost,
                trim_scale(b.inbound_qty)::text AS inbound_qty,
                b.custodian_id::text AS custodian_id,
                trim_scale(f.delta)::text AS delta,
                f.source_doc_type
           FROM inventory_flow f
           JOIN inventory_batch b ON b.id = f.batch_id
          WHERE f.source_doc_id = $1
          ORDER BY b.product_id`,
        [order.id],
      )
    ).rows as {
      product_id: string;
      locked_unit_cost: string;
      inbound_qty: string;
      custodian_id: string;
      delta: string;
      source_doc_type: string;
    }[];

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => Number(row.delta))).toEqual([2, 3]);
    expect(rows.map((row) => Number(row.inbound_qty))).toEqual([2, 3]);
    expect(rows.map((row) => Number(row.locked_unit_cost))).toEqual([12.5, 1.5]);
    expect(rows.every((row) => row.source_doc_type === 'A')).toBe(true);
    expect(rows.every((row) => row.custodian_id === DEMO_IDS.ownerEmployeeId)).toBe(true);

    const audit = await test.database.query(
      `SELECT action FROM audit_log WHERE object_id = $1 AND action = 'purchase.order.complete'`,
      [order.id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('拒绝重复完成 / 旧版本 / 缺 If-Match，且不产生额外批次', async () => {
    const order = await createOne([{ productId: PRODUCT_ID, qty: '2', unitPrice: '12.5', amount: '25' }]);
    await finish(order.id, 1);
    const after = await batchCount();

    await expectAppError(finish(order.id, 1), 'VERSION_CONFLICT');
    await expectAppError(finish(order.id, 2), 'VALIDATION_FAILED');
    await expectAppError(finish(order.id, null), 'PRECONDITION_REQUIRED');
    expect(await batchCount()).toBe(after);
  });

  it('AI 凭证不能完成采购单', async () => {
    const order = await createOne([{ productId: PRODUCT_ID, qty: '2', unitPrice: '12.5', amount: '25' }]);
    const before = await batchCount();
    await expectAppError(
      finish(order.id, 1, { actorType: 'ai', credentialId: 'purchase-complete-ai-token' }),
      'AI_ACTION_FORBIDDEN',
    );
    expect(await batchCount()).toBe(before);
  });

  it('D84：单行 + 正运费，批次锁价 = (行金额 + 运费) / 数量', async () => {
    const order = await createOne(
      [{ productId: PRODUCT_ID, qty: '2', unitPrice: '12.5', amount: '25' }],
      [{ feeName: '运费', qty: '1', unitPrice: '5', amount: '5' }],
    );
    const { order: completed } = await finish(order.id, 1);

    expect(completed.status).toBe('已完成');
    const batches = await batchesOf(order.id);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ product_id: PRODUCT_ID, locked_unit_cost: '15', inbound_qty: '2' });

    const allocation = await feeAllocationOf(order.id);
    expect(allocation).toMatchObject({ basis: 'byAmount', feeTotal: '5' });
    expect(allocation.lines).toEqual([
      { lineNo: 1, qty: '2', unitPrice: '12.5', feeShare: '5', adjustedUnitCost: '15' },
    ]);
  });

  it('D84：多行按金额占比摊，末行承接余数，SUM(share) 精确等于 feeTotal', async () => {
    const order = await createOne(
      [
        { productId: PRODUCT_ID, qty: '1', unitPrice: '10', amount: '10' },
        { productId: PRODUCT_2_ID, qty: '1', unitPrice: '20', amount: '20' },
      ],
      [{ feeName: '运费', qty: '1', unitPrice: '10', amount: '10' }],
    );
    await finish(order.id, 1);

    const batches = await batchesOf(order.id);
    expect(batches.map((batch) => batch.locked_unit_cost)).toEqual(['13.333333', '26.666667']);

    const allocation = await feeAllocationOf(order.id);
    expect(allocation).toMatchObject({ basis: 'byAmount', feeTotal: '10' });
    expect(allocation.lines.map((line) => line.feeShare)).toEqual(['3.333333', '6.666667']);
    expect(allocation.lines.map((line) => line.adjustedUnitCost)).toEqual([
      '13.333333',
      '26.666667',
    ]);
  });

  it('D84：行金额合计为 0 时退化为按数量占比，末行承接余数', async () => {
    const order = await createOne(
      [
        { productId: PRODUCT_ID, qty: '2', unitPrice: '0', amount: '0' },
        { productId: PRODUCT_2_ID, qty: '3', unitPrice: '0', amount: '0' },
      ],
      [{ feeName: '装卸费', qty: '1', unitPrice: '4', amount: '4' }],
    );
    await finish(order.id, 1);

    const batches = await batchesOf(order.id);
    expect(batches.map((batch) => batch.locked_unit_cost)).toEqual(['0.8', '0.8']);
    expect(batches.map((batch) => batch.inbound_qty)).toEqual(['2', '3']);

    const allocation = await feeAllocationOf(order.id);
    expect(allocation.basis).toBe('byQty');
    expect(allocation.lines.map((line) => line.feeShare)).toEqual(['1.6', '2.4']);
  });

  it('D84 回归：无费用行时批次锁价仍等于明细单价，审计 feeTotal=0', async () => {
    const order = await createOne([
      { productId: PRODUCT_ID, qty: '2', unitPrice: '12.5', amount: '25' },
    ]);
    await finish(order.id, 1);

    const batches = await batchesOf(order.id);
    expect(batches.map((batch) => batch.locked_unit_cost)).toEqual(['12.5']);

    const allocation = await feeAllocationOf(order.id);
    expect(allocation).toMatchObject({ feeTotal: '0' });
    expect(allocation.lines.map((line) => line.feeShare)).toEqual(['0']);
    expect(allocation.lines.map((line) => line.adjustedUnitCost)).toEqual(['12.5']);
  });

  it('D84：qty=0 的行不建批次、不参与分摊', async () => {
    const order = await createOne(
      [
        { productId: PRODUCT_ID, qty: '0', unitPrice: '10', amount: '0' },
        { productId: PRODUCT_2_ID, qty: '2', unitPrice: '5', amount: '10' },
      ],
      [{ feeName: '运费', qty: '1', unitPrice: '3', amount: '3' }],
    );
    const before = await batchCount();
    await finish(order.id, 1);

    expect(await batchCount()).toBe(before + 1);
    const batches = await batchesOf(order.id);
    expect(batches).toMatchObject([
      { product_id: PRODUCT_2_ID, locked_unit_cost: '6.5', inbound_qty: '2' },
    ]);
    const allocation = await feeAllocationOf(order.id);
    expect(allocation.lines).toEqual([
      { lineNo: 2, qty: '2', unitPrice: '5', feeShare: '3', adjustedUnitCost: '6.5' },
    ]);
  });
});
