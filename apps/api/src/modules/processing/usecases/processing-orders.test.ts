import {
  AppError,
  type ProcessingOrder,
  type ProcessingOrderDetail,
  type ScopeMatrix,
} from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import {
  cancelProcessingOrder,
  createProcessingOrder,
  getProcessingOrder,
  listProcessingOrders,
  updateProcessingOrder,
} from './processing-orders.js';

/**
 * 加工单 B 用例 / 数据访问（D15 / D16 / D21 / D39 / D51 / D52 / D54）。
 *
 * 直接调用用例，用最小 request/reply 替身喂入认证层已算好的 Principal；
 * 数据库用 PGlite + 全量迁移 + seed 演示租户。
 */

const PROCESSOR_ID = '01900000-0000-7000-8000-000000001101';
const PROCESSOR_2_ID = '01900000-0000-7000-8000-000000001102';
const PRODUCT_ID = '01900000-0000-7000-8000-000000001111';
const PRODUCT_2_ID = '01900000-0000-7000-8000-000000001112';
const BATCH_ID = '01900000-0000-7000-8000-000000001121';
const BATCH_2_ID = '01900000-0000-7000-8000-000000001122';
const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000001103';
const FLOW_ID = '01900000-0000-7000-8000-000000001131';

const FULL_SCOPE: ScopeMatrix = [
  { domain: 'processing', actions: ['read', 'create', 'update', 'delete'] },
];
const READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'processing', actions: ['read'] }];

const FEE = {
  feeName: '加工费',
  qty: '1',
  unitPrice: '100',
  amount: '100',
  remark: null,
};

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

