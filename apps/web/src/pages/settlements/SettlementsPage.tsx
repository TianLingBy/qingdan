/**
 * 结算单 C 页面（`/settlements`，22 页 IA 第 7 页；D2③ / D5 / D19 / D29 / D33 / D36 / D78）。
 *
 * 原型里这一页把「提成」并进来（prototype-v0 §2），所以页面结构是
 * **结算凭证 + 提成块**：金额是服务端算好的毛利与净毛利，提成是结算时快照。
 *
 * 三个容易做错的地方，这里都按契约来：
 * - **没有「新建」按钮**：C 单草稿由 E / N 单「已完成」时系统自动生成（D19 / D29），
 *   页面上出现「新建结算单」才是错的；
 * - **一期一单一次结算**（D19）：没有部分结算、没有多次结算，也没有取消 / 冲正按钮——
 *   结算后错账走 R 退货（D2③），不是在这张单上改；
 * - **金额受看价权限管**（D78）：无 `settlement.view_price` 时全部金额显示 `—`，
 *   此时也不放开「确认结算」——看不到毛利就确认结算，等于闭眼签字。
 */

import type {
  SettlementOrder,
  SettlementOrderDetail,
  SettlementSourceDocType,
  SettlementOrderStatus,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { allows, type ScopeAction } from '../../lib/access';
import { MASKED_AMOUNT, formatMoney } from '../../lib/decimal';
import { useEmployeeLabel } from '../../lib/employee-directory';
import { describeWriteError, recoverFromStaleVersion } from '../../lib/write-error';
import { authApi, authKeys } from '../auth/auth-api';
import { CommissionRatesPanel } from './CommissionRatesPanel';
import {
  SETTLEMENT_SOURCE_LABEL,
  SETTLEMENT_STATES,
  SETTLEMENT_STATE_HINT,
  SETTLEMENT_STATE_STYLE,
  commissionNote,
  confirmBlockedText,
  fetchSourceDocNo,
  fetchSourceDocNoMap,
  formatCommissionRate,
  formatRate,
  lossNote,
  settlementQueryKeys,
  settlementsApi,
  sourceDocText,
} from './settlements-api';

const PAGE_DESCRIPTION =
  '结算凭证：毛利 = 总售价 − 总成本（D5），净毛利再扣本单相关损失（D33）；提成在确认结算时按归属人比例快照（D36）。';

function errorText(error: unknown): string {
  return describeWriteError(error);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

function StatusBadge({ status }: { readonly status: SettlementOrderStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
        SETTLEMENT_STATE_STYLE[status]
      }`}
      title={SETTLEMENT_STATE_HINT[status]}
    >
      {status}
    </span>
  );
}

/** 金额单元格：无看价权限时统一显示 `—`（D78），不用 0 顶替。 */
function Money({ value, canView }: { readonly value: string | null; readonly canView: boolean }) {
  return <span className="font-mono text-xs">{canView ? formatMoney(value) : MASKED_AMOUNT}</span>;
}

/* ------------------------------ 详情 ------------------------------ */

interface DetailPanelProps {
  readonly order: SettlementOrderDetail;
  readonly sourceDocNo: string | null;
  readonly canViewPrice: boolean;
  readonly canApprove: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

function DetailPanel({
  order,
  sourceDocNo,
  canViewPrice,
  canApprove,
  busy,
  onClose,
  onConfirm,
}: DetailPanelProps) {
  const employeeLabel = useEmployeeLabel();
  const blocked = confirmBlockedText(order.confirmable.reason);
  const note = commissionNote(order.commissionRateSnapshot, order.commissionAmount);
  const loss = lossNote(order.grossProfit, order.relatedLossAmount);

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-mono text-sm text-slate-900">{order.orderNo}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <StatusBadge status={order.status} />
            <span>{sourceDocText(order.sourceDocType, order.sourceDocId, sourceDocNo)}</span>
            <span className="text-slate-300">|</span>
            <span>生成 {formatDateTime(order.createdAt)}</span>
            {order.status === '已结算' ? (
              <>
                <span className="text-slate-300">|</span>
                <span>结算 {formatDateTime(order.updatedAt)}</span>
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          关闭
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-xs text-slate-500">总售价</p>
          <p className="mt-1">
            <Money value={order.totalSaleAmount} canView={canViewPrice} />
          </p>
          <p className="mt-1 text-xs text-slate-500">总成本</p>
          <p className="mt-1">
            <Money value={order.totalCostAmount} canView={canViewPrice} />
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-xs text-slate-500">毛利（总售价 − 总成本，D5）</p>
          <p className="mt-1">
            <Money value={order.grossProfit} canView={canViewPrice} />
          </p>
          <p className="mt-1 text-xs text-slate-500">毛利率</p>
          <p className="mt-1 font-mono text-xs">
            {canViewPrice ? formatRate(order.grossMarginRate) : MASKED_AMOUNT}
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-xs text-slate-500">本单相关损失（D35）</p>
          <p className="mt-1">
            <Money value={order.relatedLossAmount} canView={canViewPrice} />
          </p>
          <p className="mt-1 text-xs text-slate-500">净毛利（毛利 − 相关损失，D33）</p>
          <p className="mt-1">
            <Money value={order.netProfit} canView={canViewPrice} />
          </p>
        </div>
      </div>

      {loss ? <p className="text-xs text-slate-500">{loss}</p> : null}

      <div className="rounded-lg border border-slate-200 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">提成（D36 / D77 ②）</h3>
          <span className="text-[11px] text-slate-400">
            比例是<b>确认结算时的快照</b>，之后改比例不影响本单（D5④）
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">提成比例快照</dt>
            <dd className="mt-0.5 font-mono text-xs">{formatCommissionRate(order.commissionRateSnapshot)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">提成金额</dt>
            <dd className="mt-0.5">
              <Money value={order.commissionAmount} canView={canViewPrice} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">提成归属人</dt>
            <dd className="mt-0.5 text-xs" title={order.commissionOwnerId ?? undefined}>
              {employeeLabel(order.commissionOwnerId)}
            </dd>
          </div>
        </dl>
        {note ? <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{note}</p> : null}
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          一期提成只是报表数字，不在本单发放（D11）。
        </p>
      </div>

      {!canViewPrice ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          无「看价」权限：金额与提成均显示 {MASKED_AMOUNT}（D78），也不能确认结算——
          看不到毛利就确认结算，等于闭眼签字。
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canApprove || !order.confirmable.allowed || !canViewPrice || busy}
          onClick={onConfirm}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          title={canApprove ? undefined : '当前身份没有 settlement.approve 权限'}
        >
          {busy ? '确认中…' : '确认结算'}
        </button>
        {blocked ? <span className="text-xs text-slate-500">{blocked}</span> : null}
        {order.confirmable.allowed && !canApprove ? (
          <span className="text-xs text-slate-500">确认结算需要 settlement.approve（审批动作，D52①）。</span>
        ) : null}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-400">
        一期一单只结算一次（D19），不能部分结算；结算后<b>不可冲正、不可取消</b>，
        错账走 R 客户退货（D2③）。C 单是计算与结算凭证，商品明细以来源 E / N 单为准。
      </p>
    </section>
  );
}

/* ------------------------------ 页面 ------------------------------ */

export function SettlementsPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me(), retry: false });

  const [status, setStatus] = useState<'' | SettlementOrderStatus>('');
  const [sourceDocType, setSourceDocType] = useState<'' | SettlementSourceDocType>('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 版本冲突后已刷新到最新状态时的提示（与红色报错互斥）。 */
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  /** 提成比例配置面板是否展开（入口按 commission.read 显隐，见下）。 */
  const [commissionOpen, setCommissionOpen] = useState(false);

  const scope = me.data?.scope;
  const can = (action: ScopeAction) => allows(scope, 'settlement', action);
  const canViewPrice = can('view_price');
  /**
   * 提成域是独立的 scope（`commission.read/create/delete`，契约 `commission-rates.ts`）：
   * 只持 `settlement.read` 的财务能看结算单，但**看不到**这个入口——
   * 门禁仍以服务端为准，这里只决定显不显示（D4/D27）。
   */
  const canCommission = (action: ScopeAction) => allows(scope, 'commission', action);

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [status, sourceDocType, keyword]);

  const filters = useMemo(
    () => ({
      status: status || undefined,
      sourceDocType: sourceDocType || undefined,
      keyword: keyword.trim() || undefined,
      cursor: cursors[pageIndex] ?? null,
    }),
    [status, sourceDocType, keyword, cursors, pageIndex],
  );

  const list = useQuery({
    queryKey: settlementQueryKeys.list(filters),
    queryFn: () => settlementsApi.list(filters),
  });

  const detail = useQuery({
    queryKey: settlementQueryKeys.detail(detailId),
    queryFn: () => settlementsApi.detail(detailId!),
    enabled: detailId !== null,
  });

  /**
   * 来源单单号（契约缺口补齐）：C 单只回 `sourceDocId`，没有单号。
   * 只在详情打开时换一次；拿不到（无来源单读权限 / 来源单不存在）就回 id 前 8 位，
   * 不让详情面板整体报错——`fetchSourceDocNo` 内部已吞错。
   */
  const sourceDocNo = useQuery({
    queryKey: settlementQueryKeys.sourceDoc(
      detail.data?.sourceDocType ?? null,
      detail.data?.sourceDocId ?? null,
    ),
    queryFn: () => fetchSourceDocNo(detail.data!.sourceDocType, detail.data!.sourceDocId),
    enabled: detail.data !== undefined,
    retry: false,
    staleTime: 60_000,
  });

  const confirm = useMutation({
    mutationFn: (order: SettlementOrderDetail) =>
      settlementsApi.confirm(order.id, order.version),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settlements'] });
      setActionError(null);
      setStaleNotice(null);
    },
    /**
     * 版本冲突（极小概率：刚取的详情到点确认之间被人抢先）→ 刷新到最新状态再让用户判断。
     * 确认结算是一次性动作，刷新后 `confirmable` 会由服务端重新给出（D19），不自己猜。
     */
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, settlementsApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '确认结算失败，请稍后重试'));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['settlements'] });
      setStaleNotice(
        fresh.status === '已结算'
          ? `这张结算单已被别人先结算了（v${fresh.version}）：一期一单只结算一次（D19），不能重复确认。`
          : `这张结算单刚被别人改过，已刷新到最新状态（v${fresh.version}）；请核对后重新确认。`,
      );
    },
  });

  /**
   * 确认前先取最新详情：列表里的是旧版本，直接拿它的 version 会 409（D60）；
   * 而且 `confirmable` 只认服务端结论（D19），不拿列表状态自己推。
   */
  const askConfirm = async (orderId: string) => {
    setActionError(null);
    setStaleNotice(null);
    try {
      const fresh = await settlementsApi.detail(orderId);
      setDetailId(orderId);
      /**
       * 列表可能是旧快照（别人刚结算完），服务端 `confirmable` 会拒绝。
       * 以前这里静默 return，用户点了「确认结算」毫无反应；把原因摆出来。
       */
      if (!fresh.confirmable.allowed) {
        setActionError(
          confirmBlockedText(fresh.confirmable.reason) ?? '当前状态不可确认结算',
        );
        return;
      }
      setActionError(null);
      if (
        globalThis.confirm?.(
          `确认结算 ${fresh.orderNo} 吗？\n\n确认后：\n· 状态变为「已结算」，一期一单只结算一次（D19）\n· 提成按当前比例快照落定（D36）\n· 不可冲正、不可取消，错账走 R 退货（D2③）`,
        ) === false
      ) {
        return;
      }
      confirm.mutate(fresh);
    } catch (error) {
      setActionError(describeWriteError(error, '读取结算单失败，请稍后重试'));
    }
  };

  const rows = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  const detailOrder = detail.data;

  /**
   * 来源单号批量映射（契约缺口补齐）：列表逐行发详情不划算，按类型各拉一页来源单建映射。
   * 只在当前页真出现该类型时才查；失败 / 无来源单读权限 → 空表 → 退回 id 前 8 位。
   */
  const hasE = rows.some((order) => order.sourceDocType === 'E');
  const hasN = rows.some((order) => order.sourceDocType === 'N');
  const eDocNos = useQuery({
    queryKey: settlementQueryKeys.sourceDocMap('E'),
    queryFn: () => fetchSourceDocNoMap('E'),
    enabled: hasE,
    retry: false,
    staleTime: 60_000,
  });
  const nDocNos = useQuery({
    queryKey: settlementQueryKeys.sourceDocMap('N'),
    queryFn: () => fetchSourceDocNoMap('N'),
    enabled: hasN,
    retry: false,
    staleTime: 60_000,
  });
  const docNoOf = (order: SettlementOrder): string | undefined => {
    const map = order.sourceDocType === 'E' ? eDocNos.data : nDocNos.data;
    return map?.get(order.sourceDocId);
  };

  return (
    <section className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">结算单 C</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">{PAGE_DESCRIPTION}</p>
        </div>
        {canCommission('read') ? (
          <button
            type="button"
            onClick={() => setCommissionOpen((open) => !open)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700"
          >
            {commissionOpen ? '收起提成比例配置' : '提成比例配置'}
          </button>
        ) : null}
      </header>

      {commissionOpen && canCommission('read') ? (
        <CommissionRatesPanel
          companyIds={me.data?.companyIds ?? []}
          canCreate={canCommission('create')}
          canDelete={canCommission('delete')}
        />
      ) : null}

      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        结算单<b>没有「新建」按钮</b>：草稿由 E 销售单 / N 内部交易单「已完成」时自动生成（D19 / D29）。
        一期一单一次结算，结算后不可冲正、不可取消，错账走 R 退货（D2③）。
      </p>

      {me.data && !canViewPrice ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          当前身份无「看价」权限，金额与提成都显示为 <b>{MASKED_AMOUNT}</b>（D78）。
          此时也不放开「确认结算」——看不到毛利就确认结算，等于闭眼签字。
        </p>
      ) : null}

      {me.data && !can('approve') ? (
        <p className="text-xs text-slate-500">
          「确认结算」需要 settlement.approve（审批动作）；当前身份只能查看。
        </p>
      ) : null}

      {me.data && canViewPrice ? (
        <p className="text-xs text-slate-400">
          看过金额的详情读取会由服务端记一条 amount.detail 审计（D51① / D78）。
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as '' | SettlementOrderStatus)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部状态</option>
          {SETTLEMENT_STATES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          value={sourceDocType}
          onChange={(event) =>
            setSourceDocType(event.target.value as '' | SettlementSourceDocType)
          }
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部来源</option>
          {(Object.keys(SETTLEMENT_SOURCE_LABEL) as SettlementSourceDocType[]).map((type) => (
            <option key={type} value={type}>
              {SETTLEMENT_SOURCE_LABEL[type]}
            </option>
          ))}
        </select>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="按单号搜索"
          className="min-w-56 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      {staleNotice ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {staleNotice}
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {list.isPending ? (
          <p className="p-6 text-sm text-slate-500">正在加载结算单…</p>
        ) : list.error ? (
          <div className="p-6">
            <p className="text-sm text-red-700">{errorText(list.error)}</p>
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm"
            >
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">
            暂无结算单。结算单不手工开：先在销售单 E / 内部交易单 N 里把单据完成，系统会自动生成草稿（D19）。
          </p>
        ) : (
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">单号</th>
                <th className="px-4 py-3">来源单</th>
                <th className="px-4 py-3">总售价</th>
                <th className="px-4 py-3">总成本</th>
                <th className="px-4 py-3">毛利</th>
                <th className="px-4 py-3">毛利率</th>
                <th className="px-4 py-3">净毛利</th>
                <th className="px-4 py-3">提成</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order: SettlementOrder) => (
                <tr key={order.id} className="border-b border-slate-100 last:border-0">
                  <td className="whitespace-nowrap px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setDetailId(order.id)}
                      className="font-mono text-xs text-slate-900 underline-offset-2 hover:underline"
                    >
                      {order.orderNo}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {sourceDocText(order.sourceDocType, order.sourceDocId, docNoOf(order))}
                  </td>
                  <td className="px-4 py-3">
                    <Money value={order.totalSaleAmount} canView={canViewPrice} />
                  </td>
                  <td className="px-4 py-3">
                    <Money value={order.totalCostAmount} canView={canViewPrice} />
                  </td>
                  <td className="px-4 py-3">
                    <Money value={order.grossProfit} canView={canViewPrice} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {canViewPrice ? formatRate(order.grossMarginRate) : MASKED_AMOUNT}
                  </td>
                  <td className="px-4 py-3">
                    <Money value={order.netProfit} canView={canViewPrice} />
                  </td>
                  <td className="px-4 py-3">
                    <Money value={order.commissionAmount} canView={canViewPrice} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setDetailId(order.id)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs"
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        disabled={
                          !can('approve') ||
                          !canViewPrice ||
                          order.status === '已结算' ||
                          confirm.isPending
                        }
                        onClick={() => void askConfirm(order.id)}
                        className="rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-700 disabled:opacity-40"
                        title={
                          order.status === '已结算'
                            ? '已结算，一期一单只结算一次（D19）'
                            : !canViewPrice
                              ? '无看价权限：看不到毛利就不能确认结算'
                              : undefined
                        }
                      >
                        确认结算
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={pageIndex === 0}
          onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          上一页
        </button>
        <span className="text-sm text-slate-500">第 {pageIndex + 1} 页</span>
        <button
          type="button"
          disabled={!nextCursor}
          onClick={() => {
            if (!nextCursor) return;
            setCursors((items) => [...items.slice(0, pageIndex + 1), nextCursor]);
            setPageIndex((index) => index + 1);
          }}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          下一页
        </button>
      </div>

      {detailId !== null ? (
        <>
          {detail.isPending ? (
            <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
              正在加载结算单详情…
            </p>
          ) : null}
          {detail.error ? (
            <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-red-700">
              {errorText(detail.error)}
            </p>
          ) : null}
          {detailOrder ? (
            <DetailPanel
              order={detailOrder}
              sourceDocNo={sourceDocNo.data ?? null}
              canViewPrice={canViewPrice}
              canApprove={can('approve')}
              busy={confirm.isPending}
              onClose={() => setDetailId(null)}
              onConfirm={() => void askConfirm(detailOrder.id)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
