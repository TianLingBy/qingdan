import {
  AppError,
  encodeCursor,
  type ScopeMatrix,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import { getBatch, listBatches } from './batches.js';
import { listFlows } from './flows.js';

const COMPANY_2_ID = '01900000-0000-7000-8000-000000000099';
const PRODUCT_1_ID = '01900000-0000-7000-8000-000000000101';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000000102';
const PRODUCT_3_ID = '01900000-0000-7000-8000-000000000103';
const BATCH_1_ID = '01900000-0000-7000-8000-000000000111';
const BATCH_2_ID = '01900000-0000-7000-8000-000000000112';
const BATCH_3_ID = '01900000-0000-7000-8000-000000000113';
const FLOW_1_ID = '01900000-0000-7000-8000-000000000121';
const FLOW_2_ID = '01900000-0000-7000-8000-000000000122';
const FLOW_3_ID = '01900000-0000-7000-8000-000000000123';
const SOURCE_1_ID = '01900000-0000-7000-8000-000000000131';
const SOURCE_2_ID = '01900000-0000-7000-8000-000000000132';
const SOURCE_3_ID = '01900000-0000-7000-8000-000000000133';

const INVENTORY_SCOPE: ScopeMatrix = [
  { domain: 'inventory_qty', actions: ['read'] },
  { domain: 'inventory_flow', actions: ['read'] },
];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
}

