import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../platform/auth/principal.js';
import type { Database, SqlClient } from '../../platform/db/client.js';
import type {
  ProcessingLossAggregateSource,
  SettlementProfitAggregateSource,
} from '../../platform/services/registry.js';
import { getProfitReport, listProfitLosses } from './usecases/profit-report.js';

const COMPANY_1 = '00000000-0000-4000-8000-000000000001';
const COMPANY_2 = '00000000-0000-4000-8000-000000000002';

function principal(withPrice: boolean): Principal {
  return {
    actorType: 'employee',
    actorId: 'employee-1',
    tenantId: 'tenant-1',
    employeeId: 'employee-1',
    credentialId: 'session-1',
    companyIds: [COMPANY_1, COMPANY_2],
    scope: [
      {
        domain: 'profit_report',
        actions: withPrice ? ['read', 'view_price'] : ['read'],
      },
    ],
    source: 'web',
    credentialType: 'session',
    sessionRenewed: false,
  };
}

function database() {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const tx = { query } as unknown as SqlClient;
  return {
    query,
    db: {
      transaction: async <T>(fn: (client: SqlClient) => Promise<T>) => fn(tx),
    } as unknown as Database,
  };
}

function request(input: {
  principal: Principal;
  query: Record<string, unknown>;
}): FastifyRequest {
  return {
    principal: input.principal,
    query: input.query,
  } as unknown as FastifyRequest;
}

function ports(grossProfit = '100.25', lossAmount = '30.10') {
  const settlement: SettlementProfitAggregateSource = {
    aggregateSettledProfit: vi.fn(async () => ({
      grossProfit,
      netProfit: grossProfit,
      settledOrderCount: 3,
    })),
  };
  const processing: ProcessingLossAggregateSource = {
    aggregateFullLoss: vi.fn(async () => ({
      lossAmount,
      orders: [
        {
          processingOrderId: 'processing-1',
          processingOrderNo: 'B-0001-20261110-0001',
          lossAmount,
          attributed: false,
        },
      ],
    })),
  };
  return { settlement, processing };
}

describe('利润报表编排（#97）', () => {
  it('有看价权限：汇总毛利、全损耗并精确计算净毛利', async () => {
    const { db } = database();
    const aggregatePorts = ports();
    const report = await getProfitReport(
      {
        database: db,
        request: request({
          principal: principal(true),
          query: { periodStart: '2026-11-01', periodEnd: '2026-11-30' },
        }),
      },
      aggregatePorts,
    );

    expect(report).toEqual({
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      grossProfit: '100.25',
      fullLossAmount: '30.10',
      netProfit: '70.15',
      unattributedLoss: null,
      unattributedLossAvailable: false,
      settledOrderCount: 3,
    });
    expect(aggregatePorts.settlement.aggregateSettledProfit).toHaveBeenCalledWith(
      expect.anything(),
      {
        tenantId: 'tenant-1',
        companyIds: [COMPANY_1, COMPANY_2],
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
      },
    );
  });

  it('无看价权限：金额保留字段但全部为 null，不返回 0', async () => {
    const { db } = database();
    const report = await getProfitReport(
      {
        database: db,
        request: request({
          principal: principal(false),
          query: { periodStart: '2026-11-01', periodEnd: '2026-11-30' },
        }),
      },
      ports('-12.50', '4.25'),
    );

    expect(report.grossProfit).toBeNull();
    expect(report.fullLossAmount).toBeNull();
    expect(report.netProfit).toBeNull();
    expect(report.settledOrderCount).toBe(3);
  });

  it('显式请求不可见公司时拒绝，不调用聚合端口', async () => {
    const { db } = database();
    const aggregatePorts = ports();
    const outsider = '00000000-0000-4000-8000-000000000099';
    await expect(
      getProfitReport(
        {
          database: db,
          request: request({
            principal: principal(true),
            query: {
              periodStart: '2026-11-01',
              periodEnd: '2026-11-30',
              companyIds: [outsider],
            },
          }),
        },
        aggregatePorts,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(aggregatePorts.settlement.aggregateSettledProfit).not.toHaveBeenCalled();
  });

  it('期间起止倒置返回 VALIDATION_FAILED', async () => {
    const { db } = database();
    await expect(
      getProfitReport(
        {
          database: db,
          request: request({
            principal: principal(true),
            query: { periodStart: '2026-12-01', periodEnd: '2026-11-30' },
          }),
        },
        ports(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('损失下钻同样按看价权限脱敏', async () => {
    const { db } = database();
    const result = await listProfitLosses(
      {
        database: db,
        request: request({
          principal: principal(false),
          query: { periodStart: '2026-11-01', periodEnd: '2026-11-30' },
        }),
      },
      ports(),
    );

    expect(result.items).toEqual([
      {
        processingOrderId: 'processing-1',
        processingOrderNo: 'B-0001-20261110-0001',
        lossAmount: null,
        attributed: false,
      },
    ]);
  });
});
