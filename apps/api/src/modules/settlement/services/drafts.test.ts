import { AppError } from '@qingdan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flushAuditOutbox } from '../../../platform/audit/writer.js';
import type { SqlClient } from '../../../platform/db/client.js';
import { DEMO_IDS, seed } from '../../../platform/db/seed.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../testing/pglite.js';
import { createSettlementDraft } from './drafts.js';

/**
 * C 结算单草稿端口（D70 / D19）。
 *
 * 验证三件事：同事务写入成功、来源单唯一（重复生成 409）、调用方回滚时草稿与审计一起消失。
 */

const SOURCE_DOC_ID = '01900000-0000-7000-8000-000000009001';

describe('SettlementDraftPort.createDraft（D70 模块间调用通道）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
  });

  afterAll(async () => {
    await test.database.close();
  });

  async function inTenant<T>(work: (tx: SqlClient) => Promise<T>): Promise<T> {
    return test.database.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [DEMO_IDS.tenantId]);
      return work(tx);
    });
  }

  it('同事务生成草稿：金额由调用方传入，毛利/净利/毛利率由 SQL 算', async () => {
    const receipt = await inTenant((tx) =>
      createSettlementDraft(tx, {
        tenantId: DEMO_IDS.tenantId,
        companyId: DEMO_IDS.companyId,
        sourceDocType: 'E',
        sourceDocId: SOURCE_DOC_ID,
        totalSaleAmount: '1000',
        totalCostAmount: '700',
        relatedLossAmount: '50',
        commissionRateSnapshot: '0.02',
        commissionAmount: '20',
        createdBy: DEMO_IDS.ownerEmployeeId,
        requestId: 'req-port-draft-1',
      }),
    );

    expect(receipt.orderNo).toMatch(/^C-0001-\d{8}-\d{4}$/);
    expect(receipt.version).toBe(1);

    const row = await test.database.query<{
      total_sale_amount: string;
      gross_profit: string;
      gross_margin_rate: string;
      net_profit: string;
      status: string;
    }>(
      `SELECT trim_scale(total_sale_amount) AS total_sale_amount,
              trim_scale(gross_profit) AS gross_profit,
              trim_scale(gross_margin_rate) AS gross_margin_rate,
              trim_scale(net_profit) AS net_profit,
              status
         FROM settlement_order WHERE id = $1::uuid`,
      [receipt.id],
    );
    expect(row.rows[0]).toMatchObject({
      total_sale_amount: '1000',
      gross_profit: '300',
      gross_margin_rate: '0.3',
      net_profit: '250',
      status: '待确认',
    });

    // 实现方各记各的审计：outbox 里有一行指向本单（D70 ④）。
    const outbox = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_outbox WHERE id = $1::uuid`,
      [receipt.auditId],
    );
    expect(outbox.rows[0]?.n).toBe(1);
    await flushAuditOutbox(test.database, receipt.auditId, DEMO_IDS.tenantId);
  });

  it('同一来源单只允许一张 C 单：重复生成 409', async () => {
    const error = await inTenant((tx) =>
      createSettlementDraft(tx, {
        tenantId: DEMO_IDS.tenantId,
        companyId: DEMO_IDS.companyId,
        sourceDocType: 'E',
        sourceDocId: SOURCE_DOC_ID,
        totalSaleAmount: '1000',
        totalCostAmount: '700',
        commissionRateSnapshot: '0.02',
        commissionAmount: '20',
        createdBy: DEMO_IDS.ownerEmployeeId,
      }).catch((caught: unknown) => caught),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VERSION_CONFLICT');
  });

  it('调用方回滚时草稿一起消失（同事务同回滚）', async () => {
    const otherSource = '01900000-0000-7000-8000-000000009002';
    await expect(
      test.database.transaction(async (tx) => {
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [DEMO_IDS.tenantId]);
        await createSettlementDraft(tx, {
          tenantId: DEMO_IDS.tenantId,
          companyId: DEMO_IDS.companyId,
          sourceDocType: 'N',
          sourceDocId: otherSource,
          totalSaleAmount: '500',
          totalCostAmount: '400',
          commissionRateSnapshot: '0.01',
          commissionAmount: '5',
          createdBy: DEMO_IDS.ownerEmployeeId,
        });
        throw new Error('来源单事务失败，整体回滚');
      }),
    ).rejects.toThrow('来源单事务失败');

    const rows = await test.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM settlement_order WHERE source_doc_id = $1::uuid`,
      [otherSource],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });
});
