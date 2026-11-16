import { AppError } from '@qingdan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import { applyStockAdjustment } from './stock-flow.js';

/**
 * 库存调整守卫文案（#269）。
 *
 * 同一条守卫被销售完成（E）、加工领料（B）、盘点审批（stocktake）共用；
 * 这里直接打服务函数，验证「来源单据 → 动作文案」映射、批次标识兜底与错误码不变。
 */

const PRODUCT_ID = '01900000-0000-7000-8000-000000000101';
const BATCH_ID = '01900000-0000-7000-8000-000000000121';
const SOURCE_DOC_ID = '01900000-0000-7000-8000-000000000111';
const BATCH_NO = 'ADJUST-269';

describe('inventory applyStockAdjustment 文案（#269）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, specification, unit)
       VALUES ($1, $2, $3, 'P-269', '调整文案商品', '{}', NULL, '件')`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    // 可用量 = 5 - 5 = 0：扣 1 必然触发「可用量将为负」，但入库量仍非负。
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, $5, '10', '5', '5', '0', '0', $6)`,
      [
        BATCH_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        BATCH_NO,
        DEMO_IDS.ownerEmployeeId,
      ],
    );
  }, 60_000);

  afterAll(async () => {
    await test.database.close();
  });

  async function adjust(sourceDocType: string): Promise<unknown> {
    return withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
      applyStockAdjustment(tx, {
        tenantId: DEMO_IDS.tenantId,
        companyId: DEMO_IDS.companyId,
        batchId: BATCH_ID,
        delta: '-1',
        sourceDocType,
        sourceDocId: SOURCE_DOC_ID,
        handledBy: DEMO_IDS.warehouseEmployeeId,
      }),
    ).catch((error: unknown) => error);
  }

  function messageOf(error: unknown): string {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).message;
  }

  it('来源单据没有对应动作时用中性文案，并带批次号与批次 id', async () => {
    // S = 供应商退货：不在本期四类动作内，走中性兜底。
    const failure = await adjust('S');
    const message = messageOf(failure);
    expect(message).toContain('该操作会使批次可用量变为负数');
    expect(message).toContain(BATCH_NO);
    expect(message).not.toContain('盘亏');
    expect(failure).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: {
        reason: 'insufficient_available_qty',
        batchId: BATCH_ID,
        batchNo: BATCH_NO,
      },
    });
  });

  it.each([
    ['E', '销售出库'],
    ['B', '加工领料'],
    ['stocktake', '盘亏调整'],
  ] as const)('来源单据 %s → 文案出现「%s」且带批次号', async (sourceDocType, label) => {
    const failure = await adjust(sourceDocType);
    const message = messageOf(failure);
    expect(message).toContain(label);
    expect(message).toContain(BATCH_NO);
    expect(failure).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('错误码固定 VERSION_CONFLICT（前端 isStaleVersionError 依赖）', async () => {
    const failure = await adjust('E');
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('VERSION_CONFLICT');
    expect((failure as AppError).status).toBe(409);
  });
});
