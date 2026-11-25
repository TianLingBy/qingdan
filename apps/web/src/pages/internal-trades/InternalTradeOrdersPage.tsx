/**
 * 内部交易单 N 页面（`/internal-trades`，22 页 IA 第 6 页；D22 / D31 / D68）。
 *
 * 这张单干的事：把货从一个公司搬到另一个公司（同一租户内），内部价由制单人手填。
 * 与 A / B / E 单最大的不同，是它的**状态是独立四态**（进行中 / 在途 / 已完成 / 已取消），
 * `在途` 这段时间货已经锁定但**批次仍归发出公司**，到货确认后才转司（D22 / D31 / D68③）。
 *
 * 接口已给全 8 条端点（列表 / 开单 / 详情 / 改单 / 取消 / 到货确认 / 发货 / 撤销发货）。
 * 「发货」把「进行中」推进「在途」并锁住发出公司批次的可用量，权限点 `internal_trade.ship`；
 * 「撤销发货」把「在途」退回「进行中」并释放占用，权限点同为 `internal_trade.ship`，必须填原因。
 * 「到货确认」已接入（D31 / D68③）：仅「在途」可点，确认后批次在同一事务里转入接收公司、
 * N 单置为已完成，不可撤销。
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
import { BatchPager } from '../../components/ListPager';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import {
  DetailHead,
  DetailMetaDot,
  DocMeta,
  DocPill,
  LinesFooter,
} from '../../components/OrderDetailUI';
import { allows, type ScopeAction } from '../../lib/access';
import { useEmployeeLabel } from '../../lib/employee-directory';
import { resolveListState, type ListState } from '../../lib/list-state';
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
  INTERNAL_TRADE_STATE_TONE,
  batchLabelOf,
  batchOptionLabel,
  canEdit,
  dispatchDisabledReason,
  internalPriceGap,
  internalTradeQueryKeys,
  internalTradesApi,
  lineAmountOf,
  linesTotal,
  productNameOf,
  receiveDisabledReason,
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
 * 表格里塞完整年月日（`2026-11-18 00:57`）会多占 50 多 px，加了「商品」列之后
 * 「操作」就出卡片了；年份在列表里没人看，详情面板里仍是完整时间。
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
 * 列表「商品」文案：首行商品名（超长截断、悬停看全名），多商品时补「等 N 种」。
 *
 * `N` 按**不同商品数**算，不是按行数——同一商品拆两行（分两个批次发）仍是一种货。
 * 「等 N 种」放在截断之外：名字被截掉的时候，那才是这一列唯一还有信息量的部分。
 */
function ProductCell({
  products,
  lines,
}: {
  readonly products: readonly Product[];
  readonly lines: readonly { readonly productId: string }[];
}) {
  const first = lines[0];
  if (!first) return <span className="cell-none">—</span>;
  const name = productNameOf(products, first.productId);
  const kinds = new Set(lines.map((line) => line.productId)).size;
  return (
    <>
      <span className="cell-clip" title={name}>
        {name}
      </span>
      {kinds > 1 ? <span className="cell-sub">等 {kinds} 种</span> : null}
    </>
  );
}

/**
 * 四态 → v0.13 `.st` 色档（映射本身在 api 层，这里只负责渲染）。
 *
 * **在途单独一档（`transit` 蓝）**：它是 D68② 给 N 单加的中间态，和「进行中」长得一样
 * 会让人分不清货到底出没出门。已取消用 `cancel`（灰 + 删除线），一眼看出是废单。
 */
