import { registerServices, resetServices } from '../../../platform/services/registry.js';
import { inventoryServices } from '../../inventory/services/ports.js';
import { AppError, type PurchaseOrder, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import { completePurchaseOrder, createPurchaseOrder } from './purchase-orders.js';

/**
 * 采购单 A 完成（#99 A 链路）：逐行建批次 + 入库流水，成本锁定为明细单价。
 *
 * 断言覆盖库存、流水、批次成本、审计四项；重复完成/旧版本/AI 凭证必须被拒且无副作用。
 */

const SUPPLIER_ID = '01900000-0000-7000-8000-000000000301';
const PRODUCT_ID = '01900000-0000-7000-8000-000000000311';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000000312';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'purchase', actions: ['read', 'create', 'update', 'delete', 'view_price'] },
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
    auditReason: null,
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

  async function batchCount(): Promise<number> {
    const result = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_batch`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    registerServices(inventoryServices);
    await test.database.query(
      `INSERT INTO supplier
         (id, tenant_id, company_id, supplier_no, name, supplied_materials, status)
       VALUES ($1, $2, $3, NULL, '完成用例供应商', '{}', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [SUPPLIER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    for (const [id, name] of [
      [PRODUCT_ID, '完成用例商品'],
      [PRODUCT_2_ID, '完成用例商品二'],
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
    resetServices();
    await test?.database.close();
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
});
