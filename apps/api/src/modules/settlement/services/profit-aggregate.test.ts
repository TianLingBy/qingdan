import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../../testing/pglite.js';
import { aggregateSettledProfit } from './profit-aggregate.js';

/**
 * 已结算 C 单毛利期间聚合端口（D43 / #97 / Issue #185）。
 *
 * 覆盖：期间内已结算单的毛利/净利累加、待确认与期间外不计、跨公司隔离、空集返回 '0'、
 * 期间按本地日期（Asia/Shanghai）切分。
 */

const OTHER_COMPANY_ID = '01900000-0000-7000-8000-000000008001';

let test: TestDatabase;

interface InsertInput {
  readonly id: string;
  readonly companyId?: string;
  readonly status?: '待确认' | '已结算';
  /** 销售额与成本额：毛利 = 销售 − 成本（表约束要求）。 */
  readonly saleAmount: number;
  readonly costAmount: number;
  readonly relatedLoss?: number;
  readonly updatedAt: string;
  readonly sourceDocType?: 'E' | 'N';
}

async function insertSettlement(input: InsertInput): Promise<void> {
  const gross = input.saleAmount - input.costAmount;
  const loss = input.relatedLoss ?? 0;
  const status = input.status ?? '已结算';
  const settled = status === '已结算';
  await test.database.query(
    `INSERT INTO settlement_order
       (id, tenant_id, company_id, order_no, source_doc_type, source_doc_id,
        status, total_sale_amount, total_cost_amount, gross_profit, gross_margin_rate,
        related_loss_amount, related_loss_amount_snapshot, net_profit,
        commission_rate_snapshot, commission_amount, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid, $7,
             $8::numeric, $9::numeric, $10::numeric, '0', $11::numeric,
             $12::numeric, $13::numeric, '0', '0', $14::timestamptz)`,
    [
      input.id,
      DEMO_IDS.tenantId,
      input.companyId ?? DEMO_IDS.companyId,
      `C-${input.id.slice(-6)}`,
      input.sourceDocType ?? 'E',
      input.id,
      status,
      input.saleAmount,
      input.costAmount,
      gross,
      loss,
      settled ? loss : null,
      gross - loss,
      input.updatedAt,
    ],
  );
}

const QUERY = {
  tenantId: DEMO_IDS.tenantId,
  companyIds: [DEMO_IDS.companyId],
  periodStart: '2026-03-01',
  periodEnd: '2026-03-31',
} as const;

beforeAll(async () => {
  test = await createTestDatabase();
  await seed(test.database);
  await test.database.query(
    `INSERT INTO company (id, tenant_id, name, code, level, status)
     VALUES ($1, $2, '报表二公司', '0002', 1, '启用')
     ON CONFLICT (id) DO NOTHING`,
    [OTHER_COMPANY_ID, DEMO_IDS.tenantId],
  );
  // 2026-03-10 10:00（上海）= 02:00Z：期间内、已结算，毛利 300 − 相关损失 50 = 净利 250。
  await insertSettlement({
    id: '01900000-0000-7000-8000-000000005101',
    saleAmount: 1000,
    costAmount: 700,
    relatedLoss: 50,
    updatedAt: '2026-03-10T02:00:00Z',
  });
  // 2026-03-31 23:30（上海）= 15:30Z：期间最后一天，仍计入；负毛利。
  await insertSettlement({
    id: '01900000-0000-7000-8000-000000005102',
    saleAmount: 1000,
    costAmount: 1050,
    updatedAt: '2026-03-31T15:30:00Z',
  });
  // 待确认：不计入。
  await insertSettlement({
    id: '01900000-0000-7000-8000-000000005103',
    status: '待确认',
    saleAmount: 999,
    costAmount: 0,
    updatedAt: '2026-03-15T02:00:00Z',
  });
  // 期间外（4 月）：不计入 3 月。
  await insertSettlement({
    id: '01900000-0000-7000-8000-000000005104',
    saleAmount: 777,
    costAmount: 0,
    updatedAt: '2026-04-01T02:00:00Z',
  });
  // 其他公司：不计入。
  await insertSettlement({
    id: '01900000-0000-7000-8000-000000005105',
    companyId: OTHER_COMPANY_ID,
    saleAmount: 555,
    costAmount: 0,
    updatedAt: '2026-03-12T02:00:00Z',
  });
});

afterAll(async () => {
  await test.database.close();
});

describe('aggregateSettledProfit', () => {
  it('期间内已结算单累加毛利与净利，返回参与汇总的单数', async () => {
    const result = await aggregateSettledProfit(test.database, QUERY);
    expect(result).toEqual({
      grossProfit: '250',
      netProfit: '200',
      settledOrderCount: 2,
    });
  });

  it('companyIds 收口到指定公司，跨公司不串', async () => {
    const result = await aggregateSettledProfit(test.database, {
      ...QUERY,
      companyIds: [OTHER_COMPANY_ID],
    });
    expect(result).toEqual({
      grossProfit: '555',
      netProfit: '555',
      settledOrderCount: 1,
    });
  });

  it('期间按本地日期切分：跨时区边界不误算', async () => {
    // 上海 2026-04-01 00:30 = 2026-03-31T16:30Z，本地日期已进 4 月。
    await insertSettlement({
      id: '01900000-0000-7000-8000-000000005106',
      saleAmount: 10,
      costAmount: 0,
      updatedAt: '2026-03-31T16:30:00Z',
    });
    try {
      const march = await aggregateSettledProfit(test.database, QUERY);
      expect(march.settledOrderCount).toBe(2);
      const april = await aggregateSettledProfit(test.database, {
        ...QUERY,
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
      });
      expect(april.settledOrderCount).toBe(2);
      expect(april.grossProfit).toBe('787');
    } finally {
      await test.database.query(`DELETE FROM settlement_order WHERE id = $1::uuid`, [
        '01900000-0000-7000-8000-000000005106',
      ]);
    }
  });

  it('期间内无单返回 0 而不是报错', async () => {
    const result = await aggregateSettledProfit(test.database, {
      ...QUERY,
      periodStart: '2025-01-01',
      periodEnd: '2025-01-31',
    });
    expect(result).toEqual({ grossProfit: '0', netProfit: '0', settledOrderCount: 0 });
  });

  it('空公司集合返回 0', async () => {
    const result = await aggregateSettledProfit(test.database, { ...QUERY, companyIds: [] });
    expect(result).toEqual({ grossProfit: '0', netProfit: '0', settledOrderCount: 0 });
  });
});
