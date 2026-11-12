import type { ProfitReport } from '@qingdan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { formatMoney } from '../../lib/decimal';
import { authApi, authKeys } from '../auth/auth-api';
import {
  errorText,
  PageShell,
  shortId,
} from '../inventory/inventory-ui';
import {
  profitReportApi,
  profitReportQueryKeys,
  type ProfitReportFilters,
} from './profit-report-api';

function amount(value: string | null): string {
  return formatMoney(value);
}

export function ProfitReportSummary({
  report,
  canViewPrice,
}: {
  readonly report: ProfitReport;
  readonly canViewPrice: boolean;
}) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: '毛利', value: report.grossProfit, tone: 'text-sky-700' },
          { label: '全损耗损失', value: report.fullLossAmount, tone: 'text-rose-700' },
          { label: '净毛利', value: report.netProfit, tone: 'text-emerald-700' },
        ].map((item) => (
          <section key={item.label} className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-xs text-slate-400">{item.label}</p>
            <p className={`mt-2 text-2xl font-semibold tabular-nums ${item.tone}`}>
              {canViewPrice ? amount(item.value) : '—'}
            </p>
          </section>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        <span>期间：{report.periodStart} 至 {report.periodEnd}</span>
        <span>参与汇总的已结算单：{report.settledOrderCount} 张</span>
        {!canViewPrice && <span className="text-amber-700">当前身份无看价权限，金额显示占位。</span>}
      </div>

      {report.unattributedLossAvailable && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
          未归属损失下钻已开放，但当前一期契约尚未启用。
        </section>
      )}
    </>
  );
}

export function ProfitReportPage() {
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [submitted, setSubmitted] = useState<ProfitReportFilters | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me });
  const report = useQuery({
    queryKey: profitReportQueryKeys.report(submitted!),
    queryFn: () => profitReportApi.get(submitted!),
    enabled: submitted !== null,
  });
  const canViewPrice =
    me.data?.scope.some(
      (entry) => entry.domain === 'profit_report' && entry.actions.includes('view_price'),
    ) ?? false;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!periodStart || !periodEnd) {
      setFormError('请选择完整的开始日期和结束日期。');
      return;
    }
    if (periodStart > periodEnd) {
      setFormError('开始日期不能晚于结束日期。');
      return;
    }
    setFormError(null);
    setSubmitted({ periodStart, periodEnd, companyId: companyId || undefined });
  };

  return (
    <PageShell
      title="利润报表"
      description="按期间汇总已结算毛利、全损耗与净毛利；金额始终以服务端权限结果为准。"
    >
      <form
        onSubmit={submit}
        className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <label className="text-sm">
          <span className="text-slate-600">开始日期</span>
          <input
            required
            type="date"
            value={periodStart}
            onChange={(event) => setPeriodStart(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-slate-600">结束日期</span>
          <input
            required
            type="date"
            value={periodEnd}
            onChange={(event) => setPeriodEnd(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-slate-600">可见公司</span>
          <select
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">全部可见公司</option>
            {(me.data?.companyIds ?? []).map((id) => (
              <option key={id} value={id}>
                {shortId(id)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          >
            查询报表
          </button>
        </div>
        {formError && (
          <p className="text-sm text-rose-600 sm:col-span-2 xl:col-span-4">{formError}</p>
        )}
      </form>

      {!submitted ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-sm text-slate-500">选择起止日期后查询；不使用隐式默认期间。</p>
        </div>
      ) : report.isPending ? (
        <div className="grid gap-4 md:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-28 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : report.isError ? (
        <div className="rounded-xl border border-rose-200 bg-white p-6 text-center">
          <p className="text-sm text-rose-600">{errorText(report.error, '利润报表加载失败')}</p>
          <button
            type="button"
            onClick={() => void report.refetch()}
            className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            重试
          </button>
        </div>
      ) : report.data ? (
        <ProfitReportSummary report={report.data} canViewPrice={canViewPrice} />
      ) : null}
    </PageShell>
  );
}
