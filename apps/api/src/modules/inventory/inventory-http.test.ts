import type {
  InventoryBatch,
  InventoryBatchDetail,
  InventoryFlow,
  Stocktake,
  StocktakeDetail,
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

const STOCK_BATCH_SURPLUS_ID = '01900000-0000-7000-8000-000000000241';
const STOCK_BATCH_SHORTAGE_ID = '01900000-0000-7000-8000-000000000242';
const STOCK_BATCH_TIGHT_ID = '01900000-0000-7000-8000-000000000243';
const STOCK_BATCH_APPROVE_ID = '01900000-0000-7000-8000-000000000244';
const STOCKTAKE_COMPANY2_ID = '01900000-0000-7000-8000-000000000251';
const STOCKTAKE_DETAIL_ID = '01900000-0000-7000-8000-000000000252';
const STOCKTAKE_APPROVE_ID = '01900000-0000-7000-8000-000000000253';
const STOCKTAKE_SHORTAGE_ID = '01900000-0000-7000-8000-000000000254';
const STOCKTAKE_TIGHT_ID = '01900000-0000-7000-8000-000000000255';

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(
  cookie: string,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie,
    origin: PUBLIC_BASE_URL,
    'x-request-id': requestId,
    ...extra,
  };
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

async function insertStocktakeRow(
  test: TestDatabase,
  input: {
    id: string;
    companyId: string;
    stocktakeNo: string;
    batchId: string;
    bookQty: string;
    actualQty: string;
    status?: '待审批' | '已批准' | '已驳回';
    approverId?: string | null;
    version?: number;
  },
): Promise<void> {
  await test.database.query(
    `INSERT INTO inventory_stocktake
       (id, tenant_id, company_id, stocktake_no, batch_id, book_qty, actual_qty,
        diff_qty, status, applicant_id, approver_id, remark, version)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::amount, $7::amount,
             ($7::amount - $6::amount), $8, $9::uuid, $10::uuid, '测试盘点', $11)`,
    [
      input.id,
      DEMO_IDS.tenantId,
      input.companyId,
      input.stocktakeNo,
      input.batchId,
      input.bookQty,
      input.actualQty,
      input.status ?? '待审批',
      DEMO_IDS.ownerEmployeeId,
      input.approverId ?? null,
      input.version ?? 1,
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

  async function listStocktakesRequest(
    cookie: string,
    requestId: string,
    query = '',
  ) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/stocktakes${query}`,
      headers: readHeaders(cookie, requestId),
    });
  }

  async function createStocktakeRequest(
    cookie: string,
    requestId: string,
    payload: Record<string, unknown>,
    extra: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/stocktakes',
      headers: writeHeaders(cookie, requestId, extra),
      payload,
    });
  }

  async function approveStocktakeRequest(
    cookie: string,
    requestId: string,
    id: string,
    extra: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/stocktakes/${id}/approve`,
      headers: writeHeaders(cookie, requestId, extra),
    });
  }

  async function createAiToken(requestId: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        name: 'Stocktake AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'stocktake', actions: ['read', 'create', 'approve'] }],
      },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { secret: string }).secret;
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

  it('盘点创建：I 号、服务端差异、无差异 / 跨公司 422、权限与 AI 禁止', async () => {
    await insertBatch(test, {
      id: STOCK_BATCH_SURPLUS_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_1_ID,
      batchNo: 'HTTP-STOCK-SURPLUS',
      inboundQty: '50',
      referencedQty: '5',
      inTransitQty: '0',
      pendingExecutionQty: '0',
    });
    const payload = {
      companyId: DEMO_IDS.companyId,
      batchId: STOCK_BATCH_SURPLUS_ID,
      bookQty: '50',
      actualQty: '55',
      remark: '盘盈测试',
    };

    const noPermission = await createStocktakeRequest(
      warehouseCookie,
      'req-stocktake-create-warehouse',
      payload,
    );
    expect(noPermission.statusCode).toBe(403);
    expect(noPermission.json()).toMatchObject({ code: 'FORBIDDEN' });

    const noDifference = await createStocktakeRequest(
      ownerCookie,
      'req-stocktake-create-no-difference',
      { ...payload, actualQty: '50.000000' },
    );
    expect(noDifference.statusCode).toBe(422);
    const noDifferenceBody = noDifference.json() as {
      code: string;
      details?: { issues?: { message: string }[] };
    };
    expect(noDifferenceBody.code).toBe('VALIDATION_FAILED');
    expect(
      noDifferenceBody.details?.issues?.some((issue) =>
        issue.message.includes('无差异不需要盘点单'),
      ),
    ).toBe(true);

    const crossCompany = await createStocktakeRequest(
      ownerCookie,
      'req-stocktake-create-cross-company',
      { ...payload, batchId: BATCH_3_ID },
    );
    expect(crossCompany.statusCode).toBe(422);
    expect(crossCompany.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const aiToken = await createAiToken('req-stocktake-create-ai-token');
    const aiWithoutReason = await app.inject({
      method: 'POST',
      url: '/api/v1/stocktakes',
      headers: {
        authorization: `Bearer ${aiToken}`,
        'x-request-id': 'req-stocktake-create-ai-no-reason',
      },
      payload,
    });
    expect(aiWithoutReason.statusCode).toBe(422);
    expect(aiWithoutReason.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const aiForbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/stocktakes',
      headers: {
        authorization: `Bearer ${aiToken}`,
        'x-reason': 'AI 尝试发起盘点',
        'x-request-id': 'req-stocktake-create-ai-forbidden',
      },
      payload,
    });
    expect(aiForbidden.statusCode).toBe(403);
    expect(aiForbidden.json()).toMatchObject({ code: 'AI_ACTION_FORBIDDEN' });

    const created = await createStocktakeRequest(
      ownerCookie,
      'req-stocktake-create-ok',
      payload,
    );
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    const stocktake = created.json() as Stocktake;
    expect(stocktake.stocktakeNo).toMatch(/^I-0001-\d{8}-\d{4}$/);
    expect(stocktake).toMatchObject({
      companyId: DEMO_IDS.companyId,
      batchId: STOCK_BATCH_SURPLUS_ID,
      bookQty: '50',
      actualQty: '55',
      diffQty: '5',
      status: '待审批',
      applicantId: DEMO_IDS.ownerEmployeeId,
      approverId: null,
      remark: '盘盈测试',
      version: 1,
    });
  });

  it('盘点列表 / 详情：公司隔离、状态筛选、approvable、普通读不记审计', async () => {
    await insertStocktakeRow(test, {
      id: STOCKTAKE_COMPANY2_ID,
      companyId: COMPANY_2_ID,
      stocktakeNo: 'I-0002-20261105-0001',
      batchId: BATCH_3_ID,
      bookQty: '20',
      actualQty: '18',
    });
    await insertStocktakeRow(test, {
      id: STOCKTAKE_DETAIL_ID,
      companyId: DEMO_IDS.companyId,
      stocktakeNo: 'I-0001-20261105-0101',
      batchId: BATCH_2_ID,
      bookQty: '30',
      actualQty: '25',
      status: '已批准',
      approverId: DEMO_IDS.ownerEmployeeId,
      version: 2,
    });

    const warehouseList = await listStocktakesRequest(
      warehouseCookie,
      'req-stocktake-list-warehouse',
    );
    expect(warehouseList.statusCode).toBe(200);
    const warehousePage = warehouseList.json() as { items: Stocktake[] };
    expect(warehousePage.items.every((item) => item.companyId === DEMO_IDS.companyId)).toBe(true);

    const warehouseCross = await listStocktakesRequest(
      warehouseCookie,
      'req-stocktake-list-cross',
      `?companyId=${COMPANY_2_ID}`,
    );
    expect((warehouseCross.json() as { items: Stocktake[] }).items).toEqual([]);

    const ownerCross = await listStocktakesRequest(
      ownerCookie,
      'req-stocktake-list-owner-cross',
      `?companyId=${COMPANY_2_ID}`,
    );
    expect((ownerCross.json() as { items: Stocktake[] }).items.map((item) => item.id)).toEqual([
      STOCKTAKE_COMPANY2_ID,
    ]);

    const approvedList = await listStocktakesRequest(
      ownerCookie,
      'req-stocktake-list-approved',
      `?companyId=${DEMO_IDS.companyId}&status=${encodeURIComponent('已批准')}`,
    );
    expect((approvedList.json() as { items: Stocktake[] }).items.map((item) => item.id)).toContain(
      STOCKTAKE_DETAIL_ID,
    );

    const warehouseCrossDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/stocktakes/${STOCKTAKE_COMPANY2_ID}`,
      headers: readHeaders(warehouseCookie, 'req-stocktake-detail-cross'),
    });
    expect(warehouseCrossDetail.statusCode).toBe(404);
    expect(warehouseCrossDetail.json()).toMatchObject({ code: 'NOT_FOUND' });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/stocktakes/${STOCKTAKE_DETAIL_ID}`,
      headers: readHeaders(ownerCookie, 'req-stocktake-detail-ok'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"2"');
    expect(detail.json()).toMatchObject({
      id: STOCKTAKE_DETAIL_ID,
      diffQty: '-5',
      status: '已批准',
      approvable: { allowed: false, reason: 'already_approved' },
    } satisfies Partial<StocktakeDetail>);

    const pendingDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/stocktakes/${STOCKTAKE_COMPANY2_ID}`,
      headers: readHeaders(ownerCookie, 'req-stocktake-detail-pending'),
    });
    expect(pendingDetail.json()).toMatchObject({
      status: '待审批',
      approvable: { allowed: true, reason: null },
    });

    const reads = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action IN ('stocktake.list.read', 'stocktake.detail.read')`,
    );
    expect(reads.rows[0]?.count).toBe('0');
  });

  it('盘点审批盘盈：If-Match / 权限 / AI 闸门；通过后调批次 + 冲正流水 + 审计', async () => {
    await insertBatch(test, {
      id: STOCK_BATCH_APPROVE_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_1_ID,
      batchNo: 'HTTP-STOCK-APPROVE',
      inboundQty: '50',
      referencedQty: '5',
      inTransitQty: '0',
      pendingExecutionQty: '0',
    });
    await insertStocktakeRow(test, {
      id: STOCKTAKE_APPROVE_ID,
      companyId: DEMO_IDS.companyId,
      stocktakeNo: 'I-0001-20261105-0201',
      batchId: STOCK_BATCH_APPROVE_ID,
      bookQty: '50',
      actualQty: '55',
    });

    const missingIfMatch = await approveStocktakeRequest(
      ownerCookie,
      'req-stocktake-approve-428',
      STOCKTAKE_APPROVE_ID,
    );
    expect(missingIfMatch.statusCode).toBe(428);
    expect(missingIfMatch.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const noPermission = await approveStocktakeRequest(
      warehouseCookie,
      'req-stocktake-approve-403',
      STOCKTAKE_APPROVE_ID,
      { 'if-match': '"1"' },
    );
    expect(noPermission.statusCode).toBe(403);
    expect(noPermission.json()).toMatchObject({ code: 'FORBIDDEN' });

    const stale = await approveStocktakeRequest(
      ownerCookie,
      'req-stocktake-approve-stale',
      STOCKTAKE_APPROVE_ID,
      { 'if-match': '"9"' },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const aiToken = await createAiToken('req-stocktake-approve-ai-token');
    const aiWithoutReason = await app.inject({
      method: 'POST',
      url: `/api/v1/stocktakes/${STOCKTAKE_APPROVE_ID}/approve`,
      headers: {
        authorization: `Bearer ${aiToken}`,
        'if-match': '"1"',
        'x-request-id': 'req-stocktake-approve-ai-no-reason',
      },
    });
    expect(aiWithoutReason.statusCode).toBe(422);
    expect(aiWithoutReason.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const aiForbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/stocktakes/${STOCKTAKE_APPROVE_ID}/approve`,
      headers: {
        authorization: `Bearer ${aiToken}`,
        'if-match': '"1"',
        'x-reason': 'AI 尝试审批盘点',
        'x-request-id': 'req-stocktake-approve-ai-forbidden',
      },
    });
    expect(aiForbidden.statusCode).toBe(403);
    expect(aiForbidden.json()).toMatchObject({ code: 'AI_ACTION_FORBIDDEN' });

    const approved = await approveStocktakeRequest(
      ownerCookie,
      'req-stocktake-approve-ok',
      STOCKTAKE_APPROVE_ID,
      { 'if-match': '"1"', 'x-reason': '盘点复核' },
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.headers.etag).toBe('"2"');
    expect(approved.json()).toMatchObject({
      id: STOCKTAKE_APPROVE_ID,
      status: '已批准',
      approverId: DEMO_IDS.ownerEmployeeId,
      version: 2,
      approvable: { allowed: false, reason: 'already_approved' },
    });

    const batch = await test.database.query<{
      inbound_qty: string;
      available_qty: string;
      version: number;
    }>(
      `SELECT trim_scale(inbound_qty) AS inbound_qty,
              trim_scale(available_qty) AS available_qty,
              version
         FROM inventory_batch
        WHERE id = $1::uuid`,
      [STOCK_BATCH_APPROVE_ID],
    );
    expect(batch.rows[0]).toEqual({ inbound_qty: '55', available_qty: '50', version: 2 });

    const flows = await test.database.query<{
      delta: string;
      source_doc_type: string;
      source_doc_id: string;
      handled_by: string;
    }>(
      `SELECT trim_scale(delta) AS delta,
              source_doc_type,
              source_doc_id,
              handled_by
         FROM inventory_flow
        WHERE source_doc_id = $1::uuid`,
      [STOCKTAKE_APPROVE_ID],
    );
    expect(flows.rows).toEqual([
      {
        delta: '5',
        source_doc_type: 'stocktake',
        source_doc_id: STOCKTAKE_APPROVE_ID,
        handled_by: DEMO_IDS.ownerEmployeeId,
      },
    ]);

    const audit = await test.database.query<{
      action: string;
      result: string;
      reason: string | null;
      custodian_id: string | null;
    }>(
      `SELECT action, result, reason, changes->>'custodianId' AS custodian_id
         FROM audit_log
        WHERE object_id = $1
          AND result = 'success'`,
      [STOCKTAKE_APPROVE_ID],
    );
    expect(audit.rows).toEqual([
      {
        action: 'stocktake.approve',
        result: 'success',
        reason: '盘点复核',
        custodian_id: DEMO_IDS.ownerEmployeeId,
      },
    ]);

    const repeated = await approveStocktakeRequest(
      ownerCookie,
      'req-stocktake-approve-repeated',
      STOCKTAKE_APPROVE_ID,
      { 'if-match': '"2"' },
    );
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { reason: 'already_approved', status: '已批准' },
    });
  });

  it('盘点审批盘亏：可用量足够则冲减；会变负则 409 且不落任何写入', async () => {
    await insertBatch(test, {
      id: STOCK_BATCH_SHORTAGE_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_2_ID,
      batchNo: 'HTTP-STOCK-SHORTAGE',
      inboundQty: '30',
      referencedQty: '0',
      inTransitQty: '0',
      pendingExecutionQty: '0',
    });
    await insertBatch(test, {
      id: STOCK_BATCH_TIGHT_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_2_ID,
      batchNo: 'HTTP-STOCK-TIGHT',
      inboundQty: '10',
      referencedQty: '8',
      inTransitQty: '0',
      pendingExecutionQty: '0',
    });
    await insertStocktakeRow(test, {
      id: STOCKTAKE_SHORTAGE_ID,
      companyId: DEMO_IDS.companyId,
      stocktakeNo: 'I-0001-20261105-0301',
      batchId: STOCK_BATCH_SHORTAGE_ID,
      bookQty: '30',
      actualQty: '20',
    });
    await insertStocktakeRow(test, {
      id: STOCKTAKE_TIGHT_ID,
      companyId: DEMO_IDS.companyId,
      stocktakeNo: 'I-0001-20261105-0302',
      batchId: STOCK_BATCH_TIGHT_ID,
      bookQty: '10',
      actualQty: '0',
    });

    const shortage = await approveStocktakeRequest(
      ownerCookie,
      'req-stocktake-shortage-ok',
      STOCKTAKE_SHORTAGE_ID,
      { 'if-match': '"1"' },
    );
    expect(shortage.statusCode).toBe(200);
    expect(shortage.json()).toMatchObject({ status: '已批准', version: 2 });

    const shortageBatch = await test.database.query<{
      inbound_qty: string;
      available_qty: string;
    }>(
      `SELECT trim_scale(inbound_qty) AS inbound_qty,
              trim_scale(available_qty) AS available_qty
         FROM inventory_batch
        WHERE id = $1::uuid`,
      [STOCK_BATCH_SHORTAGE_ID],
    );
    expect(shortageBatch.rows[0]).toEqual({ inbound_qty: '20', available_qty: '20' });

    const shortageFlows = await test.database.query<{ delta: string }>(
      `SELECT trim_scale(delta) AS delta
         FROM inventory_flow
        WHERE source_doc_id = $1::uuid`,
      [STOCKTAKE_SHORTAGE_ID],
    );
    expect(shortageFlows.rows).toEqual([{ delta: '-10' }]);

    const insufficient = await approveStocktakeRequest(
      ownerCookie,
      'req-stocktake-tight-409',
      STOCKTAKE_TIGHT_ID,
      { 'if-match': '"1"' },
    );
    expect(insufficient.statusCode).toBe(409);
    expect(insufficient.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: {
        reason: 'insufficient_available_qty',
        batchId: STOCK_BATCH_TIGHT_ID,
        availableQty: '2',
        delta: '-10',
      },
    });

    const tightStocktake = await test.database.query<{ status: string; version: number }>(
      `SELECT status, version FROM inventory_stocktake WHERE id = $1::uuid`,
      [STOCKTAKE_TIGHT_ID],
    );
    expect(tightStocktake.rows[0]).toEqual({ status: '待审批', version: 1 });

    const tightBatch = await test.database.query<{
      inbound_qty: string;
      available_qty: string;
    }>(
      `SELECT trim_scale(inbound_qty) AS inbound_qty,
              trim_scale(available_qty) AS available_qty
         FROM inventory_batch
        WHERE id = $1::uuid`,
      [STOCK_BATCH_TIGHT_ID],
    );
    expect(tightBatch.rows[0]).toEqual({ inbound_qty: '10', available_qty: '2' });

    const tightFlows = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM inventory_flow
        WHERE source_doc_id = $1::uuid`,
      [STOCKTAKE_TIGHT_ID],
    );
    expect(tightFlows.rows[0]?.count).toBe('0');
  });

  it('迁移 0017：应用角色只有 SELECT/INSERT/UPDATE，且 FORCE RLS 开启', async () => {
    const privileges = await test.database.query<{
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `SELECT has_table_privilege('qingdan_app', 'inventory_stocktake', 'SELECT') AS sel,
              has_table_privilege('qingdan_app', 'inventory_stocktake', 'INSERT') AS ins,
              has_table_privilege('qingdan_app', 'inventory_stocktake', 'UPDATE') AS upd,
              has_table_privilege('qingdan_app', 'inventory_stocktake', 'DELETE') AS del`,
    );
    expect(privileges.rows[0]).toEqual({ sel: true, ins: true, upd: true, del: false });

    const rls = await test.database.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE oid = 'inventory_stocktake'::regclass`,
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
