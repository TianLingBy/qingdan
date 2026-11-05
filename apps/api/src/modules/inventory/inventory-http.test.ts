import type {
  InventoryBatch,
  InventoryBatchDetail,
  InventoryFlow,
} from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
const SALES_PHONE = '10000000003';
const WAREHOUSE_PHONE = '10000000004';

const COMPANY_2_ID = '01900000-0000-7000-8000-000000000299';
const PRODUCT_1_ID = '01900000-0000-7000-8000-000000000201';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000000202';
const PRODUCT_3_ID = '01900000-0000-7000-8000-000000000203';
const BATCH_1_ID = '01900000-0000-7000-8000-000000000211';
const BATCH_2_ID = '01900000-0000-7000-8000-000000000212';
const BATCH_3_ID = '01900000-0000-7000-8000-000000000213';
const FLOW_1_ID = '01900000-0000-7000-8000-000000000221';
const FLOW_2_ID = '01900000-0000-7000-8000-000000000222';
const FLOW_3_ID = '01900000-0000-7000-8000-000000000223';
const SOURCE_1_ID = '01900000-0000-7000-8000-000000000231';
const SOURCE_2_ID = '01900000-0000-7000-8000-000000000232';
const SOURCE_3_ID = '01900000-0000-7000-8000-000000000233';

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

