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
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { DetailHead, DetailMetaDot, DocMeta, DocPill } from '../../components/OrderDetailUI';
import { allows, type ScopeAction } from '../../lib/access';
import { MASKED_AMOUNT, formatMoney } from '../../lib/decimal';
import { useEmployeeLabel } from '../../lib/employee-directory';
import { resolveListState, type ListState } from '../../lib/list-state';
import { describeWriteError, recoverFromStaleVersion } from '../../lib/write-error';
import { authApi, authKeys } from '../auth/auth-api';
import { CommissionRatesPanel } from './CommissionRatesPanel';
import {
  SETTLEMENT_SOURCE_LABEL,
  SETTLEMENT_STATES,
  SETTLEMENT_STATE_HINT,
  SETTLEMENT_STATE_TONE,
  commissionNote,
  confirmBlockedText,
  fetchSourceDocNo,
  fetchSourceDocNoMap,
  formatCommissionRate,
  formatRate,
  lossNote,
  settlementQueryKeys,
  settlementsApi,
  sourceDocShort,
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

/**
 * 列表用的短时间：`11-19 08:57`。
 *
 * C 单是财务凭证，「哪天生成的」必须能一眼看到（视觉稿也有一列「日期」）；
 * 但完整年月日占宽太多，年份挪到详情面板。
 */
function formatShortDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  })
    .format(date)
    .replace(/\//g, '-');
}

/**
 * 两态 → v0.13 `.st` 色档（映射在 api 层，颜色规则在 `app-v013.css`）。
 *
 * `待确认` 用 `bad`（红）是照视觉稿 `结算单C.html`：它不是「出错」，是**等财务动手**——
 * 一张待确认的 C 单意味着钱还没落定，红一点才有人管。`已结算` 用 `ok`（绿）收尾。
 */
function StatusBadge({ status }: { readonly status: SettlementOrderStatus }) {
  return (
    <DocPill
      label={status}
      tone={SETTLEMENT_STATE_TONE[status]}
      title={SETTLEMENT_STATE_HINT[status]}
    />
  );
}

/** 金额文本：无看价权限统一显示 `—`（D78），不用 0 顶替。 */
function moneyText(value: string | null, canView: boolean): string {
  return canView ? formatMoney(value) : MASKED_AMOUNT;
}

/** 金额单元格：无看价权限时统一显示 `—`（D78），不用 0 顶替。 */
function Money({ value, canView }: { readonly value: string | null; readonly canView: boolean }) {
  return <span className="font-mono text-xs">{moneyText(value, canView)}</span>;
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
  readonly onUnsettle: () => void;
}

