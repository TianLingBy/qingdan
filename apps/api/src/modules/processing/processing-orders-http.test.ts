import type { ProcessingOrder, ProcessingOrderDetail } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * processing 加工单 HTTP 层（D15 / D16 / D21 / D39 / D51 / D52 / D54）。
 *
 * 覆盖 routes.ts 的分派与 platform 统一错误映射：
 *   - 未认证 401、无 processing 写权限 403、跨公司不可见 404 / 空列表；
 *   - create 201 + 强 ETag，detail 200 + ETag + outputBatchId / lossRecord / cancelable；
 *   - update / cancel 必须带 If-Match；缺失 428、弱 ETag / 旧版本 409；
 *   - 已完成不可改、不可取消（422）；有下游不可取消（409）；
 *   - materialBatchIds 为空 / D39 负数费用 → 422；
 *   - D52① AI 凭证开单 / 取消 → 403 AI_ACTION_FORBIDDEN；
 *   - 写操作成功审计落 audit_log（D51），普通读不记。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';

const OWNER_PHONE = '10000000001';
const WAREHOUSE_PHONE = '10000000004';
const OUTSIDE_PHONE = '10000000005';

const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000002403';
const OUTSIDE_EMPLOYEE_ID = '01900000-0000-7000-8000-000000002425';
const MANAGER_POSITION_ID = '01900000-0000-7000-8000-000000000012';

const PROCESSOR_ID = '01900000-0000-7000-8000-000000002401';
const PROCESSOR_2_ID = '01900000-0000-7000-8000-000000002402';
const PRODUCT_ID = '01900000-0000-7000-8000-000000002411';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000002412';
const BATCH_ID = '01900000-0000-7000-8000-000000002421';
const BATCH_2_ID = '01900000-0000-7000-8000-000000002422';
const FLOW_ID = '01900000-0000-7000-8000-000000002423';

const FEE = {
  feeName: '加工费',
  qty: '1',
  unitPrice: '50',
  amount: '50',
  remark: null,
};

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(
  cookie: string,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId, ...extra };
}