async function login(app: FastifyInstance, phone: string, requestId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
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
     VALUES ($1, $2, $3, $4, $5, '18.750000', $6, $7, $8, $9, $10)`,
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

describe('inventory HTTP 只读切片（PGlite + 0008）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;
  let warehouseCookie: string;

  async function listBatchesRequest(
    cookie: string,
    requestId: string,
    query = '',
  ) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/inventory/batches${query}`,
      headers: readHeaders(cookie, requestId),
    });
  }

  async function listFlowsRequest(
    cookie: string,
    requestId: string,
    query = '',
  ) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/inventory/flows${query}`,
      headers: readHeaders(cookie, requestId),
    });
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
    await insertProduct(test, PRODUCT_1_ID, DEMO_IDS.companyId, 'HTTP红富士苹果', 'HP-001');
    await insertProduct(test, PRODUCT_2_ID, DEMO_IDS.companyId, 'HTTP青梨', 'HP-002');
    await insertProduct(test, PRODUCT_3_ID, COMPANY_2_ID, 'HTTP二司香蕉', 'HP-003');
    await insertBatch(test, {
      id: BATCH_1_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_1_ID,
      batchNo: 'HTTP-BATCH-A-0001',
      inboundQty: '100',
      referencedQty: '10',
      inTransitQty: '5',
      pendingExecutionQty: '5',
    });
    await insertBatch(test, {
      id: BATCH_2_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_2_ID,
      batchNo: 'HTTP-BATCH-B-0002',
      inboundQty: '30',
      referencedQty: '3',
      inTransitQty: '2',
      pendingExecutionQty: '1',
    });
    await insertBatch(test, {
      id: BATCH_3_ID,
      companyId: COMPANY_2_ID,
      productId: PRODUCT_3_ID,
      batchNo: 'HTTP-BATCH-C-0003',
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
      '2026-11-05T01:00:01.000Z',
    );
    await insertFlow(
      test,
      FLOW_2_ID,
      DEMO_IDS.companyId,
      BATCH_1_ID,
      '-10',
      'E',
      SOURCE_2_ID,
      '2026-11-05T01:00:02.000Z',
    );
    await insertFlow(
      test,
      FLOW_3_ID,
      COMPANY_2_ID,
      BATCH_3_ID,
      '-2',
      'N',
      SOURCE_3_ID,
      '2026-11-05T01:00:03.000Z',
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-inventory-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-inventory-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-inventory-login-sales');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-inventory-login-warehouse');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 → 401 UNAUTHENTICATED', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/batches',
      headers: { 'x-request-id': 'req-inventory-anonymous' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('批次列表与详情：返回 D38 四列、商品信息和详情 ETag', async () => {
    const list = await listBatchesRequest(ownerCookie, 'req-inventory-list-all');
    expect(list.statusCode).toBe(200);
    const page = list.json() as {
      items: InventoryBatch[];
      nextCursor: string | null;
    };
    expect(page.items.map((item) => item.id)).toEqual([BATCH_3_ID, BATCH_2_ID, BATCH_1_ID]);

    const batch = page.items.find((item) => item.id === BATCH_1_ID)!;
    expect(batch).toMatchObject({
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_1_ID,
      batchNo: 'HTTP-BATCH-A-0001',
      version: 1,
    });
    expect(Number(batch.remainingQty)).toBe(90);
    expect(Number(batch.availableQty)).toBe(80);
    expect(typeof batch.availableQty).toBe('string');

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/batches/${BATCH_1_ID}`,
      headers: readHeaders(ownerCookie, 'req-inventory-detail'),
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.headers.etag).toBe('"1"');
    expect(detailResponse.json()).toMatchObject({
      id: BATCH_1_ID,
      productName: 'HTTP红富士苹果',
      productNo: 'HP-001',
      pendingOccupancies: [],
    } satisfies Partial<InventoryBatchDetail>);
  });

  it('批次筛选、分页与参数错误', async () => {
    const byName = await listBatchesRequest(
      ownerCookie,
      'req-inventory-filter-name',
      `?keyword=${encodeURIComponent('红富士')}`,
    );
    expect((byName.json() as { items: InventoryBatch[] }).items.map((item) => item.id)).toEqual([
      BATCH_1_ID,
    ]);

    const byBatchNo = await listBatchesRequest(
      ownerCookie,
      'req-inventory-filter-batch-no',
      `?keyword=HTTP-BATCH-B`,
    );
    expect((byBatchNo.json() as { items: InventoryBatch[] }).items.map((item) => item.id)).toEqual([
      BATCH_2_ID,
    ]);

    const first = await listBatchesRequest(
      ownerCookie,
      'req-inventory-page-1',
      '?limit=2',
    );
    const firstPage = first.json() as { items: InventoryBatch[]; nextCursor: string | null };
    expect(firstPage.items.map((item) => item.id)).toEqual([BATCH_3_ID, BATCH_2_ID]);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await listBatchesRequest(
      ownerCookie,
      'req-inventory-page-2',
      `?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect((second.json() as { items: InventoryBatch[] }).items.map((item) => item.id)).toEqual([
      BATCH_1_ID,
    ]);

    for (const query of ['?limit=0', '?companyId=not-a-uuid', '?cursor=not-base64']) {
      const invalid = await listBatchesRequest(ownerCookie, 'req-inventory-invalid', query);
      expect(invalid.statusCode, query).toBe(422);
      expect(invalid.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }

    const badDetail = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/batches/not-a-uuid',
      headers: readHeaders(ownerCookie, 'req-inventory-bad-id'),
    });
    expect(badDetail.statusCode).toBe(422);
    expect(badDetail.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('D15：销售只见本公司批次，跨公司详情 404、显式跨公司列表为空', async () => {
    const list = await listBatchesRequest(salesCookie, 'req-inventory-sales-list');
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: InventoryBatch[] }).items.map((item) => item.id)).toEqual([
      BATCH_2_ID,
      BATCH_1_ID,
    ]);

    const crossDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/batches/${BATCH_3_ID}`,
      headers: readHeaders(salesCookie, 'req-inventory-cross-detail'),
    });
    expect(crossDetail.statusCode).toBe(404);
    expect(crossDetail.json()).toMatchObject({ code: 'NOT_FOUND' });

    const explicit = await listBatchesRequest(
      salesCookie,
      'req-inventory-cross-list',
      `?companyId=${COMPANY_2_ID}`,
    );
    expect((explicit.json() as { items: InventoryBatch[] }).items).toEqual([]);
  });

  it('权限：销售可看批次但不可看流水，仓管可看两者', async () => {
    expect((await listBatchesRequest(salesCookie, 'req-inventory-sales-qty')).statusCode).toBe(200);

    const salesFlows = await listFlowsRequest(salesCookie, 'req-inventory-sales-flows');
    expect(salesFlows.statusCode).toBe(403);
    expect(salesFlows.json()).toMatchObject({ code: 'FORBIDDEN' });

    const warehouseBatches = await listBatchesRequest(
      warehouseCookie,
      'req-inventory-warehouse-qty',
    );
    expect(warehouseBatches.statusCode).toBe(200);

    const warehouseFlows = await listFlowsRequest(
      warehouseCookie,
      'req-inventory-warehouse-flows',
    );
    expect(warehouseFlows.statusCode).toBe(200);
  });

  it('流水：倒序、筛选与 cursor 分页', async () => {
    const all = await listFlowsRequest(ownerCookie, 'req-inventory-flows-all');
    expect(all.statusCode).toBe(200);
    const page = all.json() as { items: InventoryFlow[]; nextCursor: string | null };
    expect(page.items.map((item) => item.id)).toEqual([FLOW_3_ID, FLOW_2_ID, FLOW_1_ID]);
    expect(page.items[0]).toMatchObject({
      companyId: COMPANY_2_ID,
      batchId: BATCH_3_ID,
      sourceDocType: 'N',
      sourceDocId: SOURCE_3_ID,
    });
    expect(typeof page.items[0]?.delta).toBe('string');

    const byBatch = await listFlowsRequest(
      ownerCookie,
      'req-inventory-flows-batch',
      `?batchId=${BATCH_1_ID}`,
    );
    expect((byBatch.json() as { items: InventoryFlow[] }).items.map((item) => item.id)).toEqual([
      FLOW_2_ID,
      FLOW_1_ID,
    ]);

    const bySource = await listFlowsRequest(
      ownerCookie,
      'req-inventory-flows-source',
      `?sourceDocType=E&sourceDocId=${SOURCE_2_ID}`,
    );
    expect((bySource.json() as { items: InventoryFlow[] }).items.map((item) => item.id)).toEqual([
      FLOW_2_ID,
    ]);

    const first = await listFlowsRequest(
      ownerCookie,
      'req-inventory-flows-page-1',
      '?limit=2',
    );
    const firstPage = first.json() as { items: InventoryFlow[]; nextCursor: string | null };
    expect(firstPage.items.map((item) => item.id)).toEqual([FLOW_3_ID, FLOW_2_ID]);
    const second = await listFlowsRequest(
      ownerCookie,
      'req-inventory-flows-page-2',
      `?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect((second.json() as { items: InventoryFlow[] }).items.map((item) => item.id)).toEqual([
      FLOW_1_ID,
    ]);
  });
});