function makeRequest(input: FakeRequestInput): FastifyRequest {
  return {
    principal: input.principal,
    params: input.params ?? {},
    query: input.query ?? {},
    headers: {},
    ip: '127.0.0.1',
    auditSource: 'web',
    auditReason: null,
  } as unknown as FastifyRequest;
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    actorType: 'employee',
    actorId: DEMO_IDS.ownerEmployeeId,
    tenantId: DEMO_IDS.tenantId,
    employeeId: DEMO_IDS.ownerEmployeeId,
    credentialId: 'session-inventory-test',
    companyIds: [DEMO_IDS.companyId, COMPANY_2_ID],
    scope: INVENTORY_SCOPE,
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

async function insertProduct(
  test: TestDatabase,
  id: string,
  companyId: string,
  name: string,
  productNo: string,
): Promise<void> {
  await test.database.query(
    `INSERT INTO product
       (id, tenant_id, company_id, product_no, name, aliases, specification, unit, status)
     VALUES ($1, $2, $3, $4, $5, '{}', NULL, '件', '启用')`,
    [id, DEMO_IDS.tenantId, companyId, productNo, name],
  );
}

async function insertBatch(
  test: TestDatabase,
  input: {
    id: string;
    companyId: string;
    productId: string;
    batchNo: string;
    inboundQty: string;
    referencedQty: string;
    inTransitQty: string;
    pendingExecutionQty: string;
  },
): Promise<void> {
  await test.database.query(
    `INSERT INTO inventory_batch
       (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
        inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
     VALUES ($1, $2, $3, $4, $5, '12.500000', $6, $7, $8, $9, $10)`,
    [
      input.id,
      DEMO_IDS.tenantId,
      input.companyId,
      input.productId,
      input.batchNo,
      input.inboundQty,
      input.referencedQty,
      input.inTransitQty,
      input.pendingExecutionQty,
      DEMO_IDS.ownerEmployeeId,
    ],
  );
}

async function insertFlow(
  test: TestDatabase,
  id: string,
  companyId: string,
  batchId: string,
  delta: string,
  sourceDocType: string,
  sourceDocId: string,
  occurredAt: string,
): Promise<void> {
  await test.database.query(
    `INSERT INTO inventory_flow
       (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id,
        handled_by, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      DEMO_IDS.tenantId,
      companyId,
      batchId,
      delta,
      sourceDocType,
      sourceDocId,
      DEMO_IDS.ownerEmployeeId,
      occurredAt,
    ],
  );
}

describe('inventory 只读用例（PGlite + 0008）', () => {
  let test: TestDatabase;

  function readCtx(
    overrides: Partial<Principal> = {},
    parts: Partial<FakeRequestInput> = {},
  ) {
    return {
      database: test.database,
      request: makeRequest({ principal: principal(overrides), ...parts }),
    };
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY_2_ID, DEMO_IDS.tenantId],
    );
    await insertProduct(test, PRODUCT_1_ID, DEMO_IDS.companyId, '红富士苹果', 'P-001');
    await insertProduct(test, PRODUCT_2_ID, DEMO_IDS.companyId, '青梨', 'P-002');
    await insertProduct(test, PRODUCT_3_ID, COMPANY_2_ID, '二司香蕉', 'P-003');
    await insertBatch(test, {
      id: BATCH_1_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_1_ID,
      batchNo: 'BATCH-A-0001',
      inboundQty: '100',
      referencedQty: '10',
      inTransitQty: '5',
      pendingExecutionQty: '5',
    });
    await insertBatch(test, {
      id: BATCH_2_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_2_ID,
      batchNo: 'BATCH-B-0002',
      inboundQty: '30',
      referencedQty: '3',
      inTransitQty: '2',
      pendingExecutionQty: '1',
    });
    await insertBatch(test, {
      id: BATCH_3_ID,
      companyId: COMPANY_2_ID,
      productId: PRODUCT_3_ID,
      batchNo: 'BATCH-C-0003',
      inboundQty: '20',
      referencedQty: '2',
      inTransitQty: '0',
      pendingExecutionQty: '0',
    });
    await insertFlow(
      test,
      FLOW_1_ID,
      DEMO_IDS.companyId,
      BATCH_1_ID,
      '100',
      'A',
      SOURCE_1_ID,
      '2026-11-05T00:00:01.000Z',
    );
    await insertFlow(
      test,
      FLOW_2_ID,
      DEMO_IDS.companyId,
      BATCH_1_ID,
      '-10',
      'E',
      SOURCE_2_ID,
      '2026-11-05T00:00:02.000Z',
    );
    await insertFlow(
      test,
      FLOW_3_ID,
      COMPANY_2_ID,
      BATCH_3_ID,
      '-2',
      'N',
      SOURCE_3_ID,
      '2026-11-05T00:00:03.000Z',
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('批次列表/详情：D38 四列来自生成列，数量保持 decimal 字符串', async () => {
    const page = await listBatches(readCtx());
    expect(page.items.map((item) => item.id)).toEqual([BATCH_3_ID, BATCH_2_ID, BATCH_1_ID]);

    const batch = page.items.find((item) => item.id === BATCH_1_ID)!;
    expect(Number(batch.inboundQty)).toBe(100);
    expect(Number(batch.referencedQty)).toBe(10);
    expect(Number(batch.remainingQty)).toBe(90);
    expect(Number(batch.inTransitQty)).toBe(5);
    expect(Number(batch.pendingExecutionQty)).toBe(5);
    expect(Number(batch.availableQty)).toBe(80);
    expect(typeof batch.lockedUnitCost).toBe('string');

    const detail = await getBatch(readCtx({}, { params: { id: BATCH_1_ID } }));
    expect(detail).toMatchObject({
      id: BATCH_1_ID,
      productName: '红富士苹果',
      productNo: 'P-001',
      pendingOccupancies: [],
    });
  });

  it('批次筛选与游标分页：商品/关键字可查，两页无重叠', async () => {
    const byName = await listBatches(readCtx({}, { query: { keyword: '苹果' } }));
    expect(byName.items.map((item) => item.id)).toEqual([BATCH_1_ID]);

    const byBatchNo = await listBatches(readCtx({}, { query: { keyword: 'BATCH-B' } }));
    expect(byBatchNo.items.map((item) => item.id)).toEqual([BATCH_2_ID]);

    const byProduct = await listBatches(readCtx({}, { query: { productId: PRODUCT_2_ID } }));
    expect(byProduct.items.map((item) => item.id)).toEqual([BATCH_2_ID]);

    const first = await listBatches(readCtx({}, { query: { limit: 2 } }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listBatches(
      readCtx({}, { query: { limit: 2, cursor: first.nextCursor } }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).toBe(BATCH_1_ID);
  });

  it('D15：公司集合之外的批次在列表不可见、详情按不存在处理', async () => {
    const companyOneOnly = principal({ companyIds: [DEMO_IDS.companyId] });

    const list = await listBatches({
      database: test.database,
      request: makeRequest({ principal: companyOneOnly }),
    });
    expect(list.items.map((item) => item.id)).toEqual([BATCH_2_ID, BATCH_1_ID]);

    const explicit = await listBatches({
      database: test.database,
      request: makeRequest({
        principal: companyOneOnly,
        query: { companyId: COMPANY_2_ID },
      }),
    });
    expect(explicit.items).toEqual([]);

    await expectAppError(
      getBatch({
        database: test.database,
        request: makeRequest({
          principal: companyOneOnly,
          params: { id: BATCH_3_ID },
        }),
      }),
      'NOT_FOUND',
    );
  });

  it('权限：批次与流水分别校验 inventory_qty.read / inventory_flow.read', async () => {
    const qtyOnly: ScopeMatrix = [{ domain: 'inventory_qty', actions: ['read'] }];

    await expect(listBatches(readCtx({ scope: qtyOnly }))).resolves.toBeDefined();

    const unrelated: ScopeMatrix = [{ domain: 'product', actions: ['read'] }];
    await expectAppError(listBatches(readCtx({ scope: unrelated })), 'FORBIDDEN');
    await expectAppError(listFlows(readCtx({ scope: qtyOnly })), 'FORBIDDEN');
  });

  it('流水：按时间倒序、支持批次/来源过滤与游标分页', async () => {
    const page = await listFlows(readCtx());
    expect(page.items.map((item) => item.id)).toEqual([FLOW_3_ID, FLOW_2_ID, FLOW_1_ID]);

    const byBatch = await listFlows(readCtx({}, { query: { batchId: BATCH_1_ID } }));
    expect(byBatch.items.map((item) => item.id)).toEqual([FLOW_2_ID, FLOW_1_ID]);

    const bySource = await listFlows(
      readCtx({}, { query: { sourceDocType: 'E', sourceDocId: SOURCE_2_ID } }),
    );
    expect(bySource.items.map((item) => item.id)).toEqual([FLOW_2_ID]);

    const first = await listFlows(readCtx({}, { query: { limit: 2 } }));
    expect(first.items.map((item) => item.id)).toEqual([FLOW_3_ID, FLOW_2_ID]);
    const second = await listFlows(
      readCtx({}, { query: { limit: 2, cursor: first.nextCursor } }),
    );
    expect(second.items.map((item) => item.id)).toEqual([FLOW_1_ID]);
  });

  it('参数：非法 id / 游标 / limit → 422；无数据库 → 501', async () => {
    await expectAppError(
      getBatch(readCtx({}, { params: { id: 'not-a-uuid' } })),
      'VALIDATION_FAILED',
    );
    const badCursor = encodeCursor({
      createdAt: '2026-11-05T00:00:00.000Z',
      id: 'not-a-uuid',
    });
    await expectAppError(
      listBatches(readCtx({}, { query: { cursor: badCursor } })),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      listBatches(readCtx({}, { query: { limit: 0 } })),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      listBatches({ database: null, request: makeRequest({ principal: principal() }) }),
      'NOT_IMPLEMENTED',
    );
    await expectAppError(
      getBatch({
        database: null,
        request: makeRequest({ principal: principal(), params: { id: BATCH_1_ID } }),
      }),
      'NOT_IMPLEMENTED',
    );
    await expectAppError(
      listFlows({ database: null, request: makeRequest({ principal: principal() }) }),
      'NOT_IMPLEMENTED',
    );
  });

  it('普通读不产生审计', async () => {
    const before = await test.database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1',
      [DEMO_IDS.tenantId],
    );
    await listBatches(readCtx());
    await getBatch(readCtx({}, { params: { id: BATCH_1_ID } }));
    await listFlows(readCtx());
    const after = await test.database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = $1',
      [DEMO_IDS.tenantId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
