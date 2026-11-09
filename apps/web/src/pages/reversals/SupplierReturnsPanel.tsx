/**
 * S 供应商退货分栏（`/reversals` 第二栏；F4c / D47）。
 *
 * S 单**只有一种形态：退钱**。契约里没有 `returnType` / `refundMode` / `onlyRefundKind`
 * ——现实里不存在「抵下次货款」「换货补发」，所以这里也不给这三个下拉。
 * 加一个「抵货款」选项看起来更"完整"，但那是凭空造业务。
 *
 * 和 R 一样，只追加：没有改 / 删 / 完成端点（D47）。
 */

import type { SupplierReturn, SupplierReturnStatus } from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { formatMoney, formatQty, MASKED_AMOUNT } from '../../lib/decimal';
import {
  RETURN_STATUS_CLASS,
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
  EmptyState,
  ErrorBar,
  ErrorList,
  FIELD_CLASS,
  Field,
  Kv,
  StatusPill,
  TableSkeleton,
} from './reversals-ui';

const EMPTY_LINE: ReturnLineDraft = { productId: '', batchIds: [], qty: '1', unitPrice: '' };

export interface SupplierReturnsPanelProps {
  readonly canCreate: boolean;
  readonly canViewPrice: boolean;
  readonly companyIds: readonly string[];
  readonly companyId: string;
  readonly onCompanyChange: (id: string) => void;
}

