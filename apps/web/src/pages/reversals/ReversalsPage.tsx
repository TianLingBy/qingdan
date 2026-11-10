/**
 * 冲正单据页 R / S / I（`/reversals`，22 页 IA 第 8 页；D9 / D36 / D40 / D47 / D71）。
 *
 * 三张单共处一页，但它们是三个模块、三套状态机，所以这里只做「页头 + 分栏切换 + 公司口径」，
 * 每种单据的规则留在各自分栏里：
 * - **R 客户退货**：挂原 E 单，退货退款 / 仅退款，只追加；
 * - **S 供应商退货**：只退钱，没有类型字段；
 * - **I 盘点盈亏**：审批流三态，审批后真的改批次数量。
 *
 * 分栏按权限收窄：`PAGE_SCOPE.reversals` 只要求「任一冲正域可读」就能进整页，
 * 具体哪一栏能看再按各自域判断——只有供应商退货权限的人不该看到客户退货的列表。
 */

import type { ScopeMatrix } from '@qingdan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ScopeDomain } from '../../lib/access';
import { allows } from '../../lib/access';
import { authApi, authKeys } from '../auth/auth-api';
import { CustomerReturnsPanel } from './CustomerReturnsPanel';
import { StocktakesPanel } from './StocktakesPanel';
import { SupplierReturnsPanel } from './SupplierReturnsPanel';
import { ErrorBar } from './reversals-ui';

type TabId = 'customer' | 'supplier' | 'stocktake';

interface TabSpec {
  readonly id: TabId;
  readonly label: string;
  readonly domain: ScopeDomain;
  readonly blurb: string;
}

const TABS: readonly TabSpec[] = [
  {
    id: 'customer',
    label: 'R 客户退货',
    domain: 'customer_return',
    blurb: '挂原销售单；只追加，不改历史',
  },
  {
    id: 'supplier',
    label: 'S 供应商退货',
    domain: 'supplier_return',
    blurb: '只退钱，不动库存',
  },
  {
    id: 'stocktake',
    label: 'I 盘点盈亏',
    domain: 'stocktake',
    blurb: '审批后调批次数量',
  },
];

/* ------------------------------ 视图 ------------------------------ */

export interface ReversalsViewProps {
  readonly scope: ScopeMatrix | undefined;
  readonly companyIds: readonly string[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
}

export function ReversalsView({
  scope,
  companyIds,
  loading,
  error,
  onRetry,
}: ReversalsViewProps) {
  const [tab, setTab] = useState<TabId>('customer');
  const [companyId, setCompanyId] = useState('');

  const visibleTabs = useMemo(
    () => TABS.filter((spec) => allows(scope, spec.domain, 'read')),
    [scope],
  );

  // 当前分栏没权限时回退到第一个能看的分栏，而不是渲染一个空面板。
  const activeTab: TabId | null = visibleTabs.some((spec) => spec.id === tab)
    ? tab
    : (visibleTabs[0]?.id ?? null);

  const effectiveCompanyId = companyId || companyIds[0] || '';

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <header className="rounded-xl border border-slate-200 bg-white px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">冲正单据</h1>
            <p className="mt-1 text-sm text-slate-500">
              错账不改原单，走追加的冲正单据：客户退货 R、供应商退货 S、盘点盈亏 I。
            </p>
          </div>
          <p className="max-w-sm text-xs leading-relaxed text-slate-400">
            冲正单据只追加，不可改、不可删（D47）；三类单分属 sales / purchase / inventory
            三个模块，状态机也各不相同。
          </p>
        </div>
      </header>

      {error ? <ErrorBar message={`身份读取失败：${error}`} onRetry={onRetry} /> : null}

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="冲正单据类型">
        {TABS.map((spec) => {
          const enabled = visibleTabs.some((item) => item.id === spec.id);
          const selected = activeTab === spec.id;
          return (
            <button
              key={spec.id}
              type="button"
              role="tab"
              aria-selected={selected}
              disabled={!enabled || loading}
              title={enabled ? spec.blurb : '当前身份没有这个域的可读权限'}
              onClick={() => setTab(spec.id)}
              className={`rounded-lg border px-3 py-2 text-sm ${
                selected
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : enabled
                    ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    : 'border-slate-200 bg-slate-50 text-slate-400'
              }`}
            >
              {spec.label}
            </button>
          );
        })}
      </div>

      {activeTab === null ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
          当前身份没有冲正单据的可读权限（customer_return / supplier_return / stocktake 任一）。
          需要查看请联系管理员调整岗位权限（D15）。
        </p>
      ) : (
        <div role="tabpanel">
          {activeTab === 'customer' ? (
            <CustomerReturnsPanel
              canCreate={allows(scope, 'customer_return', 'create')}
              canViewPrice={allows(scope, 'customer_return', 'view_price')}
              companyIds={companyIds}
              companyId={effectiveCompanyId}
              onCompanyChange={setCompanyId}
            />
          ) : activeTab === 'supplier' ? (
            <SupplierReturnsPanel
              canCreate={allows(scope, 'supplier_return', 'create')}
              canViewPrice={allows(scope, 'supplier_return', 'view_price')}
              companyIds={companyIds}
              companyId={effectiveCompanyId}
              onCompanyChange={setCompanyId}
            />
          ) : (
            <StocktakesPanel
              canIncrease={allows(scope, 'stocktake', 'create')}
              canDecrease={allows(scope, 'stocktake', 'delete')}
              canApprove={allows(scope, 'stocktake', 'approve')}
              companyIds={companyIds}
              companyId={effectiveCompanyId}
              onCompanyChange={setCompanyId}
            />
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------ 页面 ------------------------------ */

export function ReversalsPage() {
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me(), retry: false });

  return (
    <ReversalsView
      scope={me.data?.scope}
      companyIds={me.data?.companyIds ?? []}
      loading={me.isPending}
      error={me.isError ? (me.error instanceof Error ? me.error.message : '未知错误') : null}
      onRetry={() => void me.refetch()}
    />
  );
}
