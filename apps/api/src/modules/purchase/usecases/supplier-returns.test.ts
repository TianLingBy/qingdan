import {
  AppError,
  type ScopeMatrix,
  type SupplierReturn,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import {
  createSupplierReturn,
  getSupplierReturn,
  listSupplierReturns,
} from './supplier-returns.js';

/**
 * S 供应商退货用例（F4c / D15 / D16 / D21 / D47 / D51 / D52 / D54）。
 *
 * 覆盖：
 *   - create → 201、S 单号、SQL 计算明细金额并由 SQL 聚合 refundAmount；
 *   - 权限不足 / 跨公司 / AI 危险动作拒绝；
 *   - 成功审计落 audit_log；普通读不记；
 *   - list / detail 按原 A 单、状态、单号过滤，跨公司不可见。
 */

const SUPPLIER_ID = '01900000-0000-7000-8000-000000000501';
const SECOND_SUPPLIER_ID = '01900000-0000-7000-8000-000000000502';
const PRODUCT_ID = '01900000-0000-7000-8000-000000000511';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000000512';
const BATCH_ID = '01900000-0000-7000-8000-000000000521';
const BATCH_2_ID = '01900000-0000-7000-8000-000000000522';
const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000503';
const PURCHASE_ORDER_ID = '01900000-0000-7000-8000-000000000531';
const SECOND_PURCHASE_ORDER_ID = '01900000-0000-7000-8000-000000000532';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'supplier_return', actions: ['read', 'create'] },
];
const READ_ONLY_SCOPE: ScopeMatrix = [
  { domain: 'supplier_return', actions: ['read'] },
];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly auditReason?: string | null;
}

let requestSequence = 0;

function makeRequest(input: FakeRequestInput): FastifyRequest {
  requestSequence += 1;
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
    headers: {
      'x-request-id': `req-supplier-return-${requestSequence}`,
    },
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
    credentialId: 'session-supplier-return-test',
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
    credentialId: 'ai-token-supplier-return-test',
    credentialType: 'api_token',
    ...overrides,
  });
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

const CREATE_BODY = {
  companyId: DEMO_IDS.companyId,
  originalPurchaseOrderId: PURCHASE_ORDER_ID,
  lines: [
    {
      productId: PRODUCT_ID,
      batchIds: [BATCH_ID],
      qty: '2',
      unitPrice: '12.5',
      // 客户端金额故意错误：落库与响应必须使用服务端 qty × unit_price。
      amount: '999',
    },
    {
      productId: PRODUCT_2_ID,
      batchIds: [BATCH_2_ID],
      qty: '3',
      unitPrice: '1.5',
      amount: '0',
    },
  ],
  // 客户端应退金额同样故意错误：必须由 SQL 聚合覆盖为 29.5。
  refundAmount: '999',
};

