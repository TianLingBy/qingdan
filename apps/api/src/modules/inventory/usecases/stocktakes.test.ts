import { AppError, type ScopeMatrix, type Stocktake } from '@qingdan/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import { approveStocktake, rejectStocktake } from './stocktakes.js';

/**
 * 盘点驳回用例（Issue #287 / D47 / D51 / D52 / D60 / D67）。
 *
 * 直接调用用例（不经路由 preHandler），锁住用例层自己的权限 / If-Match / AI 闸门，
 * 并验证「驳回不动库存、不写流水」这条与批准最大的区别。
 */

const PRODUCT_ID = '01900000-0000-7000-8000-000000000301';
const BATCH_ID = '01900000-0000-7000-8000-000000000311';
const APPROVED_BATCH_ID = '01900000-0000-7000-8000-000000000312';
const STOCKTAKE_ID = '01900000-0000-7000-8000-000000000321';
const APPROVED_STOCKTAKE_ID = '01900000-0000-7000-8000-000000000322';

const STOCKTAKE_SCOPE: ScopeMatrix = [
  { domain: 'stocktake', actions: ['read', 'create', 'delete', 'approve'] },
];
const READ_ONLY_SCOPE: ScopeMatrix = [{ domain: 'stocktake', actions: ['read'] }];

