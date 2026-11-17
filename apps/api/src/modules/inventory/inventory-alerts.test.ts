import { AppError, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../platform/auth/principal.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { listInventoryAlerts } from './usecases/alerts.js';

/**
 * 低库存预警（#354 第 2 条 / D104）。
 *
 * 一份 PGlite 库跑完整套迁移 + 种子，再插本文件自己的商品/批次/流水。
 * 所有流水时间都跟着 `now()` 走（`daysAgo()`），否则测试会在某天之后集体失效。
 */

const COMPANY_2_ID = '01900000-0000-7000-8000-000000000099';

const PRODUCT_LOW_ID = '01900000-0000-7000-8000-000000000201';
const PRODUCT_AMPLE_ID = '01900000-0000-7000-8000-000000000202';
const PRODUCT_NEW_ID = '01900000-0000-7000-8000-000000000203';
const PRODUCT_EDGE_ID = '01900000-0000-7000-8000-000000000204';
const PRODUCT_EMPTY_ID = '01900000-0000-7000-8000-000000000205';
const PRODUCT_STALE_ID = '01900000-0000-7000-8000-000000000206';
const PRODUCT_OTHER_ID = '01900000-0000-7000-8000-000000000207';

const BATCH_LOW_ID = '01900000-0000-7000-8000-000000000211';
const BATCH_AMPLE_ID = '01900000-0000-7000-8000-000000000212';
const BATCH_NEW_ID = '01900000-0000-7000-8000-000000000213';
const BATCH_EDGE_ID = '01900000-0000-7000-8000-000000000214';
const BATCH_EMPTY_ID = '01900000-0000-7000-8000-000000000215';
const BATCH_STALE_ID = '01900000-0000-7000-8000-000000000216';
const BATCH_OTHER_ID = '01900000-0000-7000-8000-000000000217';

const FLOW_IDS = [
  '01900000-0000-7000-8000-000000000221',
  '01900000-0000-7000-8000-000000000222',
  '01900000-0000-7000-8000-000000000223',
  '01900000-0000-7000-8000-000000000224',
  '01900000-0000-7000-8000-000000000225',
  '01900000-0000-7000-8000-000000000226',
  '01900000-0000-7000-8000-000000000227',
];
const SOURCE_ID = '01900000-0000-7000-8000-000000000231';

const INVENTORY_SCOPE: ScopeMatrix = [{ domain: 'inventory_qty', actions: ['read'] }];

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
    credentialId: 'session-inventory-alert-test',
    companyIds: [DEMO_IDS.companyId, COMPANY_2_ID],
    scope: INVENTORY_SCOPE,
    source: 'web',
    credentialType: 'session',
    sessionRenewed: false,
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  const error = (await promise.catch((caught: unknown) => caught)) as AppError;
  expect(error.code).toBe(code);
  return error;
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
       (id, tenant_id, company_id, product_no, name, aliases, specification, unit)
     VALUES ($1, $2, $3, $4, $5, '{}', NULL, '件')`,
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
    referencedQty?: string;
  },
): Promise<void> {
  await test.database.query(
    `INSERT INTO inventory_batch
       (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
        inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
     VALUES ($1, $2, $3, $4, $5, '12.500000', $6, $7, '0', '0', $8)`,
    [
      input.id,
      DEMO_IDS.tenantId,
      input.companyId,
      input.productId,
      input.batchNo,
      input.inboundQty,
      input.referencedQty ?? '0',
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
  occurredAt: string,
): Promise<void> {
  await test.database.query(
    `INSERT INTO inventory_flow
       (id, tenant_id, company_id, batch_id, delta, source_doc_type, source_doc_id,
        handled_by, occurred_at)
     VALUES ($1, $2, $3, $4, $5, 'E', $6, $7, $8)`,
    [
      id,
      DEMO_IDS.tenantId,
      companyId,
      batchId,
      delta,
      SOURCE_ID,
      DEMO_IDS.ownerEmployeeId,
      occurredAt,
    ],
  );
}

describe('低库存预警（#354 / D104）', () => {
  let test: TestDatabase;

  function ctx(query: Record<string, unknown>, overrides: Partial<Principal> = {}) {
    return {
      database: test.database,
      request: makeRequest({ principal: principal(overrides), query }),
    };
  }

  function companyQuery(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { companyId: DEMO_IDS.companyId, ...extra };
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

    await insertProduct(test, PRODUCT_LOW_ID, DEMO_IDS.companyId, '小麦', 'P-201');
    await insertProduct(test, PRODUCT_AMPLE_ID, DEMO_IDS.companyId, '大豆', 'P-202');
    await insertProduct(test, PRODUCT_NEW_ID, DEMO_IDS.companyId, '新进玉米', 'P-203');
    await insertProduct(test, PRODUCT_EDGE_ID, DEMO_IDS.companyId, '边界大米', 'P-204');
    await insertProduct(test, PRODUCT_EMPTY_ID, DEMO_IDS.companyId, '断货高粱', 'P-205');
    await insertProduct(test, PRODUCT_STALE_ID, DEMO_IDS.companyId, '陈年绿豆', 'P-206');
    await insertProduct(test, PRODUCT_OTHER_ID, COMPANY_2_ID, '二司香蕉', 'P-207');

    // 10 件可用、近 30 天出了 60 件 → 日均 2 件/天，8.4 天门槛 = 16.8 → 预警，daysLeft = 5。
    await insertBatch(test, {
      id: BATCH_LOW_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_LOW_ID,
      batchNo: 'ALERT-LOW',
      inboundQty: '10',
    });
    await insertFlow(test, FLOW_IDS[0]!, DEMO_IDS.companyId, BATCH_LOW_ID, '-60', daysAgo(5));

    // 同样日均 2，但可用 1000 → 远超门槛，不进预警。
    await insertBatch(test, {
      id: BATCH_AMPLE_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_AMPLE_ID,
      batchNo: 'ALERT-AMPLE',
      inboundQty: '1000',
    });
    await insertFlow(test, FLOW_IDS[1]!, DEMO_IDS.companyId, BATCH_AMPLE_ID, '-60', daysAgo(5));

    // 新进的货：可用只有 5 件，但一条出库流水都没有 → 不进预警（D104③）。
    await insertBatch(test, {
      id: BATCH_NEW_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_NEW_ID,
      batchNo: 'ALERT-NEW',
      inboundQty: '5',
    });

    // 边界值：日均 2 → 7 天 = 14、8.4 天 = 16.8，可用 15 只被默认提前量 0.2 收进来。
    await insertBatch(test, {
      id: BATCH_EDGE_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_EDGE_ID,
      batchNo: 'ALERT-EDGE',
      inboundQty: '15',
    });
    await insertFlow(test, FLOW_IDS[2]!, DEMO_IDS.companyId, BATCH_EDGE_ID, '-60', daysAgo(5));

    // 已断货：入库 60 全被引用掉，可用 0，但有历史出库 → daysLeft = floor(0/2) = 0。
    await insertBatch(test, {
      id: BATCH_EMPTY_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_EMPTY_ID,
      batchNo: 'ALERT-EMPTY',
      inboundQty: '60',
      referencedQty: '60',
    });
    await insertFlow(test, FLOW_IDS[3]!, DEMO_IDS.companyId, BATCH_EMPTY_ID, '-60', daysAgo(5));

    // 出库发生在 40 天前：出 30 天窗口，日均按 0 算 → 不进预警（不上报「陈年数据」）。
    await insertBatch(test, {
      id: BATCH_STALE_ID,
      companyId: DEMO_IDS.companyId,
      productId: PRODUCT_STALE_ID,
      batchNo: 'ALERT-STALE',
      inboundQty: '5',
    });
    await insertFlow(test, FLOW_IDS[4]!, DEMO_IDS.companyId, BATCH_STALE_ID, '-60', daysAgo(40));

    // 别家公司同样断货：无论怎么查都不该出现在本公司的预警里（公司隔离，D15）。
    await insertBatch(test, {
      id: BATCH_OTHER_ID,
      companyId: COMPANY_2_ID,
      productId: PRODUCT_OTHER_ID,
      batchNo: 'ALERT-OTHER',
      inboundQty: '10',
    });
    await insertFlow(test, FLOW_IDS[5]!, COMPANY_2_ID, BATCH_OTHER_ID, '-60', daysAgo(5));
  });

  afterAll(async () => {
    await test.client.close();
  });

  it('用例 1：有历史出库且可用量低于门槛 → 进预警，daysLeft/avgDailyOut 数值正确', async () => {
    const { items } = await listInventoryAlerts(ctx(companyQuery()));
    const low = items.find((item) => item.batchId === BATCH_LOW_ID);
    expect(low).toBeDefined();
    expect(low).toMatchObject({
      productId: PRODUCT_LOW_ID,
      productName: '小麦',
      batchNo: 'ALERT-LOW',
      availableQty: '10.000000',
      // 60 件 / 30 天 = 2.000000（6 位四舍五入）
      avgDailyOut: '2.000000',
      // floor(10 / 2) = 5，且 5 天 < 8.4 天
      daysLeft: 5,
    });
  });

  it('用例 2：有历史出库但库存充足 → 不进预警', async () => {
    const { items } = await listInventoryAlerts(ctx(companyQuery()));
    expect(items.map((item) => item.batchId)).not.toContain(BATCH_AMPLE_ID);
  });

  it('用例 3：新进货无历史出库 → 不进预警（最容易写错的一条）', async () => {
    const { items } = await listInventoryAlerts(ctx(companyQuery()));
    expect(items.map((item) => item.batchId)).not.toContain(BATCH_NEW_ID);
    // 窗口外的陈年出库同样不算「历史」：40 天前的出库不该把新批次推进预警。
    expect(items.map((item) => item.batchId)).not.toContain(BATCH_STALE_ID);
  });

  it('用例 4：已断货（可用 0 但有历史出库）→ daysLeft 为 0，且仍进预警', async () => {
    const { items } = await listInventoryAlerts(ctx(companyQuery()));
    const empty = items.find((item) => item.batchId === BATCH_EMPTY_ID);
    expect(empty).toBeDefined();
    expect(empty?.availableQty).toBe('0.000000');
    expect(empty?.daysLeft).toBe(0);
    // 排序：最紧急（daysLeft 最小）在最前，0 天排第一。
    expect(items[0]?.batchId).toBe(BATCH_EMPTY_ID);
  });

  it('用例 5：别家公司 companyId → 403，响应体里没有 items', async () => {
    const error = await expectAppError(
      listInventoryAlerts(ctx(companyQuery({ companyId: COMPANY_2_ID }), { companyIds: [DEMO_IDS.companyId] })),
      'FORBIDDEN',
    );
    expect(JSON.stringify(error)).not.toContain('items');
  });

  it('用例 5b：自家公司查询不带别家公司的批次（公司隔离）', async () => {
    const { items } = await listInventoryAlerts(ctx(companyQuery()));
    expect(items.map((item) => item.batchId)).not.toContain(BATCH_OTHER_ID);
  });

  it('用例 6：thresholdRatio 越界（1.5）→ 422 VALIDATION_FAILED', async () => {
    await expectAppError(listInventoryAlerts(ctx(companyQuery({ thresholdRatio: '1.5' }))), 'VALIDATION_FAILED');
    // 负数同样越界。
    await expectAppError(listInventoryAlerts(ctx(companyQuery({ thresholdRatio: '-0.1' }))), 'VALIDATION_FAILED');
  });

  it('用例 7：thresholdRatio 缺省 → 用 0.2（不报 422），边界批次被收进来', async () => {
    const { items } = await listInventoryAlerts(ctx(companyQuery()));
    // 15 < 2 × 7 × 1.2 = 16.8 → 进；若缺省被当成 0，15 < 14 不成立 → 不进。
    expect(items.map((item) => item.batchId)).toContain(BATCH_EDGE_ID);
    expect(items.find((item) => item.batchId === BATCH_EDGE_ID)?.daysLeft).toBe(7);

    const explicitZero = await listInventoryAlerts(ctx(companyQuery({ thresholdRatio: '0' })));
    expect(explicitZero.items.map((item) => item.batchId)).not.toContain(BATCH_EDGE_ID);
    // 显式 0 仍保留 7 天窗口：10 < 14 的小麦照旧预警。
    expect(explicitZero.items.map((item) => item.batchId)).toContain(BATCH_LOW_ID);
  });

  it('用例 8：companyId 缺失 → 422（必传，不接受服务端猜默认公司）', async () => {
    await expectAppError(listInventoryAlerts(ctx({})), 'VALIDATION_FAILED');
  });

  it('用例 9：缺 inventory_qty.read 权限 → 403', async () => {
    await expectAppError(
      listInventoryAlerts(ctx(companyQuery(), { scope: [{ domain: 'inventory_flow', actions: ['read'] }] })),
      'FORBIDDEN',
    );
  });

  it('用例 10：一次返回全部命中项，整体按 daysLeft 升序', async () => {
    const { items } = await listInventoryAlerts(ctx(companyQuery()));
    const days = items.map((item) => item.daysLeft);
    expect(days).toEqual([...days].sort((left, right) => left - right));
    expect(items.map((item) => item.batchId)).toEqual([BATCH_EMPTY_ID, BATCH_LOW_ID, BATCH_EDGE_ID]);
  });
});