export function SupplierReturnsPanel({
  canCreate,
  canViewPrice,
  companyIds,
  companyId,
  onCompanyChange,
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
  const [detailId, setDetailId] = useState<string | null>(null);

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
    enabled: formOpen,
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
    enabled: formOpen,
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

  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;

  return (
    <div className="space-y-3">
      <BasisNote>
        S 单只做<b>退钱</b>：冲减应付 / 收退款记录。没有「抵下次货款」，也没有「换货补发」
        ——这两种形态现实里不发生，所以契约里连类型字段都没有（F4c）。
        同样只追加，不可改、不可删（D47）。
      </BasisNote>

      <div className="flex flex-wrap items-end gap-3">
        {companyIds.length > 1 ? (
          <Field label="公司" className="min-w-[180px]">
            <select value={companyId} onChange={(event) => onCompanyChange(event.target.value)} className={FIELD_CLASS}>
              {companyIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="状态" className="min-w-[120px]">
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as '' | SupplierReturnStatus)}
            className={FIELD_CLASS}
          >
            <option value="">全部</option>
            <option value="进行中">进行中</option>
            <option value="已完成">已完成</option>
            <option value="已取消">已取消</option>
          </select>
        </Field>
        <Field label="单号关键字" className="min-w-[180px]">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="S-0001-…"
            className={FIELD_CLASS}
          />
        </Field>
        <button
          type="button"
          onClick={() => {
            setFormOpen((open) => !open);
            setActionError(null);
          }}
          disabled={!canCreate || companyId.length === 0}
          title={canCreate ? undefined : '当前身份没有 supplier_return.create 权限'}
          className="mb-0.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
        >
          {formOpen ? '收起开单' : '登记供应商退货'}
        </button>
      </div>

      {formOpen ? (
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">登记供应商退货</h3>

          <div className="grid gap-3 sm:grid-cols-2">
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

          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold text-slate-700">退回商品（至少 1 行）</h4>
              <span className="text-[11px] text-slate-400">
                明细合计 {formatMoney(canViewPrice ? returnLinesTotal(lines) : null)}
              </span>
            </div>

            {lines.map((line, index) => {
              const rowBatches = batchOptions.filter(
                (batch) => !line.productId || batch.productId === line.productId,
              );
              return (
                <div key={index} className="rounded-lg border border-slate-200 p-3">
                  <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto_auto]">
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
                    <div className="self-end pb-2 text-xs text-slate-500">
                      金额 {formatMoney(canViewPrice ? returnLineAmount(line) : null)}
                    </div>
                    <button
                      type="button"
                      onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                      disabled={lines.length <= 1}
                      className="mt-5 h-9 self-start whitespace-nowrap rounded-lg border border-slate-300 px-2 text-xs text-slate-600 disabled:opacity-40"
                    >
                      删除
                    </button>
                  </div>

                  <div className="mt-2">
                    <span className="text-[11px] text-slate-500">引用批次（至少 1 个）</span>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {!line.productId ? (
                        <span className="text-[11px] text-slate-400">先选商品，再选批次</span>
                      ) : rowBatches.length === 0 ? (
                        <span className="text-[11px] text-slate-400">本公司该商品暂无批次</span>
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
              onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600"
            >
              + 加一行商品
            </button>
          </div>

          <ErrorList errors={clientErrors} />
          {actionError ? <ErrorBar message={actionError} /> : null}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={create.isPending}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
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
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600"
            >
              取消
            </button>
          </div>
        </section>
      ) : null}

      <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">供应商退货单</h3>
          <span className="text-xs text-slate-400">
            共 {items.length} 条{canViewPrice ? '' : ' · 当前身份无看价权限，金额显示 —'}
          </span>
        </div>

        {list.isError ? (
          <div className="mt-3">
            <ErrorBar message="列表加载失败" onRetry={() => void list.refetch()} />
          </div>
        ) : list.isPending ? (
          <TableSkeleton />
        ) : items.length === 0 ? (
          <EmptyState
            title="还没有供应商退货单"
            hint="先从采购单里找出原单，再来这里登记冲正；S 单只处理退钱，不动库存。"
          />
        ) : (
          <div className="mt-3 -mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead>
                <tr className="text-xs text-slate-400">
                  <th className="py-1.5 pr-3 font-medium">单号</th>
                  <th className="py-1.5 pr-3 font-medium">原采购单</th>
                  <th className="py-1.5 pr-3 font-medium">应退金额</th>
                  <th className="py-1.5 pr-3 font-medium">状态</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {items.map((item: SupplierReturn) => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-slate-700">
                      {item.returnNo}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-slate-500">
                      {orderNoById.get(item.originalPurchaseOrderId) ?? idLabel(item.originalPurchaseOrderId)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs">
                      {canViewPrice ? formatMoney(item.refundAmount) : MASKED_AMOUNT}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3">
                      <StatusPill
                        status={item.status}
                        className={RETURN_STATUS_CLASS[item.status] ?? 'bg-slate-100 text-slate-500'}
                      />
                    </td>
                    <td className="whitespace-nowrap py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setDetailId(item.id)}
                        className="rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600"
                      >
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
          <span>第 {pageIndex + 1} 页</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
              className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-40"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={nextCursor === null}
              onClick={() => {
                if (nextCursor === null) return;
                setCursors((current) => {
                  const next = current.slice(0, pageIndex + 1);
                  next[pageIndex + 1] = nextCursor;
                  return next;
                });
                setPageIndex((index) => index + 1);
              }}
              className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      </section>

      {detailId !== null ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">退货单详情</h3>
            <button
              type="button"
              onClick={() => setDetailId(null)}
              className="rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600"
            >
              关闭
            </button>
          </div>

          {detail.isError ? (
            <div className="mt-3">
              <ErrorBar message="详情加载失败" onRetry={() => void detail.refetch()} />
            </div>
          ) : detail.isPending || !detail.data ? (
            <TableSkeleton rows={2} />
          ) : (
            <div className="mt-3 space-y-3">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Kv label="单号">{detail.data.returnNo}</Kv>
                <Kv label="状态">
                  <StatusPill
                    status={detail.data.status}
                    className={RETURN_STATUS_CLASS[detail.data.status] ?? 'bg-slate-100 text-slate-500'}
                  />
                </Kv>
                <Kv label="原采购单">
                  {orderNoById.get(detail.data.originalPurchaseOrderId) ??
                    idLabel(detail.data.originalPurchaseOrderId)}
                </Kv>
                <Kv label="应退金额">
                  <span className="font-mono">
                    {canViewPrice ? formatMoney(detail.data.refundAmount) : MASKED_AMOUNT}
                  </span>
                </Kv>
              </dl>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400">
                      <th className="py-1.5 pr-3 font-medium">商品</th>
                      <th className="py-1.5 pr-3 font-medium">批次</th>
                      <th className="py-1.5 pr-3 font-medium">数量</th>
                      <th className="py-1.5 pr-3 font-medium">单价</th>
                      <th className="py-1.5 font-medium">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.lines.map((line, index) => (
                      <tr key={`${line.productId}-${index}`} className="border-t border-slate-100">
                        <td className="py-2 pr-3 text-xs">{productNameOf(productOptions, line.productId)}</td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-slate-500">
                          {line.batchIds.map((id) => batchLabelOf(batchOptions, id)).join(' / ')}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{formatQty(line.qty)}</td>
                        <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs">
                          {canViewPrice ? formatMoney(line.unitPrice) : MASKED_AMOUNT}
                        </td>
                        <td className="whitespace-nowrap py-2 font-mono text-xs">
                          {canViewPrice ? formatMoney(line.amount) : MASKED_AMOUNT}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-[11px] leading-relaxed text-slate-400">
                一期 S 单只有「登记」一步，没有完成 / 取消端点（D47）；退钱不走库存流水，批次数量不变。
              </p>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
