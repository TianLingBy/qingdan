import { AppError } from '@qingdan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../testing/pglite.js';
import { inventoryServices } from './ports.js';
import { createBatch, inspectBatches, type CreateBatchCommand } from './stock-flow.js';

const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000000099';
const PRODUCT_ID = '01900000-0000-7000-8000-000000000101';
const OTHER_PRODUCT_ID = '01900000-0000-7000-8000-000000000102';
const SOURCE_DOC_ID = '01900000-0000-7000-8000-000000000111';

const BASE_COMMAND: CreateBatchCommand = {
  tenantId: DEMO_IDS.tenantId,
  companyId: DEMO_IDS.companyId,
  productId: PRODUCT_ID,
  qty: '12.5',
  lockedUnitCost: '8.25',
  custodianId: DEMO_IDS.ownerEmployeeId,
  handledBy: DEMO_IDS.warehouseEmployeeId,
  sourceDocType: 'A',
  sourceDocId: SOURCE_DOC_ID,
};

async function insertProduct(
  test: TestDatabase,
  id: string,
  companyId: string,
  productNo: string,
  name: string,
): Promise<void> {
  await test.database.query(
    `INSERT INTO product
       (id, tenant_id, company_id, product_no, name, aliases, specification, unit, status)
     VALUES ($1, $2, $3, $4, $5, '{}', NULL, '件', '启用')`,
    [id, DEMO_IDS.tenantId, companyId, productNo, name],
  );
}

async function countRows(
  test: TestDatabase,
  table: 'inventory_batch' | 'inventory_flow',
): Promise<number> {
  const result = await test.database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id = $1`,
    [DEMO_IDS.tenantId],
  );
  return result.rows[0]?.count ?? 0;
}

async function expectAppError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('inventory createBatch（#136 / #137）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')`,
      [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await insertProduct(
      test,
      PRODUCT_ID,
      DEMO_IDS.companyId,
      'P-001',
      '成品苹果',
    );
    await insertProduct(
      test,
      OTHER_PRODUCT_ID,
      OTHER_COMPANY_ID,
      'P-002',
      '二司商品',
    );
  }, 60_000);

  afterAll(async () => {
    await test.database.close();
  });

  it('同事务创建批次与正数入库流水，返回服务端批号和保管人', async () => {
    const receipt = await withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
      createBatch(tx, BASE_COMMAND),
    );

    expect(receipt.batchNo).toMatch(/^PB-0001-\d{8}-0001$/);
    expect(receipt).toMatchObject({
      availableQty: '12.5',
      custodianId: DEMO_IDS.ownerEmployeeId,
    });

    const batch = await test.database.query<{
      product_id: string;
      batch_no: string;
      locked_unit_cost: string;
      inbound_qty: string;
      available_qty: string;
      custodian_id: string;
    }>(
      `SELECT product_id,
              batch_no,
              trim_scale(locked_unit_cost) AS locked_unit_cost,
              trim_scale(inbound_qty) AS inbound_qty,
              trim_scale(available_qty) AS available_qty,
              custodian_id
         FROM inventory_batch
        WHERE id = $1::uuid`,
      [receipt.batchId],
    );
    expect(batch.rows[0]).toEqual({
      product_id: PRODUCT_ID,
      batch_no: receipt.batchNo,
      locked_unit_cost: '8.25',
      inbound_qty: '12.5',
      available_qty: '12.5',
      custodian_id: DEMO_IDS.ownerEmployeeId,
    });

    const flows = await test.database.query<{
      delta: string;
      source_doc_type: string;
      source_doc_id: string;
      handled_by: string;
    }>(
      `SELECT trim_scale(delta) AS delta, source_doc_type, source_doc_id, handled_by
         FROM inventory_flow
        WHERE batch_id = $1::uuid`,
      [receipt.batchId],
    );
    expect(flows.rows).toEqual([
      {
        delta: '12.5',
        source_doc_type: 'A',
        source_doc_id: SOURCE_DOC_ID,
        handled_by: DEMO_IDS.warehouseEmployeeId,
      },
    ]);
  });

  it('批号按公司月流水原子递增，不重复', async () => {
    const [first, second] = await Promise.all([
      withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
        createBatch(tx, {
          ...BASE_COMMAND,
          qty: '1',
          sourceDocId: SOURCE_DOC_ID,
        }),
      ),
      withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
        createBatch(tx, {
          ...BASE_COMMAND,
          qty: '1',
          sourceDocId: SOURCE_DOC_ID,
        }),
      ),
    ]);

    expect(first.batchNo).not.toBe(second.batchNo);
    expect([first.batchNo, second.batchNo].sort()).toEqual([
      expect.stringMatching(/^PB-0001-\d{8}-0002$/),
      expect.stringMatching(/^PB-0001-\d{8}-0003$/),
    ]);
  });

  it('StockFlowPort.createBatch 已接线到真实库存服务', async () => {
    const receipt = await withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
      inventoryServices.stockFlow!.createBatch(tx, BASE_COMMAND),
    );

    expect(receipt.batchNo).toMatch(/^PB-0001-\d{8}-\d{4}$/);
    expect(receipt).toMatchObject({
      availableQty: '12.5',
      custodianId: DEMO_IDS.ownerEmployeeId,
    });
  });

  it('商品必须属于同一租户与公司', async () => {
    const before = await countRows(test, 'inventory_batch');
    await expectAppError(
      withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
        createBatch(tx, { ...BASE_COMMAND, productId: OTHER_PRODUCT_ID }),
      ),
      'VALIDATION_FAILED',
    );
    expect(await countRows(test, 'inventory_batch')).toBe(before);
  });

  it('数量必须大于 0，锁定单价不得为负，校验失败不落批次或流水', async () => {
    const beforeBatches = await countRows(test, 'inventory_batch');
    const beforeFlows = await countRows(test, 'inventory_flow');

    await expectAppError(
      withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
        createBatch(tx, { ...BASE_COMMAND, qty: '0' }),
      ),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
        createBatch(tx, { ...BASE_COMMAND, lockedUnitCost: '-0.01' }),
      ),
      'VALIDATION_FAILED',
    );

    expect(await countRows(test, 'inventory_batch')).toBe(beforeBatches);
    expect(await countRows(test, 'inventory_flow')).toBe(beforeFlows);
  });

  it('调用方事务失败时批次、流水与取号一起回滚', async () => {
    const beforeBatches = await countRows(test, 'inventory_batch');
    const beforeFlows = await countRows(test, 'inventory_flow');

    await expect(
      withTenant(test.database, DEMO_IDS.tenantId, async (tx) => {
        await createBatch(tx, { ...BASE_COMMAND, qty: '3' });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    expect(await countRows(test, 'inventory_batch')).toBe(beforeBatches);
    expect(await countRows(test, 'inventory_flow')).toBe(beforeFlows);
  });
  it('returns batch number, available quantity and locked unit cost for the requested company', async () => {
    const created = await withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
      createBatch(tx, BASE_COMMAND),
    );
    const result = await inspectBatches(test.database, {
      tenantId: DEMO_IDS.tenantId,
      companyId: DEMO_IDS.companyId,
      batchIds: [created.batchId],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      batchId: created.batchId,
      availableQty: '12.5',
      lockedUnitCost: '8.25',
    });
  });

  it('rejects a batch belonging to another company', async () => {
    const created = await withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
      createBatch(tx, BASE_COMMAND),
    );
    await expect(
      inspectBatches(test.database, {
        tenantId: DEMO_IDS.tenantId,
        companyId: OTHER_COMPANY_ID,
        batchIds: [created.batchId],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
