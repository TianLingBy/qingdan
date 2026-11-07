import {
  AppError,
  type SalesOrder,
  type ScopeMatrix,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../testing/pglite.js';
import { createSalesOrder } from './sales-orders.js';
import {
  createSalesReceipt,
  getSalesReceiptBlock,
} from './sales-receipts.js';

const CUSTOMER_ID = '01900000-0000-7000-8000-000000005101';
const PRODUCT_ID = '01900000-0000-7000-8000-000000005111';
const BATCH_ID = '01900000-0000-7000-8000-000000005121';
const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000005131';

const SALES_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'update', 'delete', 'view_price'] },
];
const READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'sales', actions: ['read', 'view_price'] }];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly body?: unknown;
  readonly auditReason?: string | null;
}

function makeRequest(input: FakeRequestInput): FastifyRequest {
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: {},
    body: input.body,
    headers: {},
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
  };
  return { reply: reply as unknown as FastifyReply, state };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    actorType: 'employee',
    actorId: DEMO_IDS.ownerEmployeeId,
    tenantId: DEMO_IDS.tenantId,
    employeeId: DEMO_IDS.ownerEmployeeId,
    credentialId: 'receipt-session-test',
    companyIds: [DEMO_IDS.companyId],
    scope: SALES_SCOPE,
    source: 'web',
    credentialType: 'session',
    sessionRenewed: false,
    ...overrides,
  };
}

async function expectAppError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('sales 收款记录用例（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;

  function readCtx(overrides: Partial<Principal> = {}, id = '') {
    return {
      database: test.database,
      request: makeRequest({
        principal: principal(overrides),
        params: id ? { id } : {},
      }),
    };
  }

  function writeCtx(
    id: string,
    body: unknown,
    overrides: Partial<Principal> = {},
    auditReason: string | null = null,
  ) {
    const { reply, state } = makeReply();
    return {
      ctx: {
        database: test.database,
        request: makeRequest({
          principal: principal(overrides),
          params: { id },
          body,
          auditReason,
        }),
        reply,
      },
      state,
    };
  }

  async function createOrder(): Promise<SalesOrder> {
    const { reply } = makeReply();
    return createSalesOrder({
      database: test.database,
      request: makeRequest({
        principal: principal(),
        body: {
          companyId: DEMO_IDS.companyId,
          customerId: CUSTOMER_ID,
          handlerId: DEMO_IDS.ownerEmployeeId,
          lines: [
            {
              productId: PRODUCT_ID,
              batchIds: [BATCH_ID],
              qty: '2',
              unitPrice: '15',
              amount: '999',
            },
          ],
          fees: [],
        },
      }),
      reply,
    });
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '收款二司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, status)
       VALUES ($1, $2, $3, NULL, '收款测试客户', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '收款测试商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'RECEIPT-TEST', '10', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
  });

  afterAll(async () => {
    await test?.database.close();
  });

  it('追加收款与退款：负数行、SQL 余额、稳定列表与成功审计', async () => {
    const order = await createOrder();
    const payment = writeCtx(order.id, {
      direction: '收款',
      amount: '25',
      method: '线下转账',
      occurredAt: '2026-11-05T02:00:00.000Z',
      remark: '首款',
    });
    const receipt = await createSalesReceipt(payment.ctx);
    expect(payment.state.statusCode).toBe(201);
    expect(receipt).toMatchObject({
      salesOrderId: order.id,
      companyId: DEMO_IDS.companyId,
      direction: '收款',
      amount: '25',
      method: '线下转账',
      version: 1,
    });

    const refund = writeCtx(order.id, {
      direction: '退款',
      amount: '-10',
      method: '原路退款',
      occurredAt: '2026-11-05T03:00:00.000Z',
      remark: '仅退款（纠收款）',
    });
    await createSalesReceipt(refund.ctx);

    const block = await getSalesReceiptBlock(readCtx({}, order.id));
    expect(block.receipts.map((row) => row.amount)).toEqual(['25', '-10']);
    expect(block.receiptBalance).toBe('15');

    const audits = await test.database.query<{
      action: string;
      result: string;
      company_id: string;
    }>(
      `SELECT action, result, company_id
         FROM audit_log
        WHERE object_id IN ($1, $2)
        ORDER BY occurred_at, id`,
      [receipt.id, block.receipts[1]?.id],
    );
    expect(audits.rows).toEqual([
      {
        action: 'sales.receipt.create',
        result: 'success',
        company_id: DEMO_IDS.companyId,
      },
      {
        action: 'sales.receipt.create',
        result: 'success',
        company_id: DEMO_IDS.companyId,
      },
    ]);
  });

  it('权限 / 公司隔离 / 已取消 / AI / 金额方向均拒绝且不落业务行', async () => {
    const order = await createOrder();
    const payload = {
      direction: '收款',
      amount: '1',
      method: '线下转账',
      occurredAt: '2026-11-05T02:00:00.000Z',
    };

    await expectAppError(
      createSalesReceipt(
        writeCtx(order.id, payload, { scope: READ_ONLY_SCOPE }).ctx,
      ),
      'FORBIDDEN',
    );
    await expectAppError(
      getSalesReceiptBlock(
        readCtx({ companyIds: [OTHER_COMPANY_ID] }, order.id),
      ),
      'NOT_FOUND',
    );
    await expectAppError(
      createSalesReceipt(
        writeCtx(
          order.id,
          payload,
          { actorType: 'ai', credentialId: 'receipt-ai-token' },
          'AI 尝试追加收款',
        ).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );
    await expectAppError(
      createSalesReceipt(
        writeCtx(order.id, { ...payload, amount: '-1' }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await test.database.query(
      `UPDATE sales_order SET status = '已取消' WHERE id = $1`,
      [order.id],
    );
    await expectAppError(
      createSalesReceipt(writeCtx(order.id, payload).ctx),
      'VALIDATION_FAILED',
    );

    const persisted = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sales_receipt
        WHERE sales_order_id = $1`,
      [order.id],
    );
    expect(persisted.rows[0]?.count).toBe('0');
  });
});