async function login(
  app: FastifyInstance,
  phone: string,
  requestId: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

describe('processing 加工单 HTTP（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let warehouseCookie: string;
  let outsideCookie: string;

  async function createOrder(
    requestId: string,
    payload: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/processing-orders',
      headers: writeHeaders(ownerCookie, requestId),
      payload: {
        companyId: DEMO_IDS.companyId,
        processorId: PROCESSOR_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        materialBatchIds: [BATCH_ID],
        inputQty: '100',
        auxMaterials: '纸箱',
        fees: [FEE],
        attributionDoc: null,
        lossQty: null,
        ...payload,
      },
    });
  }

  async function createOne(
    requestId: string,
    payload: Record<string, unknown> = {},
  ): Promise<ProcessingOrder> {
    const response = await createOrder(requestId, payload);
    expect(response.statusCode).toBe(201);
    return response.json() as ProcessingOrder;
  }

  let sequence = 0;
  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-processing-${prefix}-${sequence}`;
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
    await test.database.query(
      `INSERT INTO employee
         (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1, $2, '000005', $3, '外部员工', '在职', false)
       ON CONFLICT (id) DO NOTHING`,
      [OUTSIDE_EMPLOYEE_ID, DEMO_IDS.tenantId, OUTSIDE_PHONE],
    );
    await test.database.query(
      `INSERT INTO employee_company_position
         (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [
        DEMO_IDS.tenantId,
        OUTSIDE_EMPLOYEE_ID,
        SECOND_COMPANY_ID,
        MANAGER_POSITION_ID,
      ],
    );
    await test.database.query(
      `INSERT INTO processor
         (id, tenant_id, company_id, processor_no, name, contact_name, status)
       VALUES ($1, $2, $3, NULL, 'HTTP加工厂', '王五', '启用'),
              ($4, $2, $5, NULL, 'HTTP二司加工厂', '赵六', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [
        PROCESSOR_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PROCESSOR_2_ID,
        SECOND_COMPANY_ID,
      ],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, 'HTTP材料', '{}', '件', '启用'),
              ($4, $2, $5, NULL, 'HTTP二司材料', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [
        PRODUCT_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_2_ID,
        SECOND_COMPANY_ID,
      ],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'B-HTTP-001', '8', '1000', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'B-HTTP-002', '9', '1000', '0', '0', '0', $5),
              ($7, $2, $8, $9, 'B-HTTP-OTHER', '10', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
        BATCH_2_ID,
        '01900000-0000-7000-8000-000000002424',
        SECOND_COMPANY_ID,
        PRODUCT_2_ID,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-processing-login-owner');
    warehouseCookie = await login(
      app,
      WAREHOUSE_PHONE,
      'req-processing-login-warehouse',
    );
    outsideCookie = await login(app, OUTSIDE_PHONE, 'req-processing-login-outside');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('未登录 → 401；无 processing.create → 403', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/processing-orders',
      headers: { 'x-request-id': 'req-processing-anonymous' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/processing-orders',
      headers: readHeaders(warehouseCookie, 'req-processing-no-perm-list'),
    });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/processing-orders',
      headers: writeHeaders(warehouseCookie, 'req-processing-no-perm-create'),
      payload: {
        companyId: DEMO_IDS.companyId,
        processorId: PROCESSOR_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        materialBatchIds: [BATCH_ID],
        inputQty: '100',
        fees: [FEE],
      },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('开单 → 201 + B 单号 + decimal 字符串 + 强 ETag；详情占位；审计落库', async () => {
    const response = await createOrder(nextRequestId('create-ok'), {
      materialBatchIds: [BATCH_ID, BATCH_2_ID],
      inputQty: '100.5',
      lossQty: '0.5',
      attributionDoc: 'N-0001-20261105-0001',
      fees: [
        FEE,
        {
          feeName: '运杂费',
          qty: '2',
          unitPrice: '3.25',
          amount: '6.5',
          remark: '送货',
        },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers.etag).toMatch(/^"\d+"$/);

    const body = response.json() as ProcessingOrder;
    expect(body).toMatchObject({
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      processorId: PROCESSOR_ID,
      processorName: 'HTTP加工厂',
      handlerId: DEMO_IDS.ownerEmployeeId,
      status: '进行中',
      materialBatchIds: [BATCH_ID, BATCH_2_ID],
      inputQty: '100.5',
      lossQty: '0.5',
      sellableQty: '100',
      attributionDoc: 'N-0001-20261105-0001',
      version: 1,
    });
    expect(body.orderNo).toMatch(/^B-0001-\d{8}-\d{4}$/);
    expect(body.fees).toHaveLength(2);
    expect(typeof body.inputQty).toBe('string');
    expect(typeof body.lossQty).toBe('string');
    expect(typeof body.sellableQty).toBe('string');
    expect(typeof body.fees[0]?.amount).toBe('string');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/processing-orders/${body.id}`,
      headers: readHeaders(ownerCookie, 'req-processing-detail-ok'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect(detail.json()).toMatchObject({
      id: body.id,
      orderNo: body.orderNo,
      outputBatchId: null,
      lossRecord: null,
      cancelable: { allowed: true, reason: null },
    });

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result FROM audit_log WHERE object_id = $1`,
      [body.id],
    );
    expect(audit.rows).toEqual([
      { action: 'processing.order.create', result: 'success' },
    ]);

    const reads = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action IN (
          'processing.order.list.read',
          'processing.order.detail.read'
        )`,
    );
    expect(reads.rows[0]?.count).toBe('0');
  });

  it('materialBatchIds 空 / 负数费用 → 422；跨公司加工厂 / 批次 → 422；详情 / 列表隔离', async () => {
    const noBatches = await createOrder(nextRequestId('no-batches'), {
      materialBatchIds: [],
    });
    expect(noBatches.statusCode).toBe(422);
    expect(noBatches.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const badFee = await createOrder(nextRequestId('bad-fee'), {
      fees: [
        {
          feeName: '返利',
          qty: '1',
          unitPrice: '5',
          amount: '-5',
          remark: '不应允许',
        },
      ],
    });
    expect(badFee.statusCode).toBe(422);
    expect(badFee.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const crossProcessor = await createOrder(nextRequestId('cross-processor'), {
      processorId: PROCESSOR_2_ID,
    });
    expect(crossProcessor.statusCode).toBe(422);
    expect(crossProcessor.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const crossBatch = await createOrder(nextRequestId('cross-batch'), {
      materialBatchIds: ['01900000-0000-7000-8000-000000002424'],
    });
    expect(crossBatch.statusCode).toBe(422);
    expect(crossBatch.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const created = await createOne(nextRequestId('cross'));
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/processing-orders/${created.id}`,
      headers: readHeaders(outsideCookie, 'req-processing-cross-detail'),
    });
    expect(detail.statusCode).toBe(404);

    const outsideList = await app.inject({
      method: 'GET',
      url: `/api/v1/processing-orders?keyword=${encodeURIComponent(created.orderNo)}`,
      headers: readHeaders(outsideCookie, 'req-processing-cross-list'),
    });
    expect(outsideList.statusCode).toBe(200);
    expect((outsideList.json() as { items: ProcessingOrder[] }).items).toHaveLength(0);

    const ownerList = await app.inject({
      method: 'GET',
      url:
        `/api/v1/processing-orders?processorId=${PROCESSOR_ID}` +
        `&status=${encodeURIComponent('进行中')}` +
        `&keyword=${encodeURIComponent(created.orderNo)}`,
      headers: readHeaders(ownerCookie, 'req-processing-list-filter'),
    });
    expect(ownerList.statusCode).toBe(200);
    const page = ownerList.json() as {
      items: ProcessingOrder[];
      nextCursor: string | null;
    };
    expect(page.items.map((item) => item.id)).toEqual([created.id]);
    expect(page.items[0]?.materialBatchIds).toEqual([BATCH_ID]);
    expect(page.nextCursor).toBeNull();
  });

  it('修改：缺 If-Match 428、旧版本 / 弱 ETag 409、成功回新 ETag；已完成 422', async () => {
    const created = await createOne(nextRequestId('update'), { lossQty: '2' });

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processing-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-processing-update-428'),
      payload: { auxMaterials: '新辅料' },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processing-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-processing-update-409', {
        'if-match': '"9"',
      }),
      payload: { auxMaterials: '新辅料' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const weak = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processing-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-processing-update-weak', {
        'if-match': '1',
      }),
      payload: { auxMaterials: '新辅料' },
    });
    expect(weak.statusCode).toBe(409);
    expect(weak.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processing-orders/${created.id}`,
      headers: writeHeaders(ownerCookie, 'req-processing-update-ok', {
        'if-match': '"1"',
      }),
      payload: {
        materialBatchIds: [BATCH_2_ID],
        inputQty: '20',
        auxMaterials: null,
        fees: [FEE],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({
      version: 2,
      materialBatchIds: [BATCH_2_ID],
      inputQty: '20',
      lossQty: '2',
      sellableQty: '18',
      auxMaterials: null,
    });

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'processing.order.update'
          AND object_id = $1
          AND result = 'success'`,
      [created.id],
    );
    expect(audit.rows[0]?.count).toBe('1');

    const completed = await createOne(nextRequestId('update-completed'));
    await test.database.query(
      `UPDATE processing_order SET status = '已完成' WHERE id = $1`,
      [completed.id],
    );
    const rejected = await app.inject({
      method: 'PATCH',
      url: `/api/v1/processing-orders/${completed.id}`,
      headers: writeHeaders(ownerCookie, 'req-processing-update-completed', {
        'if-match': '"1"',
      }),
      payload: { auxMaterials: '不应修改' },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('取消：缺 If-Match 428；有下游 409；已完成 422；成功置已取消 + 审计', async () => {
    const created = await createOne(nextRequestId('cancel'));

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/processing-orders/${created.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-processing-cancel-428'),
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED' });

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/processing-orders/${created.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-processing-cancel-ok', {
        'if-match': '"1"',
      }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({ status: '已取消', version: 2 });

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'processing.order.cancel'
          AND object_id = $1
          AND result = 'success'`,
      [created.id],
    );
    expect(audit.rows[0]?.count).toBe('1');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/processing-orders/${created.id}`,
      headers: readHeaders(ownerCookie, 'req-processing-cancel-detail'),
    });
    expect((detail.json() as ProcessingOrderDetail).cancelable).toEqual({
      allowed: false,
      reason: 'already_cancelled',
    });

    const withDownstream = await createOne(nextRequestId('cancel-downstream'));
    await test.database.query(
      `INSERT INTO inventory_flow
         (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id, handled_by)
       VALUES ($1, $2, $3, $4, '-1', 'B', $5, $6)`,
      [
        FLOW_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        BATCH_ID,
        withDownstream.id,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
    const downstream = await app.inject({
      method: 'POST',
      url: `/api/v1/processing-orders/${withDownstream.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-processing-cancel-downstream', {
        'if-match': '"1"',
      }),
    });
    expect(downstream.statusCode).toBe(409);
    expect(downstream.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    const completed = await createOne(nextRequestId('cancel-completed'));
    await test.database.query(
      `UPDATE processing_order SET status = '已完成' WHERE id = $1`,
      [completed.id],
    );
    const completedCancel = await app.inject({
      method: 'POST',
      url: `/api/v1/processing-orders/${completed.id}/cancel`,
      headers: writeHeaders(ownerCookie, 'req-processing-cancel-completed', {
        'if-match': '"1"',
      }),
    });
    expect(completedCancel.statusCode).toBe(422);
    expect(completedCancel.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('D52①：AI 凭证开单 / 取消 → 403 AI_ACTION_FORBIDDEN', async () => {
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: writeHeaders(ownerCookie, 'req-processing-ai-token'),
      payload: {
        name: 'HTTP Processing AI Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'processing', actions: ['read', 'create', 'delete'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret } = tokenResponse.json() as { secret: string };

    const createForbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/processing-orders',
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 开加工单',
        'x-request-id': 'req-processing-ai-create',
      },
      payload: {
        companyId: DEMO_IDS.companyId,
        processorId: PROCESSOR_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        materialBatchIds: [BATCH_ID],
        inputQty: '10',
        fees: [FEE],
      },
    });
    expect(createForbidden.statusCode).toBe(403);
    expect(createForbidden.json()).toMatchObject({
      code: 'AI_ACTION_FORBIDDEN',
    });

    const target = await createOne(nextRequestId('ai-cancel'));
    const cancelForbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/processing-orders/${target.id}/cancel`,
      headers: {
        authorization: `Bearer ${secret}`,
        'x-reason': 'HTTP 测试 AI 取消加工单',
        'if-match': '"1"',
        'x-request-id': 'req-processing-ai-cancel',
      },
    });
    expect(cancelForbidden.statusCode).toBe(403);
    expect(cancelForbidden.json()).toMatchObject({
      code: 'AI_ACTION_FORBIDDEN',
    });

    const row = await test.database.query<{ status: string }>(
      'SELECT status FROM processing_order WHERE id = $1',
      [target.id],
    );
    expect(row.rows[0]?.status).toBe('进行中');
  });
});
