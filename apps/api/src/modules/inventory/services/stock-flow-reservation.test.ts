import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import {
  releasePendingReservations,
  reservePendingReservations,
} from './stock-flow.js';

const PRODUCT_ID = '01900000-0000-7000-8000-000000008001';
const BATCH_ID = '01900000-0000-7000-8000-000000008002';
const BATCH_2_ID = '01900000-0000-7000-8000-000000008003';
const DOC_ID = '01900000-0000-7000-8000-000000008004';
const OTHER_DOC_ID = '01900000-0000-7000-8000-000000008005';

describe('库存待执行占用 / 释放', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit, status)
       VALUES ($1, $2, $3, 'P-RESERVE', '占用商品', '{}', '件', '启用')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES
         ($1, $2, $3, $4, 'RESERVE-001', '10', '100', '0', '0', '0', $5),
         ($6, $2, $3, $4, 'RESERVE-002', '10', '50', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
        BATCH_2_ID,
      ],
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  async function pendingOf(batchId: string) {
    const result = await test.database.query<{
      pending_execution_qty: string;
      available_qty: string;
      version: number;
    }>(
      `SELECT trim_scale(pending_execution_qty) AS pending_execution_qty,
              trim_scale(available_qty) AS available_qty,
              version
         FROM inventory_batch
        WHERE id = $1::uuid`,
      [batchId],
    );
    return result.rows[0]!;
  }

  it('同一批次多行先累加再占用，可用量同步扣减', async () => {
    const receipt = await test.database.transaction((tx) =>
      reservePendingReservations(tx, {
        tenantId: DEMO_IDS.tenantId,
        companyId: DEMO_IDS.companyId,
        sourceDocType: 'E',
        sourceDocId: DOC_ID,
        handledBy: DEMO_IDS.ownerEmployeeId,
        lines: [
          { batchId: BATCH_ID, qty: '1.25' },
          { batchId: BATCH_ID, qty: '2.5' },
          { batchId: BATCH_2_ID, qty: '3' },
        ],
      }),
    );
    expect(receipt.lines).toEqual([
      {
        batchId: BATCH_ID,
        qty: '3.75',
        pendingAfter: '3.75',
        availableAfter: '96.25',
      },
      {
        batchId: BATCH_2_ID,
        qty: '3',
        pendingAfter: '3',
        availableAfter: '47',
      },
    ]);
    expect(await pendingOf(BATCH_ID)).toMatchObject({
      pending_execution_qty: '3.75',
      available_qty: '96.25',
    });
    expect(await pendingOf(BATCH_2_ID)).toMatchObject({
      pending_execution_qty: '3',
      available_qty: '47',
    });

    const second = await test.database.transaction((tx) =>
      reservePendingReservations(tx, {
        tenantId: DEMO_IDS.tenantId,
        companyId: DEMO_IDS.companyId,
        sourceDocType: 'B',
        sourceDocId: OTHER_DOC_ID,
        handledBy: DEMO_IDS.ownerEmployeeId,
        lines: [{ batchId: BATCH_ID, qty: '1' }],
      }),
    );
    expect(second.lines[0]).toMatchObject({
      batchId: BATCH_ID,
      pendingAfter: '4.75',
      availableAfter: '95.25',
    });
  });

  it('释放按批次精确回退；释放超额返回 409 且不改数据', async () => {
    const before = await pendingOf(BATCH_ID);
    await test.database.transaction((tx) =>
      releasePendingReservations(tx, {
        tenantId: DEMO_IDS.tenantId,
        companyId: DEMO_IDS.companyId,
        sourceDocType: 'E',
        sourceDocId: DOC_ID,
        handledBy: DEMO_IDS.ownerEmployeeId,
        lines: [{ batchId: BATCH_ID, qty: '1.75' }],
      }),
    );
    expect(await pendingOf(BATCH_ID)).toMatchObject({
      pending_execution_qty: '3',
      available_qty: '97',
    });

    const afterRelease = await pendingOf(BATCH_ID);
    await expect(
      test.database.transaction((tx) =>
        releasePendingReservations(tx, {
          tenantId: DEMO_IDS.tenantId,
          companyId: DEMO_IDS.companyId,
          sourceDocType: 'S',
          sourceDocId: OTHER_DOC_ID,
          handledBy: DEMO_IDS.ownerEmployeeId,
          lines: [{ batchId: BATCH_ID, qty: '3.01' }],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: {
        reason: 'insufficient_pending_reservation',
        sourceDocType: 'S',
        sourceDocId: OTHER_DOC_ID,
      },
    });
    expect(await pendingOf(BATCH_ID)).toEqual(afterRelease);
    expect(before.version).toBeLessThan(afterRelease.version);
  });

  it('可用量不足时整批拒绝，不产生部分占用', async () => {
    const beforeBatch = await pendingOf(BATCH_ID);
    const beforeBatch2 = await pendingOf(BATCH_2_ID);
    await expect(
      test.database.transaction((tx) =>
        reservePendingReservations(tx, {
          tenantId: DEMO_IDS.tenantId,
          companyId: DEMO_IDS.companyId,
          sourceDocType: 'B',
          sourceDocId: OTHER_DOC_ID,
          handledBy: DEMO_IDS.ownerEmployeeId,
          lines: [
            { batchId: BATCH_ID, qty: '1' },
            { batchId: BATCH_2_ID, qty: '999' },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: {
        reason: 'insufficient_available_qty',
        batchId: BATCH_2_ID,
      },
    });
    expect(await pendingOf(BATCH_ID)).toEqual(beforeBatch);
    expect(await pendingOf(BATCH_2_ID)).toEqual(beforeBatch2);
  });
});
