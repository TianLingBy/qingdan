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
      <div className="p-head">
        <div>
          <div className="eyebrow">冲正单据 R / S / I</div>
          <h1>冲正单据</h1>
          <p className="sub">
            错账不改原单，走追加的冲正单据：客户退货 R、供应商退货 S、盘点盈亏 I。
            三类单分属 sales / purchase / inventory 三个模块，状态机也各不相同。
          </p>
        </div>
        {/*
          视觉稿的「+ 新建冲正」是页头一个按钮，这里**放在各分栏里**：
          三类单的建单入参与权限点完全不同（R 挂原销售单、S 只退钱、I 调批次数量），
          页头一个按钮点下去还得先问「建哪种」，不如进到分栏里建。
        */}
      </div>

      {error ? <ErrorBar message={`身份读取失败：${error}`} onRetry={onRetry} /> : null}

      {/*
        分栏（v0.13 `.seg`）：视觉稿用「全部 / 客户退货 R / 供应商退货 S / 盘点盈亏 I」，
        我们是**一次只渲染一栏**（各栏各带建单表单与详情，全部渲染等于三套表单同时在页面上）。
        所以这里是「选一栏」而不是「筛一类」，没有「全部」。
      */}
      <div className="seg" role="tablist" aria-label="冲正单据类型">
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
              className={selected ? 'on' : undefined}
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
              canApprove={allows(scope, 'customer_return', 'approve')}
              canViewPrice={allows(scope, 'customer_return', 'view_price')}
              companyIds={companyIds}
              companyId={effectiveCompanyId}
              onCompanyChange={setCompanyId}
            />
          ) : activeTab === 'supplier' ? (
            <SupplierReturnsPanel
              canCreate={allows(scope, 'supplier_return', 'create')}
              canApprove={allows(scope, 'supplier_return', 'approve')}
              canViewPrice={allows(scope, 'supplier_return', 'view_price')}
              canCancel={allows(scope, 'supplier_return', 'delete')}
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

      <p className="note">
        冲正单据只追加，不可改、不可删（D47）；冲正后成本按 T1/T2/T3 更正（D37）。
        三类单的「取消」能力并不对称：<b>只有 S 供应商退货能取消</b>（`supplier_return.cancel`，
        权限点是 <code>supplier_return.delete</code>，取消时释放待执行库存占用）——R 客户退货只有完成，
        I 盘点只有审批，所以三栏长得不一样，不是漏画。
      </p>
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