function StatusBadge({ status }: { readonly status: InternalTradeOrderStatus }) {
  return (
    <DocPill
      label={status}
      tone={INTERNAL_TRADE_STATE_TONE[status]}
      title={INTERNAL_TRADE_STATE_HINT[status]}
    />
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
    <form onSubmit={onSubmit} className="form-card">
      <div className="form-head">
        <h2>{editing ? `修改内部交易单 ${editing.orderNo}` : '新建内部交易单'}</h2>
        <span className="detail-why">
          经手人 {handlerName}（当前登录人）· 单号由服务端按 D16 生成
        </span>
      </div>

      <div className="fm c3">
        <label>
          <span>发出公司</span>
          {editing ? (
            <p className="fm-readonly">{editing.fromCompanyName}</p>
          ) : (
            <select
              value={fromCompanyId}
              onChange={(event) => onFromCompanyChange(event.target.value)}
            >
              <option value="">请选择发出公司</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.code ? `${company.name}（${company.code}）` : company.name}
                </option>
              ))}
            </select>
          )}
          <small>明细里的批次必须是这家公司的（D22）</small>
        </label>

        <label>
          <span>接收公司</span>
          {editing ? (
            <p className="fm-readonly">{editing.toCompanyName}</p>
          ) : (
            <select
              value={toCompanyId}
              onChange={(event) => onToCompanyChange(event.target.value)}
            >
              <option value="">请选择接收公司</option>
              {toOptions.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.code ? `${company.name}（${company.code}）` : company.name}
                </option>
              ))}
            </select>
          )}
          <small>到货确认后批次归属才转到这家（D31）</small>
        </label>

        <label>
          <span>内部价</span>
          <input
            value={internalPrice}
            onChange={(event) => onInternalPriceChange(event.target.value)}
            inputMode="decimal"
            placeholder="手工填，如 1200.00"
          />
          <small>系统不按成本价 / 加成自动算（D68①）；一期只记录，不做利润抵消（D45）</small>
        </label>
      </div>

      {editing ? (
        <p className="alert alert-info alert-sm">
          发出 / 接收公司不在本批修改范围（契约：是否允许在「进行中」换接收公司尚未拍板），
          所以这里只读展示。
        </p>
      ) : null}

      {batchesError ? (
        <p className="alert alert-warn alert-sm">
          批次列表加载失败：{batchesError}——没有批次就没法开单（D22），请先重试。
        </p>
      ) : null}

      <div className="form-stack">
        <div className="form-head">
          <h3 className="form-title">商品明细（至少 1 行）</h3>
          <span className="chip-none">
            明细合计 {formatMoney(total)} · 共{' '}
            {formatQty(sumDecimal(lines.map((line) => line.qty)))} 件
          </span>
        </div>

        {lines.map((line, index) => {
          const rowBatches = batches.filter(
            (batch) => !line.productId || batch.productId === line.productId,
          );
          return (
            <div key={index} className="line-card">
              <div className="fm lines">
                <label>
                  <span>第 {index + 1} 行商品</span>
                  <select
                    value={line.productId}
                    onChange={(event) =>
                      onLineChange(index, { productId: event.target.value, batchIds: [] })
                    }
                  >
                    <option value="">请选择商品</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>数量</span>
                  <input
                    value={line.qty}
                    onChange={(event) => onLineChange(index, { qty: event.target.value })}
                    inputMode="decimal"
                  />
                </label>
                <label>
                  <span>单价</span>
                  <input
                    value={line.unitPrice}
                    onChange={(event) => onLineChange(index, { unitPrice: event.target.value })}
                    inputMode="decimal"
                  />
                </label>
                <div className="line-amount">
                  金额 {formatMoney(lineAmountOf(line))}
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveLine(index)}
                  disabled={lines.length <= 1}
                  className="btn btn-row"
                >
                  删除
                </button>
              </div>

              <div className="line-batches">
                <span className="chip-none">
                  引用批次（至少 1 个，只能是发出公司批次 D22）
                </span>
                <div className="chip-row">
                  {!line.productId ? (
                    <span className="chip-none">先选商品，再选批次</span>
                  ) : rowBatches.length === 0 ? (
                    <span className="chip-none">
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
                          className={`chip${checked ? ' on' : ''}`}
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

        <button type="button" onClick={onAddLine} className="btn form-add">
          + 加一行商品
        </button>
      </div>

      {gap ? <p className="alert alert-warn alert-sm">{gap}</p> : null}

      {errors.length > 0 ? (
        <ul className="alert alert-bad alert-sm">
          {errors.map((item) => (
            <li key={item}>· {item}</li>
          ))}
        </ul>
      ) : null}
      {serverIssues.length > 0 ? (
        <ul className="alert alert-bad alert-sm">
          {serverIssues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              ·{' '}
              {issue.path ? <code className="mono">{issue.path}</code> : null}{' '}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="detail-acts">
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? '提交中…' : editing ? '保存修改' : '开单'}
        </button>
        <button type="button" onClick={onCancel} className="btn">
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
  readonly canReceive: boolean;
  /** `internal_trade.ship`：发货与撤销发货共用这个权限点，不是 update。 */
  readonly canShip: boolean;
  readonly busy: boolean;
  readonly receiveBusy: boolean;
  readonly dispatchBusy: boolean;
  readonly revokeBusy: boolean;
  /** 该单正在填撤销原因（点「撤销发货」只展开输入区，不发请求）。 */
  readonly revoking: boolean;
  readonly revokeReason: string;
  readonly revokeError: string | null;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onReceive: () => void;
  readonly onDispatch: () => void;
  readonly onStartRevoke: () => void;
  readonly onRevokeReasonChange: (value: string) => void;
  readonly onSubmitRevoke: () => void;
  readonly onCancelRevoke: () => void;
}

export function DetailPanel({
  order,
  products,
  batches,
  canUpdate,
  canCancel,
  canReceive,
  canShip,
  busy,
  receiveBusy,
  dispatchBusy,
  revokeBusy,
  revoking,
  revokeReason,
  revokeError,
  onClose,
  onEdit,
  onCancel,
  onReceive,
  onDispatch,
  onStartRevoke,
  onRevokeReasonChange,
  onSubmitRevoke,
  onCancelRevoke,
}: DetailPanelProps) {
  const employeeLabel = useEmployeeLabel();
  // 金额按 view_price 脱敏时是 null：整单合计只能一起显示「—」，不能把 null 当 0 累加。
  const lineAmounts = order.lines.map((line) => line.amount);
  const lineTotal = lineAmounts.some((value) => value === null)
    ? null
    : sumDecimal(lineAmounts as readonly string[]);
  const cancelReason = cancelDisabledReason(order.cancelable.reason);

  return (
    <section className="card detail">
      <DetailHead
        docLabel="内部交易单"
        orderNo={order.orderNo}
        pill={<StatusBadge status={order.status} />}
        meta={
          <>
            <span>{tradeRouteText(order)}</span>
            <DetailMetaDot />
            <span>经手人 {employeeLabel(order.handlerId)}</span>
            <DetailMetaDot />
            <span>开单 {formatDateTime(order.createdAt)}</span>
          </>
        }
        onClose={onClose}
      />

      <DocMeta
        columns={4}
        items={[
          { label: '内部价', value: formatMoney(order.internalPrice), tone: 'money' },
          { label: '明细合计', value: formatMoney(lineTotal), tone: 'money' },
          { label: '在途量', value: formatQty(order.inTransitQty), mono: true },
          { label: '明细行数', value: `${order.lines.length} 行`, mono: true },
        ]}
      />

      <div className="ln">
        <table>
          <thead>
            <tr>
              <th>商品</th>
              <th>批次（D22）</th>
              <th className="num">数量</th>
              <th className="num">单价</th>
              <th className="num">金额</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line, index) => (
              <tr key={`${line.productId}-${index}`}>
                <td>{productNameOf(products, line.productId)}</td>
                <td className="cell-muted">
                  {line.batchIds.map((id) => batchLabelOf(batches, id)).join(' / ')}
                </td>
                <td className="num">{formatQty(line.qty)}</td>
                <td className="num">{formatMoney(line.unitPrice)}</td>
                <td className="num">{formatMoney(line.amount)}</td>
              </tr>
            ))}
          </tbody>
          <LinesFooter
            colSpan={4}
            note={`共 ${order.lines.length} 行 · 数量合计 ${formatQty(totalLineQty(order.lines))}`}
            sum={formatMoney(lineTotal)}
          />
        </table>
      </div>

      <div className="detail-acts">
        <button
          type="button"
          disabled={!canUpdate || !canEdit(order.status)}
          onClick={onEdit}
          className="btn btn-ghost"
          title={canEdit(order.status) ? undefined : '只有「进行中」能改单（D68②）'}
        >
          修改
        </button>
        {canShip && order.status === '进行中' ? (
          <button
            type="button"
            disabled={dispatchBusy}
            onClick={onDispatch}
            className="btn btn-primary"
          >
            {dispatchBusy ? '发货中…' : '发货'}
          </button>
        ) : null}
        {canShip && order.status === '在途' && !revoking ? (
          <button
            type="button"
            disabled={revokeBusy}
            onClick={onStartRevoke}
            className="btn btn-ghost"
          >
            撤销发货
          </button>
        ) : null}
        {order.status === '在途' ? (
          <button
            type="button"
            disabled={!canReceive || receiveBusy}
            onClick={onReceive}
            title={!canReceive ? '当前身份没有 internal_trade.approve 权限' : undefined}
            className="btn btn-primary"
          >
            到货确认
          </button>
        ) : order.status === '进行中' ? (
          <span className="detail-why">{receiveDisabledReason(order.status)}</span>
        ) : (
          <span className="detail-why">{dispatchDisabledReason(order.status)}</span>
        )}
        {order.status === '在途' && !canReceive ? (
          <span className="detail-why">当前身份没有 internal_trade.approve 权限</span>
        ) : null}
        <button
          type="button"
          disabled={!canCancel || !order.cancelable.allowed || busy}
          onClick={onCancel}
          className="btn danger act-end"
        >
          取消单据
        </button>
        {!order.cancelable.allowed && cancelReason ? (
          <span className="detail-why">{cancelReason}</span>
        ) : null}
      </div>

      {revoking ? (
        <div className="alert alert-warn">
          <h4>撤销发货</h4>
          <p>撤销会把单据退回「进行中」并释放这笔在途占用（不转司）。</p>
          <div className="detail-acts">
            <label className="reason-field">
              <span>撤销原因（必填）</span>
              <input
                value={revokeReason}
                onChange={(event) => onRevokeReasonChange(event.target.value)}
                maxLength={200}
                placeholder="例如：批次锁错，需要重新发货"
                className="ipt"
              />
            </label>
            <button
              type="button"
              disabled={revokeBusy}
              onClick={onSubmitRevoke}
              className="btn btn-primary"
            >
              {revokeBusy ? '撤销中…' : '确认撤销'}
            </button>
            <button type="button" onClick={onCancelRevoke} className="btn btn-ghost">
              取消
            </button>
          </div>
          {revokeError ? <p className="detail-why">{revokeError}</p> : null}
        </div>
      ) : null}

      <p className="detail-why">
        「发货」（权限点 internal_trade.ship）把「进行中」推进「在途」，并锁住发出公司批次的可用量；
        「撤销发货」（同为 internal_trade.ship）退回「进行中」并释放这笔在途占用，必须填原因。
        「到货确认」已接入（D31 / D68③）：仅「在途」可点，确认后批次在同一事务里转入接收公司、
        N 单置为已完成，不可撤销。
      </p>
    </section>
  );
}

/* ------------------------------ 撤销发货草稿 ------------------------------ */

/**
 * 撤销原因校验（与服务端契约一致：trim 后 1–200 字）。
 *
 * 抽成纯函数是刻意的：本仓 Web 测试不带 jsdom（`renderToStaticMarkup` 做静态断言），
 * 交互路径只能靠纯逻辑 + 静态渲染断言覆盖，不能再依赖原生 prompt 的效果。
 */
export function revokeReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed === '') return '撤销发货必须填写原因，本次未提交。';
  if (trimmed.length > 200) return '撤销原因不能超过 200 字，本次未提交。';
  return null;
}

/**
 * 「撤销发货」第一步：只打开原因输入区，**不发请求**；非「在途」时给状态原因。
 * 返回 `orderId` 表示要锁定哪张单的草稿，由页面写进 `revokingId`。
 */
export function openRevokeDispatch(
  order: InternalTradeOrderDetail,
): { readonly orderId: string } | { readonly error: string } {
  if (order.status !== '在途') {
    return { error: dispatchDisabledReason(order.status) ?? '只有「在途」能撤销发货' };
  }
  return { orderId: order.id };
}

/**
 * 「确认撤销」的提交入参：校验通过才把 trim 后的原因交给 mutation；
 * 返回 `error` 时页面只展示提示，不调接口。
 */
export function confirmRevokeDispatch(
  order: InternalTradeOrderDetail,
  reason: string,
):
  | { readonly input: { readonly order: InternalTradeOrderDetail; readonly reason: string } }
  | { readonly error: string } {
  const error = revokeReasonError(reason);
  if (error !== null) return { error };
  return { input: { order, reason: reason.trim() } };
}

/* ------------------------------ 页面 ------------------------------ */

export function InternalTradeOrdersPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me(), retry: false });
  /** 列表「经手人」列回显姓名，不再露 id 前 8 位（详情面板早就这么做了）。 */
  const employeeLabel = useEmployeeLabel();

  const [status, setStatus] = useState<'' | InternalTradeOrderStatus>('');
  /**
   * 看谁的（D106）。空串 = 不传参数，由服务端按权限定。
   *
   * 只在有 `internal_trade.read_all` 时给这个开关 —— 没权限的人拿到一个切不动的下拉框
   * 比没有更糟：他会以为「全部」里应该有别人的单，只是自己点不动。
   */
  const [scopeFilter, setScopeFilter] = useState<'' | 'mine' | 'all'>('');
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
  /** 撤销发货的原因草稿：点「撤销发货」只展开输入区，确认为空时不发请求。 */
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);

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
      scope: scopeFilter || undefined,
    }),
    [fromFilter, toFilter, status, keyword, cursors, pageIndex, scopeFilter],
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

  const receiveOrder = useMutation({
    mutationFn: (order: InternalTradeOrderDetail) =>
      internalTradesApi.receive(order.id, order.version),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['internal-trades'] });
    },
    /**
     * 到货确认撞版本冲突（别人刚改过 / 刚确认了这张单）：同步最新版本并说明，
     * 不自动重提——到货确认不可逆，让用户看清当前状态再点（D60）。
     */
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, internalTradesApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '到货确认失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '到货确认'));
      await queryClient.invalidateQueries({ queryKey: ['internal-trades'] });
    },
  });

  const dispatchOrder = useMutation({
    mutationFn: (order: InternalTradeOrderDetail) =>
      internalTradesApi.dispatch(order.id, order.version),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['internal-trades'] });
    },
    /**
     * 发货撞版本冲突（别人刚改过 / 刚发了货）：同步最新版本并说明，不自动重提——
     * 状态可能已经推进到「在途」，重复发货会被服务端拒（D60）。
     */
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, internalTradesApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '发货失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '发货'));
      await queryClient.invalidateQueries({ queryKey: ['internal-trades'] });
    },
  });

  const revokeDispatchOrder = useMutation({
    mutationFn: (input: { readonly order: InternalTradeOrderDetail; readonly reason: string }) =>
      internalTradesApi.dispatchRevoke(input.order.id, input.order.version, input.reason),
    onSuccess: async () => {
      setActionError(null);
      setRevokingId(null);
      setRevokeReason('');
      setRevokeError(null);
      await queryClient.invalidateQueries({ queryKey: ['internal-trades'] });
    },
    /**
     * 撤销发货撞版本冲突（别人刚改过 / 刚刚到货确认）：同步最新版本并说明，不自动重提——
     * 单子可能已经「已完成」，再撤销只会被服务端拒（D60）。
     */
    onError: async (error, input) => {
      const fresh = await recoverFromStaleVersion(error, input.order.id, internalTradesApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '撤销发货失败，请稍后重试'));
        return;
      }
      setActionError(null);
      // 状态可能已经变了：收起草稿，让用户看清最新状态后再点一次（与 staleActionRetryText 一致）。
      setRevokingId(null);
      setRevokeReason('');
      setRevokeError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '撤销发货'));
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

  const askReceive = (order: InternalTradeOrderDetail) => {
    // 仅「在途」能确认到货；其余状态即便因旧数据点到，也要把原因说出来。
    const reason = receiveDisabledReason(order.status);
    if (reason !== null) {
      setActionError(reason);
      return;
    }
    setActionError(null);
    if (
      globalThis.confirm?.(
        `确认到货后，批次将在同一事务内转入接收公司、N 单 ${order.orderNo} 置为已完成，不可撤销。确认继续吗？`,
      ) === false
    ) {
      return;
    }
    receiveOrder.mutate(order);
  };

  const askDispatch = (order: InternalTradeOrderDetail) => {
    // 只有「进行中」能发货；旧数据点到也要把原因说出来，别让按钮没反应。
    if (order.status !== '进行中') {
      setActionError(dispatchDisabledReason(order.status) ?? '只有「进行中」能发货');
      return;
    }
    setActionError(null);
    if (
      globalThis.confirm?.(
        `确认发货内部交易单 ${order.orderNo} 吗？发货后单据进入在途，批次在发出公司的可用量会被锁定，撤销发货才能释放。`,
      ) === false
    ) {
      return;
    }
    dispatchOrder.mutate(order);
  };

  const beginRevokeDispatch = (order: InternalTradeOrderDetail) => {
    const opened = openRevokeDispatch(order);
    if ('error' in opened) {
      setActionError(opened.error);
      return;
    }
    setActionError(null);
    setRevokeError(null);
    setRevokeReason('');
    setRevokingId(opened.orderId);
  };

  const submitRevokeDispatch = (order: InternalTradeOrderDetail) => {
    if (revokingId !== order.id) return;
    const confirmed = confirmRevokeDispatch(order, revokeReason);
    if ('error' in confirmed) {
      setRevokeError(confirmed.error);
      return;
    }
    setRevokeError(null);
    revokeDispatchOrder.mutate(confirmed.input);
  };

  const cancelRevokeDispatch = () => {
    setRevokingId(null);
    setRevokeReason('');
    setRevokeError(null);
  };

  const serverIssues = save.error instanceof ApiError ? extractIssues(save.error.details) : [];
  const rows = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  /** 列表四态（v0.13 `data-state`）：算一个字符串交给 DOM，渲染分支由 CSS 决定。 */
  const listState: ListState = resolveListState({
    isPending: list.isPending,
    hasError: list.error !== null,
    isEmpty: rows.length === 0,
  });
  const detailOrder = detail.data;
  const meData = me.data;

  return (
    <section className="page-body">
      <div className="p-head">
        <div>
          <div className="eyebrow">内部交易单 N · 公司间调拨</div>
          <h1>内部交易单 N</h1>
          <p className="sub">{PAGE_DESCRIPTION}</p>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={beginCreate}
            disabled={!can('create') || myCompanyIds.length === 0}
            className="btn btn-primary"
          >
            新建内部交易单
          </button>
        </div>
      </div>

      {meData && !can('create') ? (
        <p className="detail-why">
          「新建」需要 internal_trade.create；当前身份只能查看（判定在服务端，前端只是不画按钮）。
        </p>
      ) : null}
      {meData && !can('ship') ? (
        <p className="detail-why">
          「发货 / 撤销发货」需要 internal_trade.ship；当前身份不能发货（判定在服务端，前端只是不画按钮）。
        </p>
      ) : null}

      {/*
        工具条（v0.13 `.toolbar` + `.seg`）：四态用分段按钮，比下拉少一次展开——
        N 单最常看的是「在途」（货在路上、等对方确认），点一下就筛出来。
        发出 / 接收公司仍是下拉：选项多、变化少。
      */}
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
          {INTERNAL_TRADE_STATES.map((item) => (
            <button
              key={item}
              type="button"
              className={status === item ? 'on' : undefined}
              aria-pressed={status === item}
              title={INTERNAL_TRADE_STATE_HINT[item]}
              onClick={() => setStatus(item)}
            >
              {item}
            </button>
          ))}
        </div>
        {/*
          看谁的（D106）。只在有 `internal_trade.read_all` 时才给这个下拉 ——
          没权限的人看到一个切不动的框，会以为「全部」里该有别人的单。
        */}
        {can('read_all') && (
          <select
            value={scopeFilter}
            onChange={(event) => {
              setScopeFilter(event.target.value as '' | 'mine' | 'all');
              // 换「看谁的」等于换了一组数据，旧游标指向的位置在新集合里没有意义。
              setCursors([null]);
              setPageIndex(0);
            }}
            aria-label="看谁的单据"
            className="sel"
          >
            <option value="">默认（按我的权限）</option>
            <option value="mine">只看我经手的</option>
            <option value="all">全部</option>
          </select>
        )}
        <select
          value={fromFilter}
          onChange={(event) => setFromFilter(event.target.value)}
          aria-label="按发出公司筛选"
          className="sel"
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
          aria-label="按接收公司筛选"
          className="sel"
        >
          <option value="">全部接收公司</option>
          {companyOptions.map((company) => (
            <option key={company.id} value={company.id}>
              接收：{company.name}
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
        <span className="toolbar-end">
          「在途」= 货已锁走、对方还没确认到货（D68②）
        </span>
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

      {staleNotice ? <p className="alert alert-warn">{staleNotice}</p> : null}
      {save.error && serverIssues.length === 0 && !isStaleVersionError(save.error) ? (
        <p className="alert alert-bad">{errorText(save.error)}</p>
      ) : null}
      {actionError ? <p className="alert alert-bad">{actionError}</p> : null}

      {/*
        列表（v3.0 `list-card`）。四态交给容器与 tbody 的 `data-state` 驱动，**不写 JSX 三元分支**：
        `app-v013.css` 按 `tbody[data-state=…] > tr.st-tr.st-*` 显隐，状态切换时表头宽度不变。
        数据行只带 `r-row`（**不带 `st-tr`**：`st-tr` 是状态行专用，默认 `display:none` 且 `td{padding:0}`）。
      */}
      <div className="card list-card" data-state={listState}>
        <div className="tw">
          <table className="w-full min-w-[1120px] text-left">
            <thead>
              <tr>
                <th>单号</th>
                <th>发出 → 接收</th>
                <th>商品</th>
                <th className="num">数量</th>
                <th className="num">内部价</th>
                <th>状态</th>
                <th>经手人</th>
                <th>开单时间</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              {/* 三个状态行常驻：CSS 按 data-state 只显示其中一个，colSpan 必须等于表头列数 */}
              <tr className="st-tr st-loading">
                <td colSpan={9}>
                  <ListLoading label="正在加载内部交易单…" />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={9}>
                  <ListError
                    title="内部交易单加载失败"
                    error={list.error}
                    onRetry={() => void list.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={9}>
                  <ListEmpty title="暂无内部交易单。可调整筛选条件，或用右上角「新建内部交易单」开第一张。" />
                </td>
              </tr>
              {rows.map((order: InternalTradeOrder) => (
                <tr key={order.id} className="r-row">
                  <td className="whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setDetailId(order.id)}
                      className="doc-link"
                    >
                      {order.orderNo}
                    </button>
                  </td>
                  <td>{tradeRouteText(order)}</td>
                  <td className="max-w-[190px] cell-muted">
                    <ProductCell products={products.data?.items ?? []} lines={order.lines} />
                  </td>
                  <td className="num">{formatQty(totalLineQty(order.lines))}</td>
                  <td className="num">{formatMoney(order.internalPrice)}</td>
                  <td>
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="cell-muted">
                    {order.handlerId ? employeeLabel(order.handlerId) : '—'}
                  </td>
                  <td className="cell-muted">{formatShortDateTime(order.createdAt)}</td>
                  <td>
                    <div className="row-acts">
                      {/*
                        单号本身就是「进详情」的入口，行内不再单独放「详情」按钮：
                        多一个按钮就把「操作」列挤出卡片（同 E / C 页）。
                      */}
                      <button
                        type="button"
                        disabled={!can('update') || !canEdit(order.status)}
                        onClick={() => void withFreshDetail(order.id, beginEdit)}
                        className="btn btn-row"
                        title={canEdit(order.status) ? undefined : '只有「进行中」能改单（D68②）'}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={!can('delete') || !canEdit(order.status) || cancelOrder.isPending}
                        onClick={() => void withFreshDetail(order.id, askCancel)}
                        className="btn btn-row danger"
                      >
                        取消
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/*
          游标分页。游标契约（`PageQuerySchema`）只有 cursor/limit、没有 `total`，
          所以只能「上一批 / 下一批」，**不画页码**——画了就是假的总页数（D95 还没铺到本模块）。
          `.tf` 页脚在非 filled 态自动收起翻页，只留条数汇总。
        */}
        <div className="tf">
          <span>共 {rows.length} 条</span>
          {(pageIndex > 0 || nextCursor !== null) && (
            <BatchPager
              batch={pageIndex + 1}
              hasPrev={pageIndex > 0}
              hasNext={nextCursor !== null}
              onPrev={() => setPageIndex((index) => Math.max(0, index - 1))}
              onNext={() => {
                if (!nextCursor) return;
                setCursors((items) => [...items.slice(0, pageIndex + 1), nextCursor]);
                setPageIndex((index) => index + 1);
              }}
              label="内部交易单分批翻页"
            />
          )}
        </div>
      </div>

      <p className="note">
        四态：进行中 → 在途 → 已完成（或已取消，D68②）。只有「进行中」能改单；
        <b>发货（internal_trade.ship）</b>把单据推进「在途」并锁住发出公司批次的可用量，
        撤销发货才释放；<b>到货确认（D31）</b>确认后批次在同一事务转入接收公司、N 单置为已完成，不可撤销。
      </p>

      {detailId !== null ? (
        <>
          {detail.isPending ? <p className="alert alert-info">正在加载内部交易单详情…</p> : null}
          {detail.error ? <p className="alert alert-bad">{errorText(detail.error)}</p> : null}
          {detailOrder ? (
            <DetailPanel
              order={detailOrder}
              products={products.data?.items ?? []}
              batches={detailBatches.data?.items ?? []}
              canUpdate={can('update')}
              canCancel={can('delete')}
              canReceive={can('approve')}
              canShip={can('ship')}
              busy={cancelOrder.isPending}
              receiveBusy={receiveOrder.isPending}
              dispatchBusy={dispatchOrder.isPending}
              revokeBusy={revokeDispatchOrder.isPending}
              revoking={revokingId === detailOrder.id}
              revokeReason={revokeReason}
              revokeError={revokeError}
              onClose={() => setDetailId(null)}
              onEdit={() => beginEdit(detailOrder)}
              onCancel={() => askCancel(detailOrder)}
              onReceive={() => askReceive(detailOrder)}
              onDispatch={() => askDispatch(detailOrder)}
              onStartRevoke={() => beginRevokeDispatch(detailOrder)}
              onRevokeReasonChange={setRevokeReason}
              onSubmitRevoke={() => submitRevokeDispatch(detailOrder)}
              onCancelRevoke={cancelRevokeDispatch}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
