import type { SqlClient } from '../../../platform/db/client.js';
import type {
  ProfitAggregateQuery,
  SettlementProfitAggregate,
  SettlementProfitAggregateSource,
} from '../../../platform/services/registry.js';

/**
 * 已结算 C 单毛利期间聚合（D43 / #97 / Issue #185）。
 *
 * 口径（`packages/contracts/src/profit-report.ts`）：
 * - 期间按 **结算确认时间**落在 `[periodStart, periodEnd]` 的**本地日期**内；
 *   确认结算在同一条原子 UPDATE 里推进 `settlement_order.updated_at`（repo.ts confirm），
 *   草稿生成后的编辑不会改动 `updated_at`，所以它等价于「结算完成时间」；
 * - 只统计 `status = '已结算'` 的 C 单；
 * - 直接汇总 C 单落库的 `gross_profit` / `net_profit`：毛利按 D5 在确认时已由 SQL 算好，
 *   净毛利 = 毛利 − 本单相关损失（D33），报表层只做期间累加，不重复计算；
 * - 空集返回 `'0'`：报表「期间内无已结算单」是合法结果，与端口未注册（`NOT_IMPLEMENTED`）区分；
 * - 金额一律 decimal 字符串（D54），用 `trim_scale` 去掉无意义尾零。
 */
function appTimezone(): string {
  const value = process.env.APP_TIMEZONE?.trim();
  return value && value.length > 0 ? value : 'Asia/Shanghai';
}

export async function aggregateSettledProfit(
  tx: SqlClient,
  query: ProfitAggregateQuery,
): Promise<SettlementProfitAggregate> {
  const result = await tx.query<{
    gross_profit: string;
    net_profit: string;
    settled_order_count: string;
  }>(
    `SELECT trim_scale(COALESCE(sum(gross_profit), 0)::numeric)::text AS gross_profit,
            trim_scale(COALESCE(sum(net_profit), 0)::numeric)::text  AS net_profit,
            count(*)::text AS settled_order_count
       FROM settlement_order
      WHERE tenant_id = $1
        AND company_id = ANY($2::uuid[])
        AND status = '已结算'
        AND (updated_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date`,
    [query.tenantId, query.companyIds, query.periodStart, query.periodEnd, appTimezone()],
  );

  const row = result.rows[0];
  return {
    grossProfit: row?.gross_profit ?? '0',
    netProfit: row?.net_profit ?? '0',
    settledOrderCount: Number(row?.settled_order_count ?? '0'),
  };
}

/** settlement 对外端口实现（D70）：已结算 C 单毛利聚合。 */
export const settlementProfitAggregateService: SettlementProfitAggregateSource = {
  aggregateSettledProfit,
};