describe('processing 加工单用例（PGlite + seed 演示租户）', () => {
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

  async function createOne(
    input: Record<string, unknown> = {},
    overrides: Partial<Principal> = {},
  ): Promise<ProcessingOrder> {
    const { ctx, state } = writeCtx(overrides, {
      body: {
        companyId: DEMO_IDS.companyId,
        processorId: PROCESSOR_ID,
        outputProductId: PRODUCT_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        materialBatchIds: [{ batchId: BATCH_ID, qty: '100.000000' }],
        inputQty: '100',
        auxMaterials: '纸箱',
        fees: [FEE],
        attributionDoc: null,
        lossQty: null,
        ...input,
      },
    });
    const created = await createProcessingOrder(ctx);
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
    await test.database.query(
      `INSERT INTO processor
         (id, tenant_id, company_id, processor_no, name, contact_name, status)
       VALUES ($1, $2, $3, NULL, '用例加工厂', '王五', '启用'),
              ($4, $2, $5, NULL, '二司加工厂', '赵六', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [
        PROCESSOR_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PROCESSOR_2_ID,
        OTHER_COMPANY_ID,
      ],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, NULL, '用例材料', '{}', '件', '启用'),
              ($4, $2, $5, NULL, '二司材料', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [
        PRODUCT_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_2_ID,
        OTHER_COMPANY_ID,
      ],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'B-UNIT-001', '10', '1000', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'B-UNIT-002', '11', '1000', '0', '0', '0', $5),
              ($7, $2, $8, $9, 'B-UNIT-OTHER', '12', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
        BATCH_2_ID,
        '01900000-0000-7000-8000-000000001123',
        OTHER_COMPANY_ID,
        PRODUCT_2_ID,
      ],
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('开单：B 单号、材料批次、费用、损耗 / 可售量、审计均落库', async () => {
    const created = await createOne({
      materialBatchIds: [
        { batchId: BATCH_ID, qty: '60.000000' },
        { batchId: BATCH_2_ID, qty: '40.000000' },
      ],
      inputQty: '100',
      lossQty: '4',
      attributionDoc: 'E-0001-20261105-0001',
      fees: [FEE, { feeName: '运杂费', qty: '2', unitPrice: '5.5', amount: '11' }],
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.tenantId).toBe(DEMO_IDS.tenantId);
    expect(created.companyId).toBe(DEMO_IDS.companyId);
    expect(created.orderNo).toMatch(/^B-0001-\d{8}-\d{4}$/);
    expect(created.processorName).toBe('用例加工厂');
    expect(created.status).toBe('进行中');
    expect(created.version).toBe(1);
    expect(created.materialBatchIds).toEqual([
      { batchId: BATCH_ID, qty: '60.000000' },
      { batchId: BATCH_2_ID, qty: '40.000000' },
    ]);
    expect(created.fees).toEqual([
      FEE,
      { feeName: '运杂费', qty: '2', unitPrice: '5.5', amount: '11', remark: null },
    ]);
    expect(created.inputQty).toBe('100');
    expect(created.lossQty).toBe('4');
    expect(created.sellableQty).toBe('96');
    expect(created.attributionDoc).toBe('E-0001-20261105-0001');
    expect(typeof created.inputQty).toBe('string');
    expect(typeof created.fees[0]?.amount).toBe('string');

    const detail = (await getProcessingOrder(
      readCtx({}, { params: { id: created.id } }),
    )) as ProcessingOrderDetail;
    expect(detail.outputBatchId).toBeNull();
    expect(detail.lossRecord).toBeNull();
    expect(detail.cancelable).toEqual({ allowed: true, reason: null });

    const audit = await test.database.query<{
      action: string;
      object_type: string;
      result: string;
    }>(
      `SELECT action, object_type, result
         FROM audit_log
        WHERE object_id = $1`,
      [created.id],
    );
    expect(audit.rows).toEqual([
      {
        action: 'processing.order.create',
        object_type: 'processing_order',
        result: 'success',
      },
    ]);

    await expectAppError(
      createProcessingOrder(
        writeCtx({}, {
          body: {
            companyId: DEMO_IDS.companyId,
            processorId: PROCESSOR_ID,
            outputProductId: PRODUCT_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            materialBatchIds: [],
            inputQty: '1',
            fees: [FEE],
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createProcessingOrder(
        writeCtx({}, {
          body: {
            companyId: DEMO_IDS.companyId,
            processorId: PROCESSOR_ID,
            outputProductId: PRODUCT_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            materialBatchIds: [{ batchId: BATCH_ID, qty: '5.000000' }],
            inputQty: '5',
            lossQty: '6',
            fees: [FEE],
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );
  });

  it('D15 / D22 / D52①：非法公司、跨公司加工厂 / 批次、AI 开单均拒绝', async () => {
    await expectAppError(
      createProcessingOrder(
        writeCtx({}, {
          body: {
            companyId: OTHER_COMPANY_ID,
            processorId: PROCESSOR_2_ID,
            outputProductId: PRODUCT_2_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            materialBatchIds: [{ batchId: BATCH_ID, qty: '1.000000' }],
            inputQty: '1',
            fees: [FEE],
          },
        }).ctx,
      ),
      'FORBIDDEN',
    );

    await expectAppError(
      createProcessingOrder(
        writeCtx({}, {
          body: {
            companyId: DEMO_IDS.companyId,
            processorId: PROCESSOR_2_ID,
            outputProductId: PRODUCT_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            materialBatchIds: [{ batchId: BATCH_ID, qty: '1.000000' }],
            inputQty: '1',
            fees: [FEE],
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createProcessingOrder(
        writeCtx({}, {
          body: {
            companyId: DEMO_IDS.companyId,
            processorId: PROCESSOR_ID,
            outputProductId: PRODUCT_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            materialBatchIds: [
              { batchId: '01900000-0000-7000-8000-000000001123', qty: '1.000000' },
            ],
            inputQty: '1',
            fees: [FEE],
          },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    await expectAppError(
      createProcessingOrder(
        writeCtx({}, {
          principal: aiPrincipal(),
          auditReason: 'AI 尝试开加工单',
          body: {
            companyId: DEMO_IDS.companyId,
            processorId: PROCESSOR_ID,
            outputProductId: PRODUCT_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            materialBatchIds: [{ batchId: BATCH_ID, qty: '1.000000' }],
            inputQty: '1',
            fees: [FEE],
          },
        }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    await expectAppError(
      createProcessingOrder(
        writeCtx({ scope: READ_ONLY_SCOPE }, {
          body: {
            companyId: DEMO_IDS.companyId,
            processorId: PROCESSOR_ID,
            outputProductId: PRODUCT_ID,
            handlerId: DEMO_IDS.ownerEmployeeId,
            materialBatchIds: [{ batchId: BATCH_ID, qty: '1.000000' }],
            inputQty: '1',
            fees: [FEE],
          },
        }).ctx,
      ),
      'FORBIDDEN',
    );
  });

  it('详情 / 列表：加工厂 / 状态 / 单号关键字过滤，跨公司不可见，普通读不记审计', async () => {
    const created = await createOne({ fees: [FEE] });

    const byProcessor = await listProcessingOrders(
      readCtx({}, { query: { processorId: PROCESSOR_ID } }),
    );
    expect(byProcessor.items.map((item) => item.id)).toContain(created.id);

    const byStatus = await listProcessingOrders(
      readCtx({}, { query: { status: '进行中', keyword: created.orderNo } }),
    );
    expect(byStatus.items.map((item) => item.id)).toEqual([created.id]);

    const byName = await listProcessingOrders(
      readCtx({}, { query: { keyword: '用例加工厂' } }),
    );
    expect(byName.items.map((item) => item.id)).toContain(created.id);

    const outside = principal({ companyIds: [OTHER_COMPANY_ID] });
    const outsideList = await listProcessingOrders(
      readCtx(outside, { query: { keyword: created.orderNo } }),
    );
    expect(outsideList.items).toHaveLength(0);
    await expectAppError(
      getProcessingOrder(readCtx(outside, { params: { id: created.id } })),
      'NOT_FOUND',
    );

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

  it('修改：If-Match 必填、版本冲突、仅进行中、替换批次 / 费用；AI 修改放行', async () => {
    const created = await createOne({ lossQty: '4' });

    await expectAppError(
      updateProcessingOrder(
        writeCtx({}, {
          params: { id: created.id },
          body: { auxMaterials: '新辅料' },
        }).ctx,
      ),
      'PRECONDITION_REQUIRED',
    );
    await expectAppError(
      updateProcessingOrder(
        writeCtx({}, {
          params: { id: created.id },
          headers: { 'if-match': '"9"' },
          body: { auxMaterials: '新辅料' },
        }).ctx,
      ),
      'VERSION_CONFLICT',
    );
    await expectAppError(
      updateProcessingOrder(
        writeCtx({}, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { inputQty: '3' },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      updateProcessingOrder(
        writeCtx({}, {
          params: { id: created.id },
          headers: { 'if-match': '"1"' },
          body: { fees: [] },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );
    const unchanged = await getProcessingOrder(
      readCtx({}, { params: { id: created.id } }),
    );
    expect(unchanged.fees).toEqual(created.fees);

    const { ctx, state } = writeCtx({}, {
      params: { id: created.id },
      headers: { 'if-match': '"1"' },
      body: {
        materialBatchIds: [{ batchId: BATCH_2_ID, qty: '120.000000' }],
        inputQty: '120',
        auxMaterials: null,
        attributionDoc: 'N-0001-20261105-0002',
        fees: [{ feeName: '运杂费', qty: '1', unitPrice: '8', amount: '8' }],
      },
    });
    const updated = await updateProcessingOrder(ctx);
    expect(state.headers.ETag).toBe('"2"');
    expect(updated.version).toBe(2);
    expect(updated.materialBatchIds).toEqual([
      { batchId: BATCH_2_ID, qty: '120.000000' },
    ]);
    expect(updated.inputQty).toBe('120');
    expect(updated.lossQty).toBe('4');
    expect(updated.sellableQty).toBe('116');
    expect(updated.auxMaterials).toBeNull();
    expect(updated.attributionDoc).toBe('N-0001-20261105-0002');
    expect(updated.fees).toEqual([
      { feeName: '运杂费', qty: '1', unitPrice: '8', amount: '8', remark: null },
    ]);

    // 契约 ai.policy=allow：AI 普通编辑可以落库。
    const aiUpdate = writeCtx({}, {
      principal: aiPrincipal(),
      auditReason: 'AI 修改加工单备注',
      params: { id: created.id },
      headers: { 'if-match': '"2"' },
      body: { auxMaterials: 'AI 修改' },
    });
    const aiUpdated = await updateProcessingOrder(aiUpdate.ctx);
    expect(aiUpdated.auxMaterials).toBe('AI 修改');
    expect(aiUpdated.version).toBe(3);

    const completed = await createOne();
    await test.database.query(
      `UPDATE processing_order SET status = '已完成' WHERE id = $1`,
      [completed.id],
    );
    await expectAppError(
      updateProcessingOrder(
        writeCtx({}, {
          params: { id: completed.id },
          headers: { 'if-match': '"1"' },
          body: { handlerId: DEMO_IDS.ownerEmployeeId },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const audit = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_log
        WHERE action = 'processing.order.update'
          AND object_id = $1
          AND result = 'success'`,
      [created.id],
    );
    expect(audit.rows[0]?.count).toBe('2');
  });

  it('取消：D21 有下游 / 已完成拒绝，AI 禁止；成功置已取消并记审计', async () => {
    const withDownstream = await createOne();
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
    await expectAppError(
      cancelProcessingOrder(
        writeCtx({}, {
          params: { id: withDownstream.id },
          headers: { 'if-match': '"1"' },
        }).ctx,
      ),
      'VERSION_CONFLICT',
    );

    const completed = await createOne();
    await test.database.query(
      `UPDATE processing_order SET status = '已完成' WHERE id = $1`,
      [completed.id],
    );
    await expectAppError(
      cancelProcessingOrder(
        writeCtx({}, {
          params: { id: completed.id },
          headers: { 'if-match': '"1"' },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const aiTarget = await createOne();
    await expectAppError(
      cancelProcessingOrder(
        writeCtx({}, {
          principal: aiPrincipal(),
          auditReason: 'AI 尝试取消加工单',
          params: { id: aiTarget.id },
          headers: { 'if-match': '"1"' },
        }).ctx,
      ),
      'AI_ACTION_FORBIDDEN',
    );

    const created = await createOne();
    const { ctx, state } = writeCtx({}, {
      params: { id: created.id },
      headers: { 'if-match': '"1"' },
    });
    const cancelled = await cancelProcessingOrder(ctx);
    expect(state.headers.ETag).toBe('"2"');
    expect(cancelled.status).toBe('已取消');
    expect(cancelled.version).toBe(2);

    await expectAppError(
      cancelProcessingOrder(
        writeCtx({}, {
          params: { id: created.id },
          headers: { 'if-match': '"2"' },
        }).ctx,
      ),
      'VALIDATION_FAILED',
    );

    const audit = await test.database.query<{ action: string; result: string }>(
      `SELECT action, result
         FROM audit_log
        WHERE object_id = $1
        ORDER BY action`,
      [created.id],
    );
    expect(audit.rows).toContainEqual({
      action: 'processing.order.cancel',
      result: 'success',
    });

    const detail = (await getProcessingOrder(
      readCtx({}, { params: { id: created.id } }),
    )) as ProcessingOrderDetail;
    expect(detail.cancelable).toEqual({
      allowed: false,
      reason: 'already_cancelled',
    });
  });
});
