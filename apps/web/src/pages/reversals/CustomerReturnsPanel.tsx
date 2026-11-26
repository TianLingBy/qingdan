/**
 * R 客户退货分栏（`/reversals` 第一栏；D36 / D40 / D47）。
 *
 * 这一栏有两个动作：**登记** 与 **完成**（`customer_return.complete`，把进行中的单置为「已完成」）。
 * R 单没有改 / 删 / 取消端点（D47 冲正只追加），所以错账继续追加新单，不改历史；
 * 「完成」是审批动作（`customer_return.approve`）：`退货退款` 类型按批次入库并写库存流水，
 * `仅退款` 不动库存；然后置为「已完成」并 +version。
 *
 * 完成**不写任何账务**，这是 D40 定的口径而不是缺口：应收余额 = `SUM(sales_receipt.amount)`，
 * 退款靠人工在 E 单上追加一条负数收款行表达，改历史行是被 D40 明令禁止的。
 * 代价是 R 单完成后这张销售单的应收数字不变，得有人记得去补那一行——属于便利性缺口，
 * 不是数据正确性问题。
 *
 * 三个容易做错的地方，这里都按契约来：
 * - `退货退款` 必须填商品明细（有入库流水），`仅退款` 必须选 `纠收款 / 减成交额`；
 * - 应退金额是**正数**，实际退款由 E 单收款记录的负数行表达（D40），R 单不写 E 单费用；
 * - 录入还要求「老板 / 经理 / 财务」岗位（D47），前端不知道岗位，所以不预判，
 *   有 `create` 权限就给按钮，服务端拒绝时把它的原话显示出来。
 */

