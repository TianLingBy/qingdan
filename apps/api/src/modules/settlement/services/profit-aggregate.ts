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
 * - 期间按 **结算确认时间** `settlement_order.settled_at`（0026）落在
 *   `[periodStart 本地零点, periodEnd 次日本地零点)` 半开区间内统计；
 *   不再用 `updated_at` 推断——0016 的触发器会在任何 UPDATE 时刷新它，
 *   那样一张单据被别的逻辑改写一次就会换期间；
 * - 半开区间写成 `settled_at >= start_local AND settled_at < (end + 1 day)_local`，
 *   列名在比较左侧保持裸露，部分索引
 *   `settlement_order_tenant_company_settled_at_idx` 才能命中范围扫描；
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
        AND settled_at >= ($3::date)::timestamp AT TIME ZONE $5
        AND settled_at <  (($4::date + 1)::timestamp) AT TIME ZONE $5`,
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
