/**
 * S 供应商退货分栏（`/reversals` 第二栏；F4c / D47）。
 *
 * S 单**只有一种形态：退钱**。契约里没有 `returnType` / `refundMode` / `onlyRefundKind`
 * ——现实里不存在「抵下次货款」「换货补发」，所以这里也不给这三个下拉。
 * 加一个「抵货款」选项看起来更"完整"，但那是凭空造业务。
 *
 * 和 R 一样，只追加：没有改 / 删 / 取消端点（D47）。多一个「完成」动作
 * （`supplier_return.complete`，审批动作 `supplier_return.approve`）：按批次出库并写库存流水，
 * 然后置为「已完成」。应付冲减尚未接入（见 #211），不是改单。
 */

import type { SupplierReturn, SupplierReturnStatus } from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { formatMoney, formatQty, MASKED_AMOUNT, sumDecimal } from '../../lib/decimal';
import {
  RETURN_STATUS_TONE,
  batchOptionLabel,
  batchLabelOf,
  idLabel,
  productNameOf,
  returnLineAmount,
  returnLinesTotal,
  reversalsApi,
  reversalsQueryKeys,
  validateSupplierReturnDraft,
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

export interface SupplierReturnsPanelProps {
  readonly canCreate: boolean;
  readonly canApprove: boolean;
  readonly canViewPrice: boolean;
  readonly companyIds: readonly string[];
  readonly companyId: string;
  readonly onCompanyChange: (id: string) => void;
  /** `supplier_return.delete`：只有它能取消 S 单（S 是三类冲正里唯一能取消的）。 */
  readonly canCancel?: boolean;
  /** 测试用：让详情区在首帧就打开，便于静态渲染断言「完成」按钮。 */
  readonly initialDetailId?: string | null;
}

export function SupplierReturnsPanel({
  canCreate,
  canApprove,
  canViewPrice,
  companyIds,
  companyId,
  onCompanyChange,
  canCancel = false,
  initialDetailId = null,
}: SupplierReturnsPanelProps) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'' | SupplierReturnStatus>('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [originalPurchaseOrderId, setOriginalPurchaseOrderId] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [lines, setLines] = useState<ReturnLineDraft[]>([{ ...EMPTY_LINE }]);
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(initialDetailId);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

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
    queryKey: reversalsQueryKeys.supplierReturns(filters),
    queryFn: () => reversalsApi.listSupplierReturns(filters),
  });

  const detail = useQuery({
    queryKey: reversalsQueryKeys.supplierReturn(detailId),
    queryFn: () => reversalsApi.supplierReturnDetail(detailId!),
    enabled: detailId !== null,
  });

  const purchaseOrders = useQuery({
    queryKey: reversalsQueryKeys.purchaseOrders(companyId),
    queryFn: () => reversalsApi.listPurchaseOrders(companyId || undefined),
    // 列表与详情都要把「原采购单」显示成单号，不能只在开单时才拉（否则只剩 id 前 8 位）。
    enabled: true,
    staleTime: 5 * 60_000,
  });
  const batches = useQuery({
    queryKey: reversalsQueryKeys.batches(companyId),
    queryFn: () => reversalsApi.listBatches(companyId || undefined),
    // 不只在开单时拉：详情明细只有 batchIds，要换成批次号给人看。
    enabled: true,
  });
  const products = useQuery({
    queryKey: reversalsQueryKeys.products,
    queryFn: () => reversalsApi.listProducts(),
    // 同上：明细的「商品」列要靠它显示商品名而不是 id 前缀。
    enabled: true,
    staleTime: 5 * 60_000,
  });

  const productOptions = products.data?.items ?? [];
  const batchOptions = batches.data?.items ?? [];
  const orderNoById = useMemo(() => {
    const map = new Map<string, string>();
    for (const order of purchaseOrders.data?.items ?? []) map.set(order.id, order.orderNo);
    return map;
  }, [purchaseOrders.data]);

  const create = useMutation({
    mutationFn: () =>
      reversalsApi.createSupplierReturn({
        companyId,
        originalPurchaseOrderId,
        lines: lines.map((line) => ({
          productId: line.productId,
          batchIds: line.batchIds,
          qty: line.qty.trim(),
          unitPrice: line.unitPrice.trim(),
          amount: returnLineAmount(line),
        })),
        refundAmount: refundAmount.trim(),
      }),
    onSuccess: () => {
      setFormOpen(false);
      setOriginalPurchaseOrderId('');
      setRefundAmount('');
      setLines([{ ...EMPTY_LINE }]);
      setClientErrors([]);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['reversals', 'supplier'] });
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : '登记失败，请稍后重试');
    },
  });

  const submit = () => {
    setActionError(null);
    const errors = validateSupplierReturnDraft({
      companyId,
      originalPurchaseOrderId,
      refundAmount,
      lines,
    });
    setClientErrors(errors);
    if (errors.length > 0) return;
    create.mutate();
  };

  const complete = useMutation({
    mutationFn: (row: SupplierReturn) => reversalsApi.supplierReturnComplete(row.id, row.version),
    onSuccess: () => {
      // 完成后状态变「已完成」：列表与详情一起刷新。
      void queryClient.invalidateQueries({ queryKey: ['reversals', 'supplier'] });
      setActionError(null);
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : '完成失败，请稍后重试');
    },
  });

  /**
   * 取消进行中的 S 单（`supplier_return.cancel`）。
   *
   * 三类冲正里**只有 S 能取消**：R 单一旦生成就得走完、I 单只有审批。
   * 原因必填——服务端用 `auditReason` 记审计，且它会写进 `X-Reason` 头。
   */
  const cancel = useMutation({
    mutationFn: (row: SupplierReturn) =>
      reversalsApi.supplierReturnCancel(row.id, row.version, cancelReason.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reversals', 'supplier'] });
      setCancelOpen(false);
      setCancelReason('');
      setActionError(null);
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : '取消失败，请稍后重试');
    },
  });

  const submitCancel = (row: SupplierReturn) => {
    const reason = cancelReason.trim();
    if (reason.length === 0) {
      setActionError('取消必须填原因（1–200 字），它会记进审计。');
      return;
    }
    if (reason.length > 200) {
      setActionError('取消原因最多 200 字。');
      return;
    }
    cancel.mutate(row);
  };

  const askComplete = (row: SupplierReturn) => {
    /** 详情里的状态可能是旧的（别人刚完成/取消），别静默失败。 */
    if (row.status !== '进行中') {
      setActionError(`这张单当前是「${row.status}」，不能再完成；请刷新列表查看最新状态。`);
      return;
    }
    setActionError(null);
    if (
      globalThis.confirm?.(`确认完成供应商退货 ${row.returnNo} 吗？完成后状态变为「已完成」，不可撤销。`) ===
      false
    ) {
      return;
    }
    complete.mutate(row);
  };

  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  const listState = resolveListState({
    isPending: list.isPending,
    hasError: list.isError,
    isEmpty: items.length === 0,
  });

  return (
    <div className="panel-stack">
      <BasisNote>
        S 单只做<b>退钱</b>：冲减应付 / 收退款记录。没有「抵下次货款」，也没有「换货补发」
        ——这两种形态现实里不发生，所以契约里连类型字段都没有（F4c）。
        同样只追加，不可改、不可删（D47）。
      </BasisNote>

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
          onChange={(event) => setStatus(event.target.value as '' | SupplierReturnStatus)}
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
          placeholder="搜索单号 S-0001-…"
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
          title={canCreate ? undefined : '当前身份没有 supplier_return.create 权限'}
          className="btn btn-primary act-end"
        >
          {formOpen ? '收起开单' : '登记供应商退货'}
        </button>
      </div>

      {formOpen ? (
        <section className="form-card">
          <div className="form-head">
            <h2>登记供应商退货</h2>
          </div>

          <div className="fm">
            <Field label="原采购单" hint="S 单必须挂原 A 单；下拉取本公司前 200 张">
              <select
                value={originalPurchaseOrderId}
                onChange={(event) => setOriginalPurchaseOrderId(event.target.value)}
                className={FIELD_CLASS}
              >
                <option value="">请选择原采购单</option>
                {(purchaseOrders.data?.items ?? []).map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.orderNo} · {order.supplierName}（{order.status}）
                  </option>
                ))}
              </select>
            </Field>
            <Field label="应退金额" hint="正数；冲减应付或收退款记录（F4c）">
              <input
                value={refundAmount}
                onChange={(event) => setRefundAmount(event.target.value)}
                inputMode="decimal"
                placeholder="如 1200.00"
                className={FIELD_CLASS}
              />
            </Field>
          </div>

          <div className="form-stack">
            <div className="form-head">
              <h3 className="form-title">退回商品（至少 1 行）</h3>
              <span className="detail-why">
                明细合计 {formatMoney(canViewPrice ? returnLinesTotal(lines) : null)}
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
                        rowBatches.map((batch) => {
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
        colCount={5}
        minWidthClass="min-w-[620px]"
        head={
          <tr>
            <th>单号</th>
            <th>原采购单</th>
            <th className="num">应退金额</th>
            <th>状态</th>
            <th className="text-right">操作</th>
          </tr>
        }
        emptyText="还没有供应商退货单"
        emptyHint="先从采购单里找出原单，再来这里登记冲正；S 单只处理退钱，不动库存。"
        errorTitle="供应商退货单加载失败"
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
            label="供应商退货单分批翻页"
          />
        }
      >
        {items.map((item: SupplierReturn) => (
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
              {orderNoById.get(item.originalPurchaseOrderId) ??
                idLabel(item.originalPurchaseOrderId)}
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
                docLabel="供应商退货单"
                orderNo={detail.data.returnNo}
                pill={
                  <DocPill
                    label={detail.data.status}
                    tone={RETURN_STATUS_TONE[detail.data.status] ?? 'cancel'}
                  />
                }
                meta={
                  <>
                    <span>只退钱，不动库存（F4c）</span>
                    <DetailMetaDot />
                    <span>
                      原采购单{' '}
                      {orderNoById.get(detail.data.originalPurchaseOrderId) ??
                        idLabel(detail.data.originalPurchaseOrderId)}
                    </span>
                  </>
                }
                actions={
                  <>
                    {canCancel && detail.data.status === '进行中' ? (
                      <button
                        type="button"
                        onClick={() => {
                          setCancelOpen((open) => !open);
                          setActionError(null);
                        }}
                        className="btn"
                      >
                        {cancelOpen ? '收起取消' : '取消单据'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => askComplete(detail.data!)}
                      disabled={
                        !canApprove || detail.data.status !== '进行中' || complete.isPending
                      }
                      title={
                        !canApprove
                          ? '当前身份没有 supplier_return.approve 权限'
                          : detail.data.status !== '进行中'
                            ? '仅「进行中」状态的单据可完成'
                            : undefined
                      }
                      className="btn btn-p"
                    >
                      {complete.isPending ? '完成中…' : '完成'}
                    </button>
                  </>
                }
                onClose={() => setDetailId(null)}
              />

              <DocMeta
                columns={3}
                items={[
                  {
                    label: '原采购单',
                    mono: true,
                    value:
                      orderNoById.get(detail.data.originalPurchaseOrderId) ??
                      idLabel(detail.data.originalPurchaseOrderId),
                  },
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

              {actionError ? <ErrorBar message={actionError} /> : null}

              {cancelOpen && detail.data.status === '进行中' ? (
                <div className="alert alert-bad">
                  <h4>取消这张供应商退货单</h4>
                  <p>
                    取消会把单据置为「已取消」并释放待执行的库存占用；只是留档，不物理删除（D47），不可撤销。
                  </p>
                  <div className="detail-acts">
                    <label className="reason-field">
                      <span>取消原因（必填，1–200 字）</span>
                      <input
                        value={cancelReason}
                        onChange={(event) => setCancelReason(event.target.value)}
                        maxLength={200}
                        placeholder="例如：供应商确认不退货，改走补货"
                        className="ipt"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={cancel.isPending}
                      onClick={() => submitCancel(detail.data!)}
                      className="btn btn-p"
                    >
                      {cancel.isPending ? '取消中…' : '确认取消'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCancelOpen(false);
                        setCancelReason('');
                      }}
                      className="btn btn-ghost"
                    >
                      放弃
                    </button>
                  </div>
                </div>
              ) : null}

              <p className="detail-why">
                完成即审批：会按批次出库并写库存流水，然后置为「已完成」；应付冲减尚未接入（见 #211）。
                冲正单据只追加，不可改、不可删（D47）。
              </p>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