import type {
  CustomerReturn,
  CustomerReturnStatus,
  CustomerReturnType,
  InventoryBatch,
  OnlyRefundKind,
  RefundMode,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { formatMoney, formatQty, MASKED_AMOUNT, sumDecimal } from '../../lib/decimal';
import {
  ONLY_REFUND_KIND_HINT,
  ONLY_REFUND_KINDS,
  REFUND_MODE_HINT,
  REFUND_MODES,
  RETURN_STATUS_TONE,
  RETURN_TYPE_HINT,
  RETURN_TYPES,
  batchOptionLabel,
  batchLabelOf,
  idLabel,
  needsLines,
  productNameOf,
  returnLineAmount,
  returnLinesTotal,
  reversalsApi,
  reversalsQueryKeys,
  validateCustomerReturnDraft,
  type ReturnLineDraft,
} from './reversals-api';
import {
  BasisNote,
  ErrorBar,
  ErrorList,
  FIELD_CLASS,
  Field,
  ReversalListCard,
  TableSkeleton,
} from './reversals-ui';
import { BatchPager } from '../../components/ListPager';
import {
  DetailHead,
  DetailMetaDot,
  DocMeta,
  DocPill,
  LinesFooter,
} from '../../components/OrderDetailUI';
import { resolveListState } from '../../lib/list-state';

const EMPTY_LINE: ReturnLineDraft = { productId: '', batchIds: [], qty: '1', unitPrice: '' };

export interface CustomerReturnsPanelProps {
  readonly canCreate: boolean;
  readonly canApprove: boolean;
  /** D79：无看价权限时金额一律显示破折号，不用 0 顶替。 */
  readonly canViewPrice: boolean;
  readonly companyIds: readonly string[];
  readonly companyId: string;
  readonly onCompanyChange: (id: string) => void;
  /** 测试用：让详情区在首帧就打开，便于静态渲染断言「完成」按钮。 */
  readonly initialDetailId?: string | null;
}

export function CustomerReturnsPanel({
  canCreate,
  canApprove,
  canViewPrice,
  companyIds,
  companyId,
  onCompanyChange,
  initialDetailId = null,
}: CustomerReturnsPanelProps) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'' | CustomerReturnStatus>('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [originalSalesOrderId, setOriginalSalesOrderId] = useState('');
  const [returnType, setReturnType] = useState<CustomerReturnType>('退货退款');
  const [onlyRefundKind, setOnlyRefundKind] = useState<OnlyRefundKind | ''>('');
  const [refundMode, setRefundMode] = useState<RefundMode>('原路退款');
  const [refundAmount, setRefundAmount] = useState('');
  const [lines, setLines] = useState<ReturnLineDraft[]>([{ ...EMPTY_LINE }]);
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(initialDetailId);

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [companyId, status, keyword]);

  const filters = useMemo(
    () => ({
      companyId: companyId || undefined,
      status: status || undefined,
      keyword: keyword.trim() || undefined,
      cursor: cursors[pageIndex] ?? null,
    }),
    [companyId, status, keyword, cursors, pageIndex],
  );

  const list = useQuery({
    queryKey: reversalsQueryKeys.customerReturns(filters),
    queryFn: () => reversalsApi.listCustomerReturns(filters),
  });

  const detail = useQuery({
    queryKey: reversalsQueryKeys.customerReturn(detailId),
    queryFn: () => reversalsApi.customerReturnDetail(detailId!),
    enabled: detailId !== null,
  });

  // 原 E 单下拉：不能让人手填 UUID，也不能凭空知道单号。
  const salesOrders = useQuery({
    queryKey: reversalsQueryKeys.salesOrders(companyId),
    queryFn: () => reversalsApi.listSalesOrders(companyId || undefined),
    // 不只在开单时拉：列表与详情都要把 `原销售单` 显示成单号，
    // 否则表里只剩 id 前 8 位（`0la1ed74`），对人没有任何意义。
    enabled: true,
    staleTime: 5 * 60_000,
  });
  const batches = useQuery({
    queryKey: reversalsQueryKeys.batches(companyId),
    queryFn: () => reversalsApi.listBatches(companyId || undefined),
    // 不只在开单时拉：详情里的明细只有 batchId，要拿批次号才有意义。
    enabled: true,
  });
  const products = useQuery({
    queryKey: reversalsQueryKeys.products,
    queryFn: () => reversalsApi.listProducts(),
    // 同上：详情明细的 `商品` 列原来落在 id 前缀上，拉全量才能显示商品名。
    enabled: true,
    staleTime: 5 * 60_000,
  });

  const productOptions = products.data?.items ?? [];
  const batchOptions = batches.data?.items ?? [];
  const orderNoById = useMemo(() => {
    const map = new Map<string, string>();
    for (const order of salesOrders.data?.items ?? []) map.set(order.id, order.orderNo);
    return map;
  }, [salesOrders.data]);

  const create = useMutation({
    mutationFn: () =>
      reversalsApi.createCustomerReturn({
        companyId,
        originalSalesOrderId,
        originalSettlementOrderId: null,
        returnType,
        refundMode,
        onlyRefundKind: returnType === '仅退款' ? onlyRefundKind || null : null,
        lines: needsLines(returnType)
          ? lines.map((line) => ({
              productId: line.productId,
              batchIds: line.batchIds,
              qty: line.qty.trim(),
              unitPrice: line.unitPrice.trim(),
              amount: returnLineAmount(line),
            }))
          : [],
        refundAmount: refundAmount.trim(),
      }),
    onSuccess: () => {
      setFormOpen(false);
      setOriginalSalesOrderId('');
      setRefundAmount('');
      setLines([{ ...EMPTY_LINE }]);
      setOnlyRefundKind('');
      setClientErrors([]);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['reversals', 'customer'] });
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : '登记失败，请稍后重试');
    },
  });

  const submit = () => {
    setActionError(null);
    const errors = validateCustomerReturnDraft({
      companyId,
      originalSalesOrderId,
      returnType,
      onlyRefundKind,
      refundAmount,
      lines,
    });
    setClientErrors(errors);
    if (errors.length > 0) return;
    create.mutate();
  };

  const complete = useMutation({
    mutationFn: (row: CustomerReturn) => reversalsApi.customerReturnComplete(row.id, row.version),
    onSuccess: () => {
      // 完成后状态变「已完成」：列表与详情一起刷新。
      void queryClient.invalidateQueries({ queryKey: ['reversals', 'customer'] });
      setActionError(null);
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : '完成失败，请稍后重试');
    },
  });

  const askComplete = (row: CustomerReturn) => {
    /** 详情里的状态可能是旧的（别人刚完成/取消），别静默失败。 */
    if (row.status !== '进行中') {
      setActionError(`这张单当前是「${row.status}」，不能再完成；请刷新列表查看最新状态。`);
      return;
    }
    setActionError(null);
    if (
      globalThis.confirm?.(`确认完成客户退货 ${row.returnNo} 吗？完成后状态变为「已完成」，不可撤销。`) === false
    ) {
      return;
    }
    complete.mutate(row);
  };

  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  const linesTotal = returnLinesTotal(lines);
  const listState = resolveListState({
    isPending: list.isPending,
    hasError: list.isError,
    isEmpty: items.length === 0,
  });

  return (
    <div className="panel-stack">
      <BasisNote>
        R 单挂原销售单，两型：<b>退货退款</b>（货退回库、要商品明细）/ <b>仅退款</b>
        （只退钱，要选纠收款或减成交额）。退款只走 E 单收款记录的负数行（D40），
        R 单本身不改 E 单。冲正单据只追加，不可改、不可删（D47）。
      </BasisNote>

      {/* 筛选条走 v3.0 `.toolbar`：控件直接摆在一条线上，标签交给 `aria-label`，
          和销售 E / 采购 A 的筛选条同一套版式（下拉带无标签时不能省 aria-label）。 */}
      <div className="toolbar">
        {companyIds.length > 1 ? (
          <select
            value={companyId}
            onChange={(event) => onCompanyChange(event.target.value)}
            aria-label="按公司筛选"
            className="sel"
          >
            {companyIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : null}
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as '' | CustomerReturnStatus)}
          aria-label="按状态筛选"
          className="sel"
        >
          <option value="">全部状态</option>
          <option value="进行中">进行中</option>
          <option value="已完成">已完成</option>
          <option value="已取消">已取消</option>
        </select>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索单号 R-0001-…"
          aria-label="搜索单号"
          className="search"
        />
        <button
          type="button"
          onClick={() => {
            setFormOpen((open) => !open);
            setActionError(null);
          }}
          disabled={!canCreate || companyId.length === 0}
          title={canCreate ? undefined : '当前身份没有 customer_return.create 权限'}
          className="btn btn-primary act-end"
        >
          {formOpen ? '收起开单' : '登记客户退货'}
        </button>
      </div>

      {formOpen ? (
        <section className="form-card">
          <div className="form-head">
            <h2>登记客户退货</h2>
            <span className="detail-why">
              录入岗位由服务端校验（D47：老板 / 经理 / 财务）
            </span>
          </div>

          <div className="fm">
            <Field label="原销售单" hint="R 单必须挂原 E 单；下拉取本公司前 200 张">
              <select
                value={originalSalesOrderId}
                onChange={(event) => setOriginalSalesOrderId(event.target.value)}
                className={FIELD_CLASS}
              >
                <option value="">请选择原销售单</option>
                {(salesOrders.data?.items ?? []).map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.orderNo} · {order.customerName}（{order.status}）
                  </option>
                ))}
              </select>
            </Field>

            <Field label="退货类型" hint={RETURN_TYPE_HINT[returnType]}>
              <select
                value={returnType}
                onChange={(event) => {
                  const next = event.target.value as CustomerReturnType;
                  setReturnType(next);
                  if (!needsLines(next)) setLines([]);
                  else if (lines.length === 0) setLines([{ ...EMPTY_LINE }]);
                }}
                className={FIELD_CLASS}
              >
                {RETURN_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </Field>

            {returnType === '仅退款' ? (
              <Field label="仅退款类型" hint={onlyRefundKind ? ONLY_REFUND_KIND_HINT[onlyRefundKind] : undefined}>
                <select
                  value={onlyRefundKind}
                  onChange={(event) => setOnlyRefundKind(event.target.value as OnlyRefundKind | '')}
                  className={FIELD_CLASS}
                >
                  <option value="">请选择</option>
                  {ONLY_REFUND_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <Field label="退款方式" hint={REFUND_MODE_HINT[refundMode]}>
              <select
                value={refundMode}
                onChange={(event) => setRefundMode(event.target.value as RefundMode)}
                className={FIELD_CLASS}
              >
                {REFUND_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="应退金额" hint="正数；实际退款由收款记录负数行表达（D40）">
              <input
                value={refundAmount}
                onChange={(event) => setRefundAmount(event.target.value)}
                inputMode="decimal"
                placeholder="如 286.00"
                className={FIELD_CLASS}
              />
            </Field>
          </div>

          {needsLines(returnType) ? (
            <div className="form-stack">
              <div className="form-head">
                <h3 className="form-title">退回商品（至少 1 行）</h3>
                <span className="detail-why">
                  一行可引多个本公司批次（D22）；明细合计 {formatMoney(canViewPrice ? linesTotal : null)}
                </span>
              </div>

              {lines.map((line, index) => {
                const rowBatches = batchOptions.filter(
                  (batch) => !line.productId || batch.productId === line.productId,
                );
                return (
                  <div key={index} className="line-card">
                    <div className="fm lines">
                      <Field label={`第 ${index + 1} 行商品`}>
                        <select
                          value={line.productId}
                          onChange={(event) => {
                            const productId = event.target.value;
                            setLines((current) =>
                              current.map((item, i) =>
                                i === index ? { ...item, productId, batchIds: [] } : item,
                              ),
                            );
                          }}
                          className={FIELD_CLASS}
                        >
                          <option value="">请选择商品</option>
                          {productOptions.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="数量">
                        <input
                          value={line.qty}
                          onChange={(event) =>
                            setLines((current) =>
                              current.map((item, i) => (i === index ? { ...item, qty: event.target.value } : item)),
                            )
                          }
                          inputMode="decimal"
                          className={FIELD_CLASS}
                        />
                      </Field>
                      <Field label="单价">
                        <input
                          value={line.unitPrice}
                          onChange={(event) =>
                            setLines((current) =>
                              current.map((item, i) =>
                                i === index ? { ...item, unitPrice: event.target.value } : item,
                              ),
                            )
                          }
                          inputMode="decimal"
                          className={FIELD_CLASS}
                        />
                      </Field>
                      <div className="line-amount">
                        金额 {formatMoney(canViewPrice ? returnLineAmount(line) : null)}
                      </div>
                      <button
                        type="button"
                        onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                        disabled={lines.length <= 1}
                        className="btn btn-row"
                      >
                        删除
                      </button>
                    </div>

                    <div className="line-batches">
                      <span>引用批次（至少 1 个）</span>
                      <div className="chip-row">
                        {!line.productId ? (
                          <span className="chip-none">先选商品，再选批次</span>
                        ) : rowBatches.length === 0 ? (
                          <span className="chip-none">本公司该商品暂无批次</span>
                        ) : (
                          rowBatches.map((batch: InventoryBatch) => {
                            const checked = line.batchIds.includes(batch.id);
                            return (
                              <button
                                key={batch.id}
                                type="button"
                                onClick={() =>
                                  setLines((current) =>
                                    current.map((item, i) =>
                                      i === index
                                        ? {
                                            ...item,
                                            batchIds: checked
                                              ? item.batchIds.filter((id) => id !== batch.id)
                                              : [...item.batchIds, batch.id],
                                          }
                                        : item,
                                    ),
                                  )
                                }
                                className={checked ? 'chip on' : 'chip'}
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
                onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}
                className="btn form-add"
              >
                + 加一行商品
              </button>
            </div>
          ) : null}

          <ErrorList errors={clientErrors} />
          {actionError ? <ErrorBar message={actionError} /> : null}

          <div className="detail-acts">
            <button
              type="button"
              onClick={submit}
              disabled={create.isPending}
              className="btn btn-primary"
            >
              {create.isPending ? '提交中…' : '登记退货'}
            </button>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                setClientErrors([]);
                setActionError(null);
              }}
              className="btn"
            >
              取消
            </button>
          </div>
        </section>
      ) : null}

      <ReversalListCard
        state={listState}
        colCount={6}
        minWidthClass="min-w-[680px]"
        head={
          <tr>
            <th>单号</th>
            <th>原销售单</th>
            <th>类型</th>
            <th className="num">应退金额</th>
            <th>状态</th>
            {/* 表头跟着按钮走右对齐：`text-right` 是布局类（不在 #431 那条「不许出现」的清单里），
                其余页面用的是空表头 `<th />`，这里要写「操作」两个字，就得自己对齐。 */}
            <th className="text-right">操作</th>
          </tr>
        }
        emptyText="还没有客户退货单"
        emptyHint="退货发生在销售之后：先在销售单里找出原单，再来这里登记冲正。"
        errorTitle="客户退货单加载失败"
        error={list.error}
        onRetry={() => void list.refetch()}
        summary={`共 ${items.length} 条${canViewPrice ? '' : ' · 当前身份无看价权限，金额显示 —'}`}
        pager={
          <BatchPager
            batch={pageIndex + 1}
            hasPrev={pageIndex > 0}
            hasNext={nextCursor !== null}
            onPrev={() => setPageIndex((index) => Math.max(0, index - 1))}
            onNext={() => {
              if (nextCursor === null) return;
              setCursors((current) => {
                const next = current.slice(0, pageIndex + 1);
                next[pageIndex + 1] = nextCursor;
                return next;
              });
              setPageIndex((index) => index + 1);
            }}
            label="客户退货单分批翻页"
          />
        }
      >
        {items.map((item: CustomerReturn) => (
          <tr key={item.id} className="r-row">
            <td>
              <button
                type="button"
                onClick={() => setDetailId(item.id)}
                className="doc-link"
              >
                {item.returnNo}
              </button>
            </td>
            <td className="mono cell-muted">
              {orderNoById.get(item.originalSalesOrderId) ?? idLabel(item.originalSalesOrderId)}
            </td>
            <td>
              {item.returnType}
              {item.onlyRefundKind ? ` · ${item.onlyRefundKind}` : ''}
            </td>
            <td className="num">
              {canViewPrice ? formatMoney(item.refundAmount) : MASKED_AMOUNT}
            </td>
            <td>
              <DocPill label={item.status} tone={RETURN_STATUS_TONE[item.status] ?? 'cancel'} />
            </td>
            <td>
              <div className="row-acts">
                <button type="button" onClick={() => setDetailId(item.id)} className="btn btn-row">
                  详情
                </button>
              </div>
            </td>
          </tr>
        ))}
      </ReversalListCard>

      {detailId !== null ? (
        <section className="card detail">
          {detail.isError ? (
            <ErrorBar message="详情加载失败" onRetry={() => void detail.refetch()} />
          ) : detail.isPending || !detail.data ? (
            <TableSkeleton rows={2} />
          ) : (
            <>
              <DetailHead
                docLabel="客户退货单"
                orderNo={detail.data.returnNo}
                pill={
                  <DocPill
                    label={detail.data.status}
                    tone={RETURN_STATUS_TONE[detail.data.status] ?? 'cancel'}
                  />
                }
                meta={
                  <>
                    <span>{detail.data.returnType}</span>
                    {detail.data.onlyRefundKind ? (
                      <>
                        <DetailMetaDot />
                        <span>{detail.data.onlyRefundKind}</span>
                      </>
                    ) : null}
                    <DetailMetaDot />
                    <span>退款方式 {detail.data.refundMode}</span>
                    <DetailMetaDot />
                    <span>
                      原销售单{' '}
                      {orderNoById.get(detail.data.originalSalesOrderId) ??
                        idLabel(detail.data.originalSalesOrderId)}
                    </span>
                  </>
                }
                actions={
                  <button
                    type="button"
                    onClick={() => askComplete(detail.data!)}
                    disabled={!canApprove || detail.data.status !== '进行中' || complete.isPending}
                    title={
                      !canApprove
                        ? '当前身份没有 customer_return.approve 权限'
                        : detail.data.status !== '进行中'
                          ? '仅「进行中」状态的单据可完成'
                          : undefined
                    }
                    className="btn btn-p"
                  >
                    {complete.isPending ? '完成中…' : '完成'}
                  </button>
                }
                onClose={() => setDetailId(null)}
              />

              <DocMeta
                columns={3}
                items={[
                  {
                    label: '原销售单',
                    mono: true,
                    value:
                      orderNoById.get(detail.data.originalSalesOrderId) ??
                      idLabel(detail.data.originalSalesOrderId),
                  },
                  {
                    label: '原结算单',
                    mono: true,
                    tone: detail.data.originalSettlementOrderId ? undefined : 'dim',
                    value: idLabel(detail.data.originalSettlementOrderId),
                  },
                  {
                    label: '退货类型',
                    value: `${detail.data.returnType}${
                      detail.data.onlyRefundKind ? ` · ${detail.data.onlyRefundKind}` : ''
                    }`,
                  },
                  { label: '退款方式', value: detail.data.refundMode },
                  {
                    label: '应退金额',
                    mono: true,
                    tone: 'money',
                    value: canViewPrice
                      ? formatMoney(detail.data.refundAmount)
                      : MASKED_AMOUNT,
                  },
                  {
                    label: '备注',
                    tone: detail.data.remark ? undefined : 'dim',
                    value: detail.data.remark ?? '—',
                  },
                ]}
              />

              {detail.data.lines.length === 0 ? (
                <p className="alert alert-info alert-sm">
                  仅退款单没有实物流水，所以没有商品明细（F4）。
                </p>
              ) : (
                <div className="ln">
                  <table>
                    <thead>
                      <tr>
                        <th>商品</th>
                        <th>批次</th>
                        <th className="num">数量</th>
                        <th className="num">单价</th>
                        <th className="num">金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.lines.map((line, index) => (
                        <tr key={`${line.productId}-${index}`}>
                          <td>{productNameOf(productOptions, line.productId)}</td>
                          <td className="mono cell-muted">
                            {line.batchIds.map((id) => batchLabelOf(batchOptions, id)).join(' / ')}
                          </td>
                          <td className="num">{formatQty(line.qty)}</td>
                          <td className="num">
                            {canViewPrice ? formatMoney(line.unitPrice) : MASKED_AMOUNT}
                          </td>
                          <td className="num">
                            {canViewPrice ? formatMoney(line.amount) : MASKED_AMOUNT}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <LinesFooter
                      colSpan={4}
                      note={`共 ${detail.data.lines.length} 行 · 数量不跨行合计（单位可能不同）`}
                      sum={
                        canViewPrice
                          ? formatMoney(sumDecimal(detail.data.lines.map((line) => line.amount)))
                          : MASKED_AMOUNT
                      }
                    />
                  </table>
                </div>
              )}

              {actionError ? <ErrorBar message={actionError} /> : null}

              <p className="detail-why">
                完成即审批：退货退款类型会按批次入库并写库存流水，然后置为「已完成」；仅退款类型不动库存。
                冲正单据只追加，不可改、不可删（D47）。完成本身不写账（D40）：实际退款请回原销售单追加负数收款行，
                应收余额才会跟着变。
              </p>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