function DetailPanel({
  order,
  sourceDocNo,
  canViewPrice,
  canApprove,
  busy,
  onClose,
  onConfirm,
  onUnsettle,
}: DetailPanelProps) {
  const employeeLabel = useEmployeeLabel();
  const blocked = confirmBlockedText(order.confirmable.reason);
  const note = commissionNote(order.commissionRateSnapshot, order.commissionAmount);
  const loss = lossNote(order.grossProfit, order.relatedLossAmount);

  return (
    <section className="card space-y-4 p-5">
      <DetailHead
        docLabel="结算单"
        orderNo={order.orderNo}
        pill={<StatusBadge status={order.status} />}
        meta={
          <>
            <span>{sourceDocText(order.sourceDocType, order.sourceDocId, sourceDocNo)}</span>
            <DetailMetaDot />
            <span>生成 {formatDateTime(order.createdAt)}</span>
            {order.status === '已结算' ? (
              <>
                <DetailMetaDot />
                <span>结算 {formatDateTime(order.updatedAt)}</span>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            {/**
             * 撤销只在「已结算」出现：这是把已经落定的账翻回来，
             * 待确认的单没有可撤销的东西。
             */}
            {order.status === '已结算' ? (
              <button
                type="button"
                disabled={!canApprove || busy}
                onClick={onUnsettle}
                className="btn"
                title={canApprove ? '撤销后整单退回「待确认」，原因会记进审计' : '当前身份没有 settlement.approve 权限'}
              >
                撤销结算
              </button>
            ) : null}
            <button
              type="button"
              disabled={!canApprove || !order.confirmable.allowed || !canViewPrice || busy}
              onClick={onConfirm}
              className="btn btn-primary"
              title={canApprove ? undefined : '当前身份没有 settlement.approve 权限'}
            >
              {busy ? '确认中…' : '确认结算'}
            </button>
          </>
        }
        onClose={onClose}
      />

      <DocMeta
        items={[
          { label: '总售价', value: moneyText(order.totalSaleAmount, canViewPrice), tone: 'money' },
          { label: '总成本', value: moneyText(order.totalCostAmount, canViewPrice), tone: 'money' },
          {
            label: '毛利（总售价 − 总成本，D5）',
            value: moneyText(order.grossProfit, canViewPrice),
            tone: 'money',
          },
          {
            label: '毛利率',
            value: canViewPrice ? formatRate(order.grossMarginRate) : MASKED_AMOUNT,
            mono: true,
          },
          {
            label: '本单相关损失（D35）',
            value: moneyText(order.relatedLossAmount, canViewPrice),
            mono: true,
          },
          {
            label: '净毛利（毛利 − 相关损失，D33）',
            value: moneyText(order.netProfit, canViewPrice),
            tone: 'money',
          },
        ]}
      />

      {loss ? <p className="text-xs text-slate-500">{loss}</p> : null}

      <section className="rounded-xl border border-slate-200 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">提成（D36 / D77 ②）</h3>
          <span className="text-xs text-slate-400">
            比例是<b>确认结算时的快照</b>，之后改比例不影响本单（D5④）
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">提成比例快照</dt>
            <dd className="mt-0.5 font-mono text-xs">
              {formatCommissionRate(order.commissionRateSnapshot)}
            </dd>
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
        {note ? <p className="mt-2 text-xs leading-relaxed text-slate-400">{note}</p> : null}
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          一期提成只是报表数字，不在本单发放（D11）。
        </p>
      </section>

      {!canViewPrice ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          无「看价」权限：金额与提成均显示 {MASKED_AMOUNT}（D78），也不能确认结算——
          看不到毛利就确认结算，等于闭眼签字。
        </p>
      ) : null}

      {blocked || (order.confirmable.allowed && !canApprove) ? (
        <p className="text-xs text-slate-500">
          {blocked ?? '确认结算需要 settlement.approve（审批动作，D52①）。'}
        </p>
      ) : null}

      <p className="note">
        一期一单只结算一次（D19），不能部分结算。结算后<b>可撤销</b>（D88：整单退回「待确认」，
        须填原因并记审计），但<b>不能冲正</b>——错账仍走 R 客户退货（D2③）。
        C 单是计算与结算凭证，商品明细以来源 E / N 单为准。
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
   * 撤销结算（D88 / #288）：已结算 → 待确认，整单退回。
   *
   * 与 confirm 完全对称：强 ETag、冲突时刷到最新再让用户判断。
   * 差别只有一处——撤销是「把已经落定的账再翻回来」，所以原因必填且落审计。
   */
  const unsettle = useMutation({
    mutationFn: (input: { order: SettlementOrderDetail; reason: string }) =>
      settlementsApi.unsettle(input.order.id, input.order.version, input.reason),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settlements'] });
      setActionError(null);
      setStaleNotice(null);
    },
    onError: async (error, input) => {
      const fresh = await recoverFromStaleVersion(error, input.order.id, settlementsApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '撤销结算失败，请稍后重试'));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['settlements'] });
      setStaleNotice(
        fresh.status === '待确认'
          ? `这张结算单已经回到「待确认」了（v${fresh.version}）：别人先撤过，不用重复撤。`
          : `这张结算单刚被别人改过，已刷新到最新状态（v${fresh.version}）；请核对后重新撤销。`,
      );
    },
  });

  /**
   * 撤销前先取最新详情——理由同 `askConfirm`：列表是旧快照，拿它的 version 会 409（D60）。
   * 状态判定也只看服务端给出的 `status`，不从列表行自己推。
   */
  const askUnsettle = async (orderId: string) => {
    setActionError(null);
    setStaleNotice(null);
    try {
      const fresh = await settlementsApi.detail(orderId);
      setDetailId(orderId);
      if (fresh.status !== '已结算') {
        setActionError(`这张单当前是「${fresh.status}」，只有已结算的单能撤销。`);
        return;
      }
      /**
       * 原因走 prompt 而不是自建弹窗：这里只为一个字段开一个模态，
       * 代价（焦点陷阱、Esc、点遮罩关闭、移动端键盘遮挡）比收益大。
       */
      const reason = globalThis.prompt?.(
        `撤销结算 ${fresh.orderNo} 的原因（1–200 字，会记进审计）：`,
      );
      if (reason === null || reason === undefined) return;
      const trimmed = reason.trim();
      if (trimmed.length === 0) {
        setActionError('必须填写撤销原因：财务事后要能答「谁为什么把结算撤了」。');
        return;
      }
      if (trimmed.length > 200) {
        setActionError(`原因最多 200 字，当前 ${trimmed.length} 字。`);
        return;
      }
      if (
        globalThis.confirm?.(
          `确认撤销 ${fresh.orderNo} 的结算吗？\\n\\n撤销后：\\n· 状态退回「待确认」\\n· 提成快照作废，需重新确认\\n· 会在审计里留下这条原因`
        ) === false
      ) {
        return;
      }
      unsettle.mutate({ order: fresh, reason: trimmed });
    } catch (error) {
      setActionError(describeWriteError(error, '读取结算单失败，请稍后重试'));
    }
  };

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
  /** 列表四态（v0.13 `data-state`）：算一个字符串交给 DOM，渲染分支交给 CSS。 */
  const listState: ListState = resolveListState({
    isPending: list.isPending,
    hasError: list.error !== null,
    isEmpty: rows.length === 0,
  });
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
      <div className="p-head">
        <div>
          <div className="eyebrow">结算单 C · 毛利与提成</div>
          <h1>结算单 C</h1>
          <p className="sub">{PAGE_DESCRIPTION}</p>
        </div>
        <div className="actions">
          {canCommission('read') ? (
            <button
              type="button"
              onClick={() => setCommissionOpen((open) => !open)}
              className="btn btn-ghost"
            >
              {commissionOpen ? '收起提成比例配置' : '提成比例配置'}
            </button>
          ) : null}
          {/*
            视觉稿这里还有「+ 新建」和「导出」两个按钮，**都没放**：
            C 单没有 create 端点（草稿由 E / N 完成时生成，D19 / D29），
            也没有列表导出端点（`exports.ts` 里只有 sales / purchase / inventory 三条）。
            画出来就是点不动的假按钮。
          */}
        </div>
      </div>

      {commissionOpen && canCommission('read') ? (
        <CommissionRatesPanel
          companyIds={me.data?.companyIds ?? []}
          canCreate={canCommission('create')}
          canDelete={canCommission('delete')}
        />
      ) : null}

      {me.data && !canViewPrice ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
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

      {/* 工具条（v0.13）：两态用分段按钮，来源类型用下拉 */}
      <div className="toolbar">
        <div className="seg" role="group" aria-label="按状态筛选">
          <button
            type="button"
            className={status === '' ? 'on' : undefined}
            aria-pressed={status === ''}
            onClick={() => setStatus('')}
          >
            全部状态
          </button>
          {SETTLEMENT_STATES.map((item) => (
            <button
              key={item}
              type="button"
              className={status === item ? 'on' : undefined}
              aria-pressed={status === item}
              title={SETTLEMENT_STATE_HINT[item]}
              onClick={() => setStatus(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <select
          value={sourceDocType}
          onChange={(event) =>
            setSourceDocType(event.target.value as '' | SettlementSourceDocType)
          }
          aria-label="按来源单据类型筛选"
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
          placeholder="搜索单号"
          aria-label="搜索单号"
          className="search"
        />
        <span className="ml-auto text-sm" style={{ color: 'var(--text-3)' }}>
          C 单不手工开：E / N 单完成时自动生成草稿（D19）
        </span>
      </div>

      {staleNotice ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {staleNotice}
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{actionError}</p>
      ) : null}

      {/*
        列表（v0.13）：四态由 `data-state` 驱动，`tbody` 里三个状态行常驻。
        视觉稿的「点表头排序」不做——`SettlementOrderListQuerySchema` 只有 cursor / limit，
        没有 sort 参数，点下去只会静默无效（契约层面就不支持）。
      */}
      <div className="card" data-state={listState}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1060px] text-left">
            <thead>
              <tr>
                <th>单号</th>
                <th>来源单</th>
                <th className="num">总售价</th>
                <th className="num">总成本</th>
                <th className="num">毛利</th>
                <th className="num">毛利率</th>
                <th className="num">提成</th>
                <th>状态</th>
                <th>日期</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              <tr className="st-tr st-loading">
                <td colSpan={10}>
                  <ListLoading label="正在加载结算单…" />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={10}>
                  <ListError
                    title="结算单加载失败"
                    error={list.error}
                    onRetry={() => void list.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={10}>
                  <ListEmpty title="暂无结算单。结算单不手工开：先在销售单 E / 内部交易单 N 里把单据完成，系统会自动生成草稿（D19）。" />
                </td>
              </tr>
              {rows.map((order: SettlementOrder) => (
                <tr key={order.id} className="r-row">
                  <td className="whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setDetailId(order.id)}
                      className="font-mono text-xs text-slate-900 underline-offset-2 hover:underline"
                    >
                      {order.orderNo}
                    </button>
                  </td>
                  <td className="whitespace-nowrap text-slate-600">
                    {/* 列表用紧凑写法（单号自带 E / N 前缀），省宽给「日期」和「操作」 */}
                    {sourceDocShort(order.sourceDocType, order.sourceDocId, docNoOf(order))}
                  </td>
                  <td className="num">
                    <Money value={order.totalSaleAmount} canView={canViewPrice} />
                  </td>
                  <td className="num">
                    <Money value={order.totalCostAmount} canView={canViewPrice} />
                  </td>
                  <td className="num">
                    <Money value={order.grossProfit} canView={canViewPrice} />
                  </td>
                  <td className="num">
                    {canViewPrice ? formatRate(order.grossMarginRate) : MASKED_AMOUNT}
                  </td>
                  <td className="num">
                    <Money value={order.commissionAmount} canView={canViewPrice} />
                  </td>
                  <td>
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="whitespace-nowrap text-slate-600">
                    {formatShortDateTime(order.createdAt)}
                  </td>
                  <td>
                    <div className="flex justify-end gap-2">
                      {/*
                        单号本身就是「进详情」的入口，所以行内不再单独放「详情」按钮：
                        C 单有 10 列，多一个按钮就把「操作」列挤出卡片（视觉稿也没这个按钮）。
                      */}
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
        </div>
        {/* 游标分页：没有总页数，只给「上一批 / 下一批」（同 N 单） */}
        {pageIndex > 0 || nextCursor !== null ? (
          <div className="pager">
            <button
              type="button"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            >
              上一批
            </button>
            <span className="of">
              第 {pageIndex + 1} 批{nextCursor === null ? ' · 已是最后一批' : ''}
            </span>
            <button
              type="button"
              disabled={!nextCursor}
              onClick={() => {
                if (!nextCursor) return;
                setCursors((items) => [...items.slice(0, pageIndex + 1), nextCursor]);
                setPageIndex((index) => index + 1);
              }}
            >
              下一批
            </button>
          </div>
        ) : null}
      </div>

      <p className="note">
        结算单<b>没有「新建」按钮</b>：草稿由 E 销售单 / N 内部交易单「已完成」时自动生成（D19 / D29）。
        一期一单只结算一次（D19），<b>结算后可撤销</b>（D88：整单退回「待确认」，须填原因并记审计），
        但<b>不能冲正</b>——错账仍走 R 客户退货（D2③）。
      </p>

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
              busy={confirm.isPending || unsettle.isPending}
              onClose={() => setDetailId(null)}
              onConfirm={() => void askConfirm(detailOrder.id)}
              onUnsettle={() => void askUnsettle(detailOrder.id)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