interface FakeRequestInput {
  readonly principal: Principal;
  readonly params?: Record<string, unknown>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
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

function makeReply(): FastifyReply {
  const reply = {
    header() {
      return reply;
    },
    status() {
      return reply;
    },
    send() {
      return reply;
    },
  };
  return reply as unknown as FastifyReply;
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    actorType: 'employee',
    actorId: DEMO_IDS.ownerEmployeeId,
    tenantId: DEMO_IDS.tenantId,
    employeeId: DEMO_IDS.ownerEmployeeId,
    credentialId: 'session-stocktake-test',
    companyIds: [DEMO_IDS.companyId],
    scope: STOCKTAKE_SCOPE,
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

async function insertBatch(
  test: TestDatabase,
  id: string,
  batchNo: string,
  inboundQty: string,
): Promise<void> {
  await test.database.query(
    `INSERT INTO inventory_batch
       (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
        inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
     VALUES ($1, $2, $3, $4, $5, '10.000000', $6, '0', '0', '0', $7)`,
    [
      id,
      DEMO_IDS.tenantId,
      DEMO_IDS.companyId,
      PRODUCT_ID,
      batchNo,
      inboundQty,
      DEMO_IDS.ownerEmployeeId,
    ],
  );
}

async function insertStocktakeRow(
  test: TestDatabase,
  input: {
    id: string;
    stocktakeNo: string;
    batchId: string;
    bookQty: string;
    actualQty: string;
    status?: '待审批' | '已批准' | '已驳回';
    version?: number;
  },
): Promise<void> {
  await test.database.query(
    `INSERT INTO inventory_stocktake
       (id, tenant_id, company_id, stocktake_no, batch_id, book_qty, actual_qty,
        diff_qty, status, applicant_id, approver_id, remark, version)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::amount, $7::amount,
             ($7::amount - $6::amount), $8, $9::uuid, $10::uuid, '用例测试', $11)`,
    [
      input.id,
      DEMO_IDS.tenantId,
      DEMO_IDS.companyId,
      input.stocktakeNo,
      input.batchId,
      input.bookQty,
      input.actualQty,
      input.status ?? '待审批',
      DEMO_IDS.ownerEmployeeId,
      input.status === '已批准' ? DEMO_IDS.ownerEmployeeId : null,
      input.version ?? 1,
    ],
  );
}

describe('盘点驳回用例（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;

  function rejectCtx(
    overrides: Partial<Principal> = {},
    parts: Partial<FakeRequestInput> = {},
  ) {
    const request = makeRequest({ principal: principal(overrides), ...parts });
    return {
      database: test.database,
      request,
      reply: makeReply(),
    };
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, specification, unit, status)
       VALUES ($1, $2, $3, 'ST-001', '盘点用例苹果', '{}', NULL, '件', '启用')`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await insertBatch(test, BATCH_ID, 'ST-BATCH-REJECT', '40');
    await insertBatch(test, APPROVED_BATCH_ID, 'ST-BATCH-APPROVED', '20');
    await insertStocktakeRow(test, {
      id: STOCKTAKE_ID,
      stocktakeNo: 'I-0001-20261105-0501',
      batchId: BATCH_ID,
      bookQty: '40',
      actualQty: '45',
    });
    await insertStocktakeRow(test, {
      id: APPROVED_STOCKTAKE_ID,
      stocktakeNo: 'I-0001-20261105-0502',
      batchId: APPROVED_BATCH_ID,
      bookQty: '20',
      actualQty: '21',
      status: '已批准',
      version: 2,
    });
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('成功驳回：状态 / 原因 / 审批人 / version 落库，库存与流水零变化', async () => {
    const beforeBatch = await test.database.query(
      `SELECT trim_scale(inbound_qty) AS inbound_qty,
              trim_scale(available_qty) AS available_qty,
              version
         FROM inventory_batch WHERE id = $1::uuid`,
      [BATCH_ID],
    );

    const rejected = await rejectStocktake(
      rejectCtx(
        {},
        {
          params: { id: STOCKTAKE_ID },
          headers: { 'if-match': '"1"' },
          body: { confirm: true, reason: '  盘点依据不足  ' },
        },
      ),
    );
    expect(rejected).toMatchObject({
      id: STOCKTAKE_ID,
      status: '已驳回',
      rejectReason: '盘点依据不足',
      approverId: DEMO_IDS.ownerEmployeeId,
      version: 2,
    } satisfies Partial<Stocktake>);

    const stored = await test.database.query(
      `SELECT status, reject_reason, version
         FROM inventory_stocktake WHERE id = $1::uuid`,
      [STOCKTAKE_ID],
    );
    expect(stored.rows[0]).toEqual({
      status: '已驳回',
      reject_reason: '盘点依据不足',
      version: 2,
    });

    // 驳回不动库存：批次整行快照不变，且 source_doc_id 无流水。
    const afterBatch = await test.database.query(
      `SELECT trim_scale(inbound_qty) AS inbound_qty,
              trim_scale(available_qty) AS available_qty,
              version
         FROM inventory_batch WHERE id = $1::uuid`,
      [BATCH_ID],
    );
    expect(afterBatch.rows).toEqual(beforeBatch.rows);

    const flows = await test.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM inventory_flow WHERE source_doc_id = $1::uuid`,
      [STOCKTAKE_ID],
    );
    expect(flows.rows[0]?.count).toBe('0');

    const audit = await test.database.query<{
      action: string;
      change_reason: string | null;
    }>(
      `SELECT action, changes->>'reason' AS change_reason
         FROM audit_log
        WHERE object_id = $1 AND result = 'success'`,
      [STOCKTAKE_ID],
    );
    expect(audit.rows).toEqual([{ action: 'stocktake.reject', change_reason: '盘点依据不足' }]);
  });

  it('只有待审批可驳回；已驳回 / 已批准都是终态', async () => {
    // 已驳回再驳回：VALIDATION_FAILED，且写清当前状态。
    await expectAppError(
      rejectStocktake(
        rejectCtx(
          {},
          {
            params: { id: STOCKTAKE_ID },
            headers: { 'if-match': '"2"' },
            body: { confirm: true, reason: '再驳一次' },
          },
        ),
      ),
      'VALIDATION_FAILED',
    );

    // 已驳回再审批：409 + already_rejected（STOCKTAKE_APPROVE_BLOCK_REASONS 分支可达）。
    await expect(
      approveStocktake(
        rejectCtx({}, { params: { id: STOCKTAKE_ID }, headers: { 'if-match': '"2"' } }),
      ),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { reason: 'already_rejected', status: '已驳回' },
    });

    // 已批准不可驳回：VALIDATION_FAILED（不是 404 / 500）。
    await expect(
      rejectStocktake(
        rejectCtx(
          {},
          {
            params: { id: APPROVED_STOCKTAKE_ID },
            headers: { 'if-match': '"2"' },
            body: { confirm: true, reason: '已批准也能驳？' },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('已批准') });
  });

  it('入参与并发：缺原因 / 缺 confirm → 422，缺 If-Match → 428，版本不符 → 409', async () => {
    await expectAppError(
      rejectStocktake(
        rejectCtx(
          {},
          {
            params: { id: STOCKTAKE_ID },
            headers: { 'if-match': '"2"' },
            body: { confirm: true },
          },
        ),
      ),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      rejectStocktake(
        rejectCtx(
          {},
          {
            params: { id: STOCKTAKE_ID },
            headers: { 'if-match': '"2"' },
            body: { reason: '依据不足' },
          },
        ),
      ),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      rejectStocktake(
        rejectCtx(
          {},
          {
            params: { id: STOCKTAKE_ID },
            body: { confirm: true, reason: '依据不足' },
          },
        ),
      ),
      'PRECONDITION_REQUIRED',
    );
    await expectAppError(
      rejectStocktake(
        rejectCtx(
          {},
          {
            params: { id: STOCKTAKE_ID },
            headers: { 'if-match': '"9"' },
            body: { confirm: true, reason: '依据不足' },
          },
        ),
      ),
      'VERSION_CONFLICT',
    );
  });

  it('权限与 AI：无 stocktake.approve → 403；AI 缺 reason → 422，给 reason 仍 403', async () => {
    await expectAppError(
      rejectStocktake(
        rejectCtx(
          { scope: READ_ONLY_SCOPE },
          {
            params: { id: APPROVED_STOCKTAKE_ID },
            headers: { 'if-match': '"2"' },
            body: { confirm: true, reason: '依据不足' },
          },
        ),
      ),
      'FORBIDDEN',
    );

    const ai = principal({
      actorType: 'ai',
      actorId: 'ai-token',
      employeeId: DEMO_IDS.ownerEmployeeId,
      credentialType: 'api_token',
      source: 'ai',
    });

    await expectAppError(
      rejectStocktake(
        rejectCtx(
          { ...ai },
          {
            params: { id: APPROVED_STOCKTAKE_ID },
            headers: { 'if-match': '"2"' },
            body: { confirm: true, reason: '依据不足' },
          },
        ),
      ),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      rejectStocktake(
        rejectCtx(
          { ...ai },
          {
            params: { id: APPROVED_STOCKTAKE_ID },
            headers: { 'if-match': '"2"' },
            body: { confirm: true, reason: '依据不足' },
            auditReason: 'AI 尝试驳回盘点',
          },
        ),
      ),
      'AI_ACTION_FORBIDDEN',
    );
  });
});
