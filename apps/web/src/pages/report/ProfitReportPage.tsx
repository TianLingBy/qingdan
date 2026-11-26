import type { ProfitReport } from '@qingdan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { describeListError } from '../../components/ListStates';
import { Icon } from '../../components/icons/Icon';
import { formatMoney } from '../../lib/decimal';
import { resolveListState } from '../../lib/list-state';
import { authApi, authKeys } from '../auth/auth-api';
import { shortId } from '../inventory/inventory-ui';
import {
  profitReportApi,
  profitReportQueryKeys,
  type ProfitReportFilters,
} from './profit-report-api';

function amount(value: string | null): string {
  return formatMoney(value);
}

function toneOf(value: string | null): string {
  const n = Number(value ?? '0');
  if (Number.isNaN(n)) return 'muted';
  return n >= 0 ? 'st ok' : 'st bad';
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
          { label: '毛利', value: report.grossProfit },
          { label: '全损耗损失', value: report.fullLossAmount },
          { label: '净毛利', value: report.netProfit },
        ].map((item) => (
          <section key={item.label} className="panel">
            <p className="muted">{item.label}</p>
            <p className={`mt-2 text-2xl font-semibold tabular-nums ${toneOf(item.value)}`}>
              {canViewPrice ? amount(item.value) : '—'}
            </p>
          </section>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm muted">
        <span>期间：{report.periodStart} 至 {report.periodEnd}</span>
        <span>参与汇总的已结算单：{report.settledOrderCount} 张</span>
        {!canViewPrice && (
          <span className="st warn">当前身份无看价权限，金额显示占位。</span>
        )}
      </div>

      {report.unattributedLossAvailable && (
        <section className="panel muted">未归属损失下钻已开放，但当前一期契约尚未启用。</section>
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

  const state = resolveListState({
    isPending: report.isPending,
    hasError: report.isError,
    isEmpty: submitted === null,
  });

  return (
    <section className="space-y-4">
      <header className="p-head">
        <div>
          <div className="eyebrow">报表 · 期间汇总</div>
          <h1>利润报表</h1>
          <p className="sub">
            由已结算 C 单按期间聚合，正青负红。无看价权限时全部金额显示「—」（D79）。
          </p>
        </div>
      </header>

      <form onSubmit={submit} className="panel">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label>
            <span className="muted">开始日期</span>
            <input
              required
              type="date"
              value={periodStart}
              onChange={(event) => setPeriodStart(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label>
            <span className="muted">结束日期</span>
            <input
              required
              type="date"
              value={periodEnd}
              onChange={(event) => setPeriodEnd(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label>
            <span className="muted">可见公司</span>
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
            <button type="submit" className="btn btn-p w-full">
              查询报表
            </button>
          </div>
        </div>
        {formError && <p className="mt-2 text-sm text-rose-600">{formError}</p>}
      </form>

      <section className="panel" data-state={state}>
        <div className="st-block st-filled">
          {report.data ? <ProfitReportSummary report={report.data} canViewPrice={canViewPrice} /> : null}
        </div>
        <div className="st-block st-empty">
          <div className="st-box">
            <div className="st-ico">
              <Icon name="calendar" />
            </div>
            <div className="st-title">选择起止日期后查询</div>
            <p className="st-desc">不使用隐式默认期间；期间必填，缺了后端会 422。</p>
          </div>
        </div>
        <div className="st-block st-loading">
          <div className="st-box" aria-label="利润报表加载中">
            <div className="sk sk-line w80" />
            <div className="sk sk-line w60" />
            <div className="sk sk-line w40" />
            <p className="st-desc mt-3">利润报表加载中…</p>
          </div>
        </div>
        <div className="st-block st-error">
          <div className="st-box st-error">
            <div className="st-ico">
              <Icon name="refresh" />
            </div>
            <div className="st-title">利润报表加载失败</div>
            <p className="st-desc">{describeListError('利润报表加载失败', report.error)}</p>
            <button type="button" className="btn" onClick={() => void report.refetch()}>
              重试
            </button>
          </div>
        </div>
      </section>
    </section>
  );
}
