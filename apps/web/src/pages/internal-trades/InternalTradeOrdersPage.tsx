/**
 * 内部交易单 N 页面（`/internal-trades`，22 页 IA 第 6 页；D22 / D31 / D68）。
 *
 * 这张单干的事：把货从一个公司搬到另一个公司（同一租户内），内部价由制单人手填。
 * 与 A / B / E 单最大的不同，是它的**状态是独立四态**（进行中 / 在途 / 已完成 / 已取消），
 * `在途` 这段时间货已经锁定但**批次仍归发出公司**，到货确认后才转司（D22 / D31 / D68③）。
 *
 * 本批接口只给了 5 条端点（列表 / 开单 / 详情 / 改单 / 取消），**没有发货与到货确认**，
 * 所以页面上不会出现这两个按钮——不是忘了画，是进入 `在途` 要锁批次可用量、
 * 转司要在同一事务里改批次 `company_id`，都等 inventory 写能力落地（契约第二批明写不做）。
 * 页面上把这件事讲清楚，比画一个点下去 501 的按钮诚实。
 */

import type {
  InternalTradeOrder,
  InternalTradeOrderDetail,
  InternalTradeOrderStatus,
  InventoryBatch,
  Product,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { allows, type ScopeAction } from '../../lib/access';
import { useEmployeeLabel } from '../../lib/employee-directory';
import {
  describeWriteError,
  isStaleVersionError,
  recoverFromStaleVersion,
  staleActionRetryText,
  staleUnrecoveredText,
  staleVersionRecoveredText,
} from '../../lib/write-error';
import {
  formatMoney,
  formatQty,
  cancelDisabledReason,
  sumDecimal,
} from '../../lib/decimal';
import { authApi, authKeys } from '../auth/auth-api';
import { extractIssues } from '../masterdata/masterdata-api';
import {
  INTERNAL_TRADE_STATES,
  INTERNAL_TRADE_STATE_HINT,
  INTERNAL_TRADE_STATE_STYLE,
  batchLabelOf,
  batchOptionLabel,
  canEdit,
  internalPriceGap,
  internalTradeQueryKeys,
  internalTradesApi,
  lineAmountOf,
  linesTotal,
  productNameOf,
  totalLineQty,
  tradeRouteText,
  updateInputOf,
  validateDraft,
  type InternalTradeLineDraft,
} from './internal-trades-api';

const PAGE_DESCRIPTION =
  '同一租户内把货从一个公司搬到另一个公司。内部价手工填（D68①）；明细分批次只能引发出公司批次（D22）；在途期间批次仍归发出公司，收货方确认到货才转司（D31 / D68③）。';

const EMPTY_LINE: InternalTradeLineDraft = { productId: '', batchIds: [], qty: '1', unitPrice: '' };

/* ------------------------------ 小工具 ------------------------------ */

function errorText(error: unknown): string {
  return describeWriteError(error);
}

function shortId(id: string): string {
  return id.slice(0, 8);
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

function StatusBadge({ status }: { readonly status: InternalTradeOrderStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
        INTERNAL_TRADE_STATE_STYLE[status]
      }`}
      title={INTERNAL_TRADE_STATE_HINT[status]}
    >
      {status}
    </span>
  );
}

/* ------------------------------ 表单 ------------------------------ */

interface CompanyOption {
  readonly id: string;
  readonly name: string;
  /** 公司码（4 位）；`/companies` 还没回来时用 id 兜底，所以可能为空串。 */
  readonly code: string;
}

interface OrderFormProps {
  readonly editing: InternalTradeOrderDetail | null;
  readonly companies: readonly CompanyOption[];
  readonly products: readonly Product[];
  readonly batches: readonly InventoryBatch[];
  readonly batchesError: string | null;
  readonly handlerName: string;
  readonly fromCompanyId: string;
  readonly toCompanyId: string;
  readonly internalPrice: string;
  readonly lines: readonly InternalTradeLineDraft[];
  readonly busy: boolean;
  readonly errors: readonly string[];
  readonly serverIssues: readonly { readonly path: string; readonly message: string }[];
  readonly onFromCompanyChange: (value: string) => void;
  readonly onToCompanyChange: (value: string) => void;
  readonly onInternalPriceChange: (value: string) => void;
  readonly onLineChange: (index: number, patch: Partial<InternalTradeLineDraft>) => void;
  readonly onAddLine: () => void;
  readonly onRemoveLine: (index: number) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onCancel: () => void;
}

function OrderForm({
  editing,
  companies,
  products,
  batches,
  batchesError,
  handlerName,
  fromCompanyId,
  toCompanyId,
  internalPrice,
  lines,
  busy,
  errors,
  serverIssues,
  onFromCompanyChange,
  onToCompanyChange,
  onInternalPriceChange,
  onLineChange,
  onAddLine,
  onRemoveLine,
  onSubmit,
  onCancel,
}: OrderFormProps) {
  const total = linesTotal(lines);
  const gap = internalPriceGap(internalPrice.trim(), lines);
  const toOptions = companies.filter((company) => company.id !== fromCompanyId);

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          {editing ? `修改内部交易单 ${editing.orderNo}` : '新建内部交易单'}
        </h2>
        <span className="text-xs text-slate-500">
          经手人 {handlerName}（当前登录人）· 单号由服务端按 D16 生成
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm">
          <span className="text-slate-600">发出公司</span>
          {editing ? (
            <p className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              {editing.fromCompanyName}
            </p>
          ) : (
            <select
              value={fromCompanyId}
              onChange={(event) => onFromCompanyChange(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">请选择发出公司</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.code ? `${company.name}（${company.code}）` : company.name}
                </option>
              ))}
            </select>
          )}
          <span className="mt-1 block text-[11px] text-slate-400">
            明细里的批次必须是这家公司的（D22）
          </span>
        </label>

        <label className="text-sm">
          <span className="text-slate-600">接收公司</span>
          {editing ? (
            <p className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              {editing.toCompanyName}
            </p>
          ) : (
            <select
              value={toCompanyId}
              onChange={(event) => onToCompanyChange(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">请选择接收公司</option>
              {toOptions.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.code ? `${company.name}（${company.code}）` : company.name}
                </option>
              ))}
            </select>
          )}
          <span className="mt-1 block text-[11px] text-slate-400">
            到货确认后批次归属才转到这家（D31）
          </span>
        </label>

        <label className="text-sm">
          <span className="text-slate-600">内部价</span>
          <input
            value={internalPrice}
            onChange={(event) => onInternalPriceChange(event.target.value)}
            inputMode="decimal"
            placeholder="手工填，如 1200.00"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-[11px] text-slate-400">
            系统不按成本价 / 加成自动算（D68①）；一期只记录，不做利润抵消（D45）
          </span>
        </label>
      </div>

      {editing ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          发出 / 接收公司不在本批修改范围（契约：是否允许在「进行中」换接收公司尚未拍板），
          所以这里只读展示。
        </p>
      ) : null}

      {batchesError ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          批次列表加载失败：{batchesError}——没有批次就没法开单（D22），请先重试。
        </p>
      ) : null}

      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-700">商品明细（至少 1 行）</h3>
          <span className="text-[11px] text-slate-400">
            明细合计 {formatMoney(total)} · 共{' '}
            {formatQty(sumDecimal(lines.map((line) => line.qty)))} 件
          </span>
        </div>

        {lines.map((line, index) => {
          const rowBatches = batches.filter(
            (batch) => !line.productId || batch.productId === line.productId,
          );
          return (
            <div key={index} className="rounded-lg border border-slate-200 p-3">
              <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto_auto]">
                <label className="text-sm">
                  <span className="text-slate-600">第 {index + 1} 行商品</span>
                  <select
                    value={line.productId}
                    onChange={(event) =>
                      onLineChange(index, { productId: event.target.value, batchIds: [] })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">请选择商品</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-slate-600">数量</span>
                  <input
                    value={line.qty}
                    onChange={(event) => onLineChange(index, { qty: event.target.value })}
                    inputMode="decimal"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-slate-600">单价</span>
                  <input
                    value={line.unitPrice}
                    onChange={(event) => onLineChange(index, { unitPrice: event.target.value })}
                    inputMode="decimal"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
                <div className="self-end pb-2 text-xs text-slate-500">
                  金额 {formatMoney(lineAmountOf(line))}
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveLine(index)}
                  disabled={lines.length <= 1}
                  className="mt-5 h-9 self-start whitespace-nowrap rounded-lg border border-slate-300 px-2 text-xs text-slate-600 disabled:opacity-40"
                >
                  删除
                </button>
              </div>

              <div className="mt-2">
                <span className="text-[11px] text-slate-500">
                  引用批次（至少 1 个，只能是发出公司批次 D22）
                </span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {!line.productId ? (
                    <span className="text-[11px] text-slate-400">先选商品，再选批次</span>
                  ) : rowBatches.length === 0 ? (
                    <span className="text-[11px] text-slate-400">
                      发出公司该商品暂无批次（跨公司的批次不会出现）
                    </span>
                  ) : (
                    rowBatches.map((batch) => {
                      const checked = line.batchIds.includes(batch.id);
                      return (
                        <button
                          key={batch.id}
                          type="button"
                          onClick={() =>
                            onLineChange(index, {
                              batchIds: checked
                                ? line.batchIds.filter((id) => id !== batch.id)
                                : [...line.batchIds, batch.id],
                            })
                          }
                          className={`rounded-full border px-2 py-0.5 text-[11px] ${
                            checked
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-300 bg-white text-slate-600'
                          }`}
                        >
                          {batchOptionLabel(batch)}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          );
        })}

        <button
          type="button"
          onClick={onAddLine}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600"
        >
          + 加一行商品
        </button>
      </div>

      {gap ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{gap}</p>
      ) : null}

      {errors.length > 0 ? (
        <ul className="space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {errors.map((item) => (
            <li key={item}>· {item}</li>
          ))}
        </ul>
      ) : null}
      {serverIssues.length > 0 ? (
        <ul className="space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {serverIssues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              ·{' '}
              {issue.path ? <code className="font-mono text-[11px]">{issue.path}</code> : null}{' '}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? '提交中…' : editing ? '保存修改' : '开单'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600"
        >
          取消
        </button>
      </div>
    </form>
  );
}

/* ------------------------------ 详情 ------------------------------ */

interface DetailPanelProps {
  readonly order: InternalTradeOrderDetail;
  readonly products: readonly Product[];
  readonly batches: readonly InventoryBatch[];
  readonly canUpdate: boolean;
  readonly canCancel: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
}

function DetailPanel({
  order,
  products,
  batches,
  canUpdate,
  canCancel,
  busy,
  onClose,
  onEdit,
  onCancel,
}: DetailPanelProps) {
  const employeeLabel = useEmployeeLabel();
  // 金额按 view_price 脱敏时是 null：整单合计只能一起显示「—」，不能把 null 当 0 累加。
  const lineAmounts = order.lines.map((line) => line.amount);
  const lineTotal = lineAmounts.some((value) => value === null)
    ? null
    : sumDecimal(lineAmounts as readonly string[]);
  const cancelReason = cancelDisabledReason(order.cancelable.reason);

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-mono text-sm text-slate-900">{order.orderNo}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <StatusBadge status={order.status} />
            <span>{tradeRouteText(order)}</span>
            <span className="text-slate-300">|</span>
            <span>经手人 {employeeLabel(order.handlerId)}</span>
            <span className="text-slate-300">|</span>
            <span>开单 {formatDateTime(order.createdAt)}</span>
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

      <dl className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-slate-500">内部价</dt>
          <dd className="mt-0.5 font-mono">{formatMoney(order.internalPrice)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">明细合计</dt>
          <dd className="mt-0.5 font-mono">{formatMoney(lineTotal)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">在途量</dt>
          <dd className="mt-0.5 font-mono">{formatQty(order.inTransitQty)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">明细行数</dt>
          <dd className="mt-0.5 font-mono">{order.lines.length}</dd>
        </div>
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2">商品</th>
              <th className="px-3 py-2">批次（D22）</th>
              <th className="px-3 py-2">数量</th>
              <th className="px-3 py-2">单价</th>
              <th className="px-3 py-2">金额</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line, index) => (
              <tr key={`${line.productId}-${index}`} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2">{productNameOf(products, line.productId)}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-slate-500">
                  {line.batchIds.map((id) => batchLabelOf(batches, id)).join(' / ')}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{formatQty(line.qty)}</td>
                <td className="px-3 py-2 font-mono text-xs">{formatMoney(line.unitPrice)}</td>
                <td className="px-3 py-2 font-mono text-xs">{formatMoney(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canUpdate || !canEdit(order.status)}
          onClick={onEdit}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
          title={canEdit(order.status) ? undefined : '只有「进行中」能改单（D68②）'}
        >
          修改
        </button>
        <button
          type="button"
          disabled={!canCancel || !order.cancelable.allowed || busy}
          onClick={onCancel}
          className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700 disabled:opacity-40"
        >
          取消单据
        </button>
        {!order.cancelable.allowed && cancelReason ? (
          <span className="text-xs text-slate-500">{cancelReason}</span>
        ) : null}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-400">
        本批没有「发货 / 到货确认」端点：进入「在途」要按 D31 锁定批次可用量，到货确认要在同一事务里
        把批次归属改到接收公司（D68③），两条都依赖 inventory 写能力。所以这里不画这两个按钮，
        也不假装能点。状态推进由后端接口落地后再接。
      </p>
    </section>
  );
}

/* ------------------------------ 页面 ------------------------------ */

export function InternalTradeOrdersPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me(), retry: false });

  const [status, setStatus] = useState<'' | InternalTradeOrderStatus>('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<InternalTradeOrderDetail | null>(null);
  const [formFrom, setFormFrom] = useState('');
  const [formTo, setFormTo] = useState('');
  const [internalPrice, setInternalPrice] = useState('');
  const [lines, setLines] = useState<InternalTradeLineDraft[]>([{ ...EMPTY_LINE }]);
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 版本冲突后已把最新 version 接上时的提示（与红色报错互斥）。 */
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const scope = me.data?.scope;
  const can = (action: ScopeAction) => allows(scope, 'internal_trade', action);
  const myCompanyIds = me.data?.companyIds ?? [];

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [fromFilter, toFilter, status, keyword]);

  const filters = useMemo(
    () => ({
      fromCompanyId: fromFilter || undefined,
      toCompanyId: toFilter || undefined,
      status: status || undefined,
      keyword: keyword.trim() || undefined,
      cursor: cursors[pageIndex] ?? null,
    }),
    [fromFilter, toFilter, status, keyword, cursors, pageIndex],
  );

  const list = useQuery({
    queryKey: internalTradeQueryKeys.list(filters),
    queryFn: () => internalTradesApi.list(filters),
  });

  const detail = useQuery({
    queryKey: internalTradeQueryKeys.detail(detailId),
    queryFn: () => internalTradesApi.detail(detailId!),
    enabled: detailId !== null,
  });

  const companies = useQuery({
    queryKey: internalTradeQueryKeys.companies,
    queryFn: () => internalTradesApi.listCompanies(),
    staleTime: 5 * 60_000,
  });

  const products = useQuery({
    queryKey: internalTradeQueryKeys.products,
    queryFn: () => internalTradesApi.listProducts(),
    staleTime: 5 * 60_000,
  });

  // 批次只取**发出公司**的：跨公司的批次不该出现在下拉里（D22）。
  const batches = useQuery({
    queryKey: internalTradeQueryKeys.batches(formFrom),
    queryFn: () => internalTradesApi.listBatches(formFrom || undefined),
    enabled: formFrom.length > 0,
  });

  /** 列表与详情里的批次号回显用（发出公司可能各不相同，这里按可见范围取一份）。 */
  const detailBatches = useQuery({
    queryKey: internalTradeQueryKeys.batches(''),
    queryFn: () => internalTradesApi.listBatches(),
    staleTime: 60_000,
  });

  const companyOptions: readonly CompanyOption[] = useMemo(() => {
    const items = companies.data?.items ?? [];
    if (items.length > 0) {
      return items.map((item) => ({ id: item.id, name: item.name, code: item.code ?? '' }));
    }
    // `/companies` 还没回来时先用 me 的公司 id 占位，至少不会阻塞开单。
    return myCompanyIds.map((id) => ({ id, name: id, code: '' }));
  }, [companies.data, myCompanyIds]);

  const save = useMutation({
    mutationFn: () => {
      const handlerId = me.data?.employeeId ?? '';
      const drafts = lines.map((line) => ({
        productId: line.productId,
        batchIds: line.batchIds,
        qty: line.qty.trim(),
        unitPrice: line.unitPrice.trim(),
        amount: lineAmountOf(line),
      }));
      if (editing) {
        return internalTradesApi.update(
          editing.id,
          updateInputOf(lines, internalPrice, handlerId),
          editing.version,
        );
      }
      return internalTradesApi.create({
        fromCompanyId: formFrom,
        toCompanyId: formTo,
        handlerId,
        lines: drafts,
        internalPrice: internalPrice.trim(),
      });
    },
    onSuccess: async (order) => {
      await queryClient.invalidateQueries({ queryKey: ['internal-trades'] });
      resetForm();
      setDetailId(order.id);
    },
    /**
     * 版本冲突（别人先改过）：把最新 version 接回表单，用户点一次「保存修改」就能过。
     * 不自动重提——那等于拿旧内容覆盖别人的改动，得让用户先核对（D60）。
     */
    onError: async (error) => {
      if (!editing) return;
      const fresh = await recoverFromStaleVersion(error, editing.id, internalTradesApi.detail);
      if (!fresh) {
        // 非 stale 的红条由 `save.error` 渲染；stale 但读不到最新版本时那条被抑制，必须在这里兜底
        if (isStaleVersionError(error)) setActionError(staleUnrecoveredText());
        return;
      }
      setEditing({ ...editing, version: fresh.version });
      setStaleNotice(staleVersionRecoveredText(fresh.version));
      await queryClient.invalidateQueries({ queryKey: ['internal-trades'] });
    },
  });

  const cancelOrder = useMutation({
    mutationFn: (order: InternalTradeOrderDetail) =>
      internalTradesApi.cancel(order.id, order.version),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['internal-trades'] });
    },
    /**
     * 取消撞版本冲突（别人刚改过 / 刚取消了这张单）：同步最新版本并说明，
     * 不自动重提——取消不可逆，让用户看清当前状态再点（D60）。
     */
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, internalTradesApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '取消失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '取消'));
      await queryClient.invalidateQueries({ queryKey: ['internal-trades'] });
    },
  });

  function resetForm() {
    setFormOpen(false);
    setEditing(null);
    setFormFrom('');
    setFormTo('');
    setInternalPrice('');
    setLines([{ ...EMPTY_LINE }]);
    setClientErrors([]);
    save.reset();
    setStaleNotice(null);
  }

  const beginCreate = () => {
    setEditing(null);
    setFormFrom(myCompanyIds.length === 1 ? myCompanyIds[0]! : '');
    setFormTo('');
    setInternalPrice('');
    setLines([{ ...EMPTY_LINE }]);
    setClientErrors([]);
    save.reset();
    setFormOpen(true);
    setDetailId(null);
  };

  const beginEdit = (order: InternalTradeOrderDetail) => {
    setEditing(order);
    setFormFrom(order.fromCompanyId);
    setFormTo(order.toCompanyId);
    setInternalPrice(order.internalPrice ?? '');
    setLines(
      order.lines.length > 0
        ? order.lines.map((line) => ({
            productId: line.productId,
            batchIds: [...line.batchIds],
            qty: line.qty,
            unitPrice: line.unitPrice ?? '',
          }))
        : [{ ...EMPTY_LINE }],
    );
    setClientErrors([]);
    save.reset();
    setFormOpen(true);
  };

  /** 改单 / 取消都要先取最新详情：列表里的是旧版本，直接拿它的 version 会 409（D60）。 */
  const withFreshDetail = async (
    orderId: string,
    action: (fresh: InternalTradeOrderDetail) => void,
  ): Promise<void> => {
    setActionError(null);
    try {
      const fresh = await internalTradesApi.detail(orderId);
      setDetailId(orderId);
      action(fresh);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const askCancel = (order: InternalTradeOrderDetail) => {
    /**
     * 列表行按钮只按「进行中」判断，服务端还可能因为「已完成 / 已被别人取消 / 有下游单据」拒绝。
     * 以前这里直接 return，用户点了没反应——必须把原因说出来。
     */
    if (!order.cancelable.allowed) {
      setActionError(cancelDisabledReason(order.cancelable.reason) ?? '当前状态不能取消这张单');
      return;
    }
    setActionError(null);
    if (
      globalThis.confirm?.(
        `确认取消内部交易单 ${order.orderNo} 吗？取消后不可恢复，错账请另开一张（D47）。`,
      ) === false
    ) {
      return;
    }
    cancelOrder.mutate(order);
  };

  const serverIssues = save.error instanceof ApiError ? extractIssues(save.error.details) : [];
  const rows = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  const detailOrder = detail.data;
  const meData = me.data;

  return (
    <section className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">内部交易单 N</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">{PAGE_DESCRIPTION}</p>
        </div>
        <button
          type="button"
          onClick={beginCreate}
          disabled={!can('create') || myCompanyIds.length === 0}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          新建内部交易单
        </button>
      </header>

      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        四态：进行中 → 在途 → 已完成（或已取消，D68②）。只有「进行中」能改单；
        <b>本批没有发货与到货确认端点</b>，所以页面不画这两个按钮——状态推进要等 inventory
        写能力落地（D31 / D68③）。
      </p>

      {meData && !can('create') ? (
        <p className="text-xs text-slate-500">
          「新建」需要 internal_trade.create；当前身份只能查看（判定在服务端，前端只是不画按钮）。
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <select
          value={fromFilter}
          onChange={(event) => setFromFilter(event.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部发出公司</option>
          {companyOptions.map((company) => (
            <option key={company.id} value={company.id}>
              发出：{company.name}
            </option>
          ))}
        </select>
        <select
          value={toFilter}
          onChange={(event) => setToFilter(event.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部接收公司</option>
          {companyOptions.map((company) => (
            <option key={company.id} value={company.id}>
              接收：{company.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as '' | InternalTradeOrderStatus)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部状态</option>
          {INTERNAL_TRADE_STATES.map((item) => (
            <option key={item} value={item}>
              {item}
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

      {formOpen ? (
        <OrderForm
          editing={editing}
          companies={companyOptions}
          products={products.data?.items ?? []}
          batches={batches.data?.items ?? []}
          batchesError={batches.isError ? errorText(batches.error) : null}
          handlerName={meData?.displayName ?? '当前登录人'}
          fromCompanyId={formFrom}
          toCompanyId={formTo}
          internalPrice={internalPrice}
          lines={lines}
          busy={save.isPending}
          errors={clientErrors}
          serverIssues={serverIssues}
          onFromCompanyChange={(value) => {
            setFormFrom(value);
            // 换发出公司 = 换批次归属，之前选的批次一律清掉（D22）。
            setLines((current) => current.map((line) => ({ ...line, batchIds: [] })));
            if (value === formTo) setFormTo('');
          }}
          onToCompanyChange={setFormTo}
          onInternalPriceChange={setInternalPrice}
          onLineChange={(index, patch) =>
            setLines((current) =>
              current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
            )
          }
          onAddLine={() => setLines((current) => [...current, { ...EMPTY_LINE }])}
          onRemoveLine={(index) =>
            setLines((current) =>
              current.length > 1 ? current.filter((_, i) => i !== index) : current,
            )
          }
          onSubmit={(event) => {
            event.preventDefault();
            const errors = validateDraft({
              fromCompanyId: formFrom,
              toCompanyId: formTo,
              handlerId: meData?.employeeId ?? '',
              internalPrice,
              lines,
            });
            setClientErrors(errors);
            if (errors.length > 0) return;
            setActionError(null);
            save.mutate();
          }}
          onCancel={resetForm}
        />
      ) : null}

      {staleNotice ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {staleNotice}
        </p>
      ) : null}
      {save.error && serverIssues.length === 0 && !isStaleVersionError(save.error) ? (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{errorText(save.error)}</p>
      ) : null}
      {actionError ? (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {list.isPending ? (
          <p className="p-6 text-sm text-slate-500">正在加载内部交易单…</p>
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
            暂无内部交易单。可调整筛选条件，或用右上角「新建内部交易单」开第一张。
          </p>
        ) : (
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">单号</th>
                <th className="px-4 py-3">发出 → 接收</th>
                <th className="px-4 py-3">数量</th>
                <th className="px-4 py-3">内部价</th>
                <th className="px-4 py-3">在途量</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">经手人</th>
                <th className="px-4 py-3">开单时间</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order: InternalTradeOrder) => (
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
                  <td className="px-4 py-3">{tradeRouteText(order)}</td>
                  <td className="px-4 py-3 font-mono text-xs">{formatQty(totalLineQty(order.lines))}</td>
                  <td className="px-4 py-3 font-mono text-xs">{formatMoney(order.internalPrice)}</td>
                  <td className="px-4 py-3 font-mono text-xs">{formatQty(order.inTransitQty)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {shortId(order.handlerId)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{formatDateTime(order.createdAt)}</td>
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
                        disabled={!can('update') || !canEdit(order.status)}
                        onClick={() => void withFreshDetail(order.id, beginEdit)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40"
                        title={canEdit(order.status) ? undefined : '只有「进行中」能改单（D68②）'}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={!can('delete') || !canEdit(order.status) || cancelOrder.isPending}
                        onClick={() => void withFreshDetail(order.id, askCancel)}
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 disabled:opacity-40"
                      >
                        取消
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
              正在加载内部交易单详情…
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
              products={products.data?.items ?? []}
              batches={detailBatches.data?.items ?? []}
              canUpdate={can('update')}
              canCancel={can('delete')}
              busy={cancelOrder.isPending}
              onClose={() => setDetailId(null)}
              onEdit={() => beginEdit(detailOrder)}
              onCancel={() => askCancel(detailOrder)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
