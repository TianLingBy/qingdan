import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * D15 数据库级防线（migrations/0027 触发器）。
 *
 * 业务层 repo.assertProductsInCompany 会被绕过（新模块、脚本、手工 SQL、批量导入），
 * 这里直接对 purchase_order_line 做原始写入，证明越权行在数据库层就落不下去。
 * 与 purchase-orders.test.ts 的 422 用例互补：那条证明**体验**，这条证明**保证**。
 */

const ORDER_ID = '01900000-0000-7000-8000-00000000b101';
const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000000303';
const SUPPLIER_ID = '01900000-0000-7000-8000-000000000301';
const PRODUCT_ID = '01900000-0000-7000-8000-000000000311';
const PRODUCT_OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000000313';
const OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000003f1';
const PRODUCT_OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000003f2';
const LINE_OTHER_TENANT_ID = '01900000-0000-7000-8000-00000000b105';

interface PgError {
  readonly code?: string;
  readonly message?: string;
}

describe('采购单明细 D15 数据库级防线（0027 触发器）', () => {
  let test: TestDatabase;

  async function insertLine(
    id: string,
    options: { companyId?: string; productId?: string; tenantId?: string; lineNo?: number } = {},
  ): Promise<PgError | undefined> {
    try {
      await test.database.query(
        `INSERT INTO purchase_order_line
           (id, tenant_id, company_id, order_id, line_no, product_id, qty, unit_price, amount)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 1)`,
        [
          id,
          options.tenantId ?? DEMO_IDS.tenantId,
          options.companyId ?? DEMO_IDS.companyId,
          ORDER_ID,
          options.lineNo ?? 1,
          options.productId ?? PRODUCT_ID,
        ],
      );
      return undefined;
    } catch (error) {
      return error as PgError;
    }
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);

    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')`,
      [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
    );
    await test.database.query(
      `INSERT INTO tenant (id, name) VALUES ($1, '第二租户')`,
      [OTHER_TENANT_ID],
    );
    await test.database.query(
      `INSERT INTO supplier
         (id, tenant_id, company_id, supplier_no, name, supplied_materials, status)
       VALUES ($1, $2, $3, NULL, '触发器用例供应商', '{}', '启用')`,
      [SUPPLIER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    for (const [id, tenantId, companyId, name] of [
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, '本司商品'],
      [PRODUCT_OTHER_COMPANY_ID, DEMO_IDS.tenantId, OTHER_COMPANY_ID, '二司商品'],
      [PRODUCT_OTHER_TENANT_ID, OTHER_TENANT_ID, OTHER_COMPANY_ID, '别租户商品'],
    ] as const) {
      await test.database.query(
        `INSERT INTO product
           (id, tenant_id, company_id, product_no, name, aliases, unit, status)
         VALUES ($1, $2, $3, NULL, $4, '{}', '件', '启用')`,
        [id, tenantId, companyId, name],
      );
    }
    await test.database.query(
      `INSERT INTO purchase_order (id, tenant_id, company_id, order_no, supplier_id, handler_id)
       VALUES ($1, $2, $3, 'A-D15-DB-0001', $4, $5)`,
      [ORDER_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, SUPPLIER_ID, DEMO_IDS.ownerEmployeeId],
    );
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('同公司商品可以落库（防线不误伤正常写入）', async () => {
    expect(await insertLine('01900000-0000-7000-8000-00000000b102', { lineNo: 1 })).toBeUndefined();
  });

  it('跨公司商品：触发器以 23514 + D15 前缀拒绝', async () => {
    const error = await insertLine('01900000-0000-7000-8000-00000000b103', {
      productId: PRODUCT_OTHER_COMPANY_ID,
      lineNo: 2,
    });
    expect(error?.code).toBe('23514');
    expect(error?.message).toMatch(/^D15: 商品 .* 属于公司 .*，不属于采购单公司/);
  });

  it('改单把商品换成他公司商品同样被拒（UPDATE 路径）', async () => {
    let error: PgError | undefined;
    try {
      await test.database.query(`UPDATE purchase_order_line SET product_id = $2 WHERE id = $1`, [
        '01900000-0000-7000-8000-00000000b102',
        PRODUCT_OTHER_COMPANY_ID,
      ]);
    } catch (caught) {
      error = caught as PgError;
    }
    expect(error?.code).toBe('23514');
    expect(error?.message).toMatch(/^D15: 商品/);
  });

  it('行的公司字段与单头不一致被拒', async () => {
    const error = await insertLine('01900000-0000-7000-8000-00000000b104', {
      companyId: OTHER_COMPANY_ID,
      productId: PRODUCT_OTHER_COMPANY_ID,
      lineNo: 3,
    });
    expect(error?.code).toBe('23514');
    expect(error?.message).toMatch(/^D15:/);
  });

  it('跨租户商品按「不存在」处理，越不了租户隔离', async () => {
    const error = await insertLine(LINE_OTHER_TENANT_ID, {
      productId: PRODUCT_OTHER_TENANT_ID,
      lineNo: 4,
    });
    expect(error?.code).toBe('23514');
    expect(error?.message).toMatch(/^D15: 采购单行引用的商品不存在或不属于同一租户/);
  });
});