describe('purchase S 供应商退货用例（PGlite + seed 演示租户）', () => {
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

  async function createOne(input: Record<string, unknown> = {}): Promise<SupplierReturn> {
    const { ctx, state } = writeCtx({}, {
      body: {
        ...CREATE_BODY,
        ...input,
      },
    });
    const created = await createSupplierReturn(ctx);
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
      [SECOND_COMPANY_ID, DEMO_IDS.tenantId],
    );
    for (const [id, companyId, name] of [
      [SUPPLIER_ID, DEMO_IDS.companyId, '供应商退货供应商'],
      [SECOND_SUPPLIER_ID, SECOND_COMPANY_ID, '二司供应商'],
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
      [PRODUCT_ID, '供应商退货商品'],
      [PRODUCT_2_ID, '供应商退货商品二'],
    ] as const) {
      await test.database.query(
        `INSERT INTO product
           (id, tenant_id, company_id, product_no, name, aliases, unit, status)
         VALUES ($1, $2, $3, NULL, $4, '{}', '件', '启用')
         ON CONFLICT (id) DO NOTHING`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, name],
      );
    }

    for (const [id, companyId, supplierId, orderNo] of [
      [PURCHASE_ORDER_ID, DEMO_IDS.companyId, SUPPLIER_ID, 'A-TEST-SR-0001'],
      [SECOND_PURCHASE_ORDER_ID, SECOND_COMPANY_ID, SECOND_SUPPLIER_ID, 'A-TEST-SR-0002'],
    ] as const) {
      await test.database.query(
        `INSERT INTO purchase_order
           (id, tenant_id, company_id, order_no, supplier_id, handler_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, '进行中')`,
        [id, DEMO_IDS.tenantId, companyId, orderNo, supplierId, DEMO_IDS.ownerEmployeeId],
      );
    }
    await test.database.query(
      `INSERT INTO purchase_order_line
         (id, tenant_id, company_id, order_id, line_no, product_id, qty, unit_price, amount)
       VALUES ($1, $2, $3, $4, 1, $5, '2', '12.5', '25')`,
      [
        '01900000-0000-7000-8000-000000000541',
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PURCHASE_ORDER_ID,
        PRODUCT_ID,
      ],
    );

    for (const [id, productId, batchNo] of [
      [BATCH_ID, PRODUCT_ID, 'SR-BATCH-0001'],
      [BATCH_2_ID, PRODUCT_2_ID, 'SR-BATCH-0002'],
    ] as const) {
      await test.database.query(
        `INSERT INTO inventory_batch
           (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
            inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
         VALUES ($1, $2, $3, $4, $5, '10', '20', '0', '0', '0', $6)`,
        [
          id,
          DEMO_IDS.tenantId,
          DEMO_IDS.companyId,
          productId,
          batchNo,
          DEMO_IDS.ownerEmployeeId,
        ],
      );
    }
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('登记退货：201、S 单号、金额由 SQL 计算 / 聚合、审计落库', async () => {
    const created = await createOne();

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.tenantId).toBe(DEMO_IDS.tenantId);
    expect(created.companyId).toBe(DEMO_IDS.companyId);
    expect(created.returnNo).toMatch(/^S-0001-\d{8}-\d{4}$/);
    expect(created.originalPurchaseOrderId).toBe(PURCHASE_ORDER_ID);
    expect(created.status).toBe('进行中');
    expect(created.version).toBe(1);
    expect(created.remark).toBeNull();
    expect(created.refundAmount).toBe('29.5');
    expect(created.lines).toHaveLength(2);
    expect(created.lines[0]).toMatchObject({
      productId: PRODUCT_ID,
      batchIds: [BATCH_ID],
      qty: '2',
      unitPrice: '12.5',
      amount: '25',
    });
    expect(created.lines[1]).toMatchObject({
      productId: PRODUCT_2_ID,
      batchIds: [BATCH_2_ID],
      qty: '3',
      unitPrice: '1.5',
      amount: '4.5',
    });

    const audit = await test.database.query<{
      action: string;
      object_type: string;
      result: string;
      changes: { refundAmount?: string };
    }>(
      `SELECT action, object_type, result, changes
         FROM audit_log
        WHERE object_id = $1`,
      [created.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'supplier_return.create',
      object_type: 'supplier_return',
      result: 'success',
    });
    expect(audit.rows[0]?.changes.refundAmount).toBe('29.5');
  });

  it('列表 / 详情：按原 A 单、状态、单号过滤；跨公司不可见；普通读不记审计', async () => {
    const created = await createOne();

    const detail = await getSupplierReturn(
      readCtx({}, { params: { id: created.id } }),
    );
    expect(detail.id).toBe(created.id);
    expect(detail.lines).toHaveLength(2);

    const list = await listSupplierReturns(
      readCtx({}, {
        query: {
          originalPurchaseOrderId: PURCHASE_ORDER_ID,
          status: '进行中',
          keyword: created.returnNo,
        },
      }),
    );
    expect(list.items.map((item) => item.id)).toContain(created.id);
    expect(list.items.find((item) => item.id === created.id)?.lines).toHaveLength(2);

    const outside = principal({ companyIds: [SECOND_COMPANY_ID] });
    await expectAppError(
      getSupplierReturn(readCtx(outside, { params: { id: created.id } })),
      'NOT_FOUND',
    );
    const outsideList = await listSupplierReturns(
      readCtx(outside, { query: { keyword: created.returnNo } }),
    );
    expect(outsideList.items).toHaveLength(0);

    const reads = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action IN ('supplier_return.list.read', 'supplier_return.detail.read')`,
    );
    expect(reads.rows[0]?.count).toBe('0');
  });

  it('权限拒绝、跨公司原 A 单、批次商品不一致、AI 无原因 / 有原因均拒绝', async () => {
    const before = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action = 'supplier_return.create'`,
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({ scope: READ_ONLY_SCOPE }, { body: CREATE_BODY }).ctx,
      ),
      'FORBIDDEN',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({ companyIds: [SECOND_COMPANY_ID] }, { body: CREATE_BODY }).ctx,
      ),
      'FORBIDDEN',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({}, {
          body: {
            ...CREATE_BODY,
            originalPurchaseOrderId: SECOND_PURCHASE_ORDER_ID,
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({}, {
          body: {
            ...CREATE_BODY,
            lines: [
              {
                ...CREATE_BODY.lines[0],
                batchIds: [BATCH_2_ID],
              },
            ],
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({}, {
          principal: aiPrincipal(),
          body: CREATE_BODY,
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createSupplierReturn(
        writeCtx({}, {
          principal: aiPrincipal(),
          auditReason: 'AI 尝试登记供应商退货',
          body: CREATE_BODY,
        }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    const after = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action = 'supplier_return.create'`,
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
