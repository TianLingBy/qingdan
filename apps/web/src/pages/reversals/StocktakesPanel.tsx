/**
 * I 盘点盈亏分栏（`/reversals` 第三栏；D47 / D67 / D71）。
 *
 * 这一栏和 R / S 完全不同：**它可以真正改批次数量**。审批通过时由 inventory 的库存写入
 * 服务调整入库量并追加一条冲正流水（D67），历史行不删不改（D47）。
 *
 * 三个按契约做对的点：
 * - 状态是**审批流三态**（待审批 / 已批准 / 已驳回），不是单据的「进行中 / 已完成 / 已取消」；
 * - 差异量不由客户端传：只填账面量与实盘量，服务端算 `diffQty`；无差异直接不让开单；
 * - 盘盈走 `stocktake.create`、盘亏走 `stocktake.delete`（D71 把「仅删减」拆成独立权限），
 *   所以同一张表单会因为实盘量比账面量大小不同，落到两条不同权限口径上。
 */

import type { Stocktake, StocktakeDetail, StocktakeStatus } from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { formatQty } from '../../lib/decimal';
import {
  STOCKTAKE_STATUS_CLASS,
  approveBlockedText,
  batchOptionLabel,
  idLabel,
  reversalsApi,
  reversalsQueryKeys,
  stocktakeDiffText,
  stocktakeDirection,
  stocktakeDirectionText,
  validateStocktakeDraft,
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

export interface StocktakesPanelProps {
  /** 盘盈：`stocktake.create`。 */
  readonly canIncrease: boolean;
  /** 盘亏：`stocktake.delete`（D71「仅删减」）。 */
  readonly canDecrease: boolean;
  readonly canApprove: boolean;
  readonly companyIds: readonly string[];
  readonly companyId: string;
  readonly onCompanyChange: (id: string) => void;
}

export function StocktakesPanel({
  canIncrease,
  canDecrease,
  canApprove,
  companyIds,
  companyId,
  onCompanyChange,
}: StocktakesPanelProps) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'' | StocktakeStatus>('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [batchId, setBatchId] = useState('');
  const [bookQty, setBookQty] = useState('');
  const [actualQty, setActualQty] = useState('');
  const [remark, setRemark] = useState('');
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
    queryKey: reversalsQueryKeys.stocktakes(filters),
    queryFn: () => reversalsApi.listStocktakes(filters),
  });

  const detail = useQuery({
    queryKey: reversalsQueryKeys.stocktake(detailId),
    queryFn: () => reversalsApi.stocktakeDetail(detailId!),
    enabled: detailId !== null,
  });

  const batches = useQuery({
    queryKey: reversalsQueryKeys.batches(companyId),
    queryFn: () => reversalsApi.listBatches(companyId || undefined),
    enabled: formOpen || list.isSuccess,
  });
  const batchOptions = batches.data?.items ?? [];
  const batchNoById = useMemo(() => {
    const map = new Map<string, string>();
    for (const batch of batchOptions) map.set(batch.id, batch.batchNo);
    return map;
  }, [batchOptions]);

  const direction = stocktakeDirection(bookQty, actualQty);
  const needsIncreaseRight = direction === 'increase';
  const needsDecreaseRight = direction === 'decrease';
  const rightMissing =
    (needsIncreaseRight && !canIncrease) || (needsDecreaseRight && !canDecrease);

  const submit = useMutation({
    mutationFn: () =>
      reversalsApi.createStocktake(direction === 'increase' ? 'increase' : 'decrease', {
        companyId,
        batchId,
        bookQty: bookQty.trim(),
        actualQty: actualQty.trim(),
        remark: remark.trim() || null,
      }),
    onSuccess: () => {
      setFormOpen(false);
      setBatchId('');
      setBookQty('');
      setActualQty('');
      setRemark('');
      setClientErrors([]);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['reversals', 'stocktake'] });
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : '提交失败，请稍后重试');
    },
  });

  const approve = useMutation({
    mutationFn: (row: StocktakeDetail) => reversalsApi.approveStocktake(row.id, row.version),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reversals', 'stocktake'] });
      // 批准会真的改批次可用量（D67）：批次下拉是缓存过的，不失效就会继续显示批准前的数。
      void queryClient.invalidateQueries({ queryKey: ['reversals', 'refs', 'batches'] });
      setActionError(null);
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : '审批失败，请稍后重试');
    },
  });

  const onSubmit = () => {
    setActionError(null);
    const errors = validateStocktakeDraft({ companyId, batchId, bookQty, actualQty });
    setClientErrors(errors);
    if (errors.length > 0) return;
    if (rightMissing) {
      setClientErrors([
        direction === 'increase'
          ? '当前身份没有盘盈权限（stocktake.create，D71）'
          : '当前身份没有盘亏权限（stocktake.delete = 仅删减，D71）',
      ]);
      return;
    }
    submit.mutate();
  };

  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;

  return (
    <div className="space-y-3">
      <BasisNote>
        盘点是仓库里<b>唯一能直接改批次数量</b>的单据：审批通过后调整入库量并追加一条冲正流水，
        历史行不改不删（D47 / D67）。状态是审批流三态（待审批 / 已批准 / 已驳回），
        不是单据的「进行中 / 已完成 / 已取消」。盘盈走 create、盘亏走 delete（D71）。
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
            onChange={(event) => setStatus(event.target.value as '' | StocktakeStatus)}
            className={FIELD_CLASS}
          >
            <option value="">全部</option>
            <option value="待审批">待审批</option>
            <option value="已批准">已批准</option>
            <option value="已驳回">已驳回</option>
          </select>
        </Field>
        <Field label="单号关键字" className="min-w-[180px]">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="I-0001-…"
            className={FIELD_CLASS}
          />
        </Field>
        <button
          type="button"
          onClick={() => {
            setFormOpen((open) => !open);
            setActionError(null);
          }}
          disabled={(!canIncrease && !canDecrease) || companyId.length === 0}
          title={
            canIncrease || canDecrease ? undefined : '当前身份没有盘盈 / 盘亏权限（D71）'
          }
          className="mb-0.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
        >
          {formOpen ? '收起开单' : '发起盘点单'}
        </button>
      </div>

      {formOpen ? (
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">发起盘点单</h3>
            <span className="text-xs text-slate-400">
              一张盘点单对应一个批次；差异量由服务端算，前端只填账面量与实盘量
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="盘点批次" hint="选批次后自动带出可用量作为账面量，可改">
              <select
                value={batchId}
                onChange={(event) => {
                  const next = event.target.value;
                  setBatchId(next);
                  const batch = batchOptions.find((item) => item.id === next);
                  // 账面量带出「能看的数」而不是 `300.000000`：人只填自己点的数，6 位小数由服务端管。
                  if (batch) setBookQty(formatQty(batch.availableQty));
                }}
                className={FIELD_CLASS}
              >
                <option value="">请选择批次</option>
                {batchOptions.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batchOptionLabel(batch)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="账面量" hint="系统账上的数量">
              <input
                value={bookQty}
                onChange={(event) => setBookQty(event.target.value)}
                inputMode="decimal"
                className={FIELD_CLASS}
              />
            </Field>
            <Field label="实盘量" hint="实际点出来的数量">
              <input
                value={actualQty}
                onChange={(event) => setActualQty(event.target.value)}
                inputMode="decimal"
                className={FIELD_CLASS}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>
              差异量 <b className="font-mono">{stocktakeDiffText(bookQty, actualQty)}</b>
            </span>
            <span>
              方向{' '}
              <b>
                {direction === 'none'
                  ? '无差异（不能开单）'
                  : stocktakeDirectionText(stocktakeDiffText(bookQty, actualQty))}
              </b>
            </span>
            <span className="text-slate-400">
              {direction === 'increase'
                ? '需要 stocktake.create 权限'
                : direction === 'decrease'
                  ? '需要 stocktake.delete 权限（仅删减，D71）'
                  : '实盘量与账面量相同'}
            </span>
          </div>

          <Field label="备注（选填）" hint="最多 200 字">
            <input
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
              maxLength={200}
              className={FIELD_CLASS}
            />
          </Field>

          <ErrorList errors={clientErrors} />
          {actionError ? <ErrorBar message={actionError} /> : null}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSubmit}
              disabled={submit.isPending || direction === 'none' || rightMissing}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
            >
              {submit.isPending
                ? '提交中…'
                : direction === 'increase'
                  ? '提交盘盈单'
                  : direction === 'decrease'
                    ? '提交盘亏单'
                    : '提交'}
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
          <h3 className="text-sm font-semibold text-slate-900">盘点单</h3>
          <span className="text-xs text-slate-400">共 {items.length} 条 · 审批后批次数量才会变</span>
        </div>

        {list.isError ? (
          <div className="mt-3">
            <ErrorBar message="列表加载失败" onRetry={() => void list.refetch()} />
          </div>
        ) : list.isPending ? (
          <TableSkeleton />
        ) : items.length === 0 ? (
          <EmptyState
            title="还没有盘点单"
            hint="盘点只用于盘盈盘亏冲正；实盘量与账面量一致时不需要开单。"
          />
        ) : (
          <div className="mt-3 -mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="text-xs text-slate-400">
                  <th className="py-1.5 pr-3 font-medium">单号</th>
                  <th className="py-1.5 pr-3 font-medium">批次</th>
                  <th className="py-1.5 pr-3 font-medium">账面量</th>
                  <th className="py-1.5 pr-3 font-medium">实盘量</th>
                  <th className="py-1.5 pr-3 font-medium">差异</th>
                  <th className="py-1.5 pr-3 font-medium">状态</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {items.map((item: Stocktake) => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-slate-700">
                      {item.stocktakeNo}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-slate-500">
                      {batchNoById.get(item.batchId) ?? idLabel(item.batchId)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{formatQty(item.bookQty)}</td>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{formatQty(item.actualQty)}</td>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums">
                      <span
                        className={
                          item.diffQty.startsWith('-') ? 'text-emerald-700' : 'text-rose-700'
                        }
                      >
                        {item.diffQty.startsWith('-') ? '' : '+'}
                        {formatQty(item.diffQty)}
                      </span>
                      <span className="ml-1 text-[11px] text-slate-400">
                        {stocktakeDirectionText(item.diffQty)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3">
                      <StatusPill
                        status={item.status}
                        className={STOCKTAKE_STATUS_CLASS[item.status] ?? 'bg-slate-100 text-slate-500'}
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
            <h3 className="text-sm font-semibold text-slate-900">盘点单详情</h3>
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
                <Kv label="单号">{detail.data.stocktakeNo}</Kv>
                <Kv label="状态">
                  <StatusPill
                    status={detail.data.status}
                    className={STOCKTAKE_STATUS_CLASS[detail.data.status] ?? 'bg-slate-100 text-slate-500'}
                  />
                </Kv>
                <Kv label="批次">
                  {batchNoById.get(detail.data.batchId) ?? idLabel(detail.data.batchId)}
                </Kv>
                <Kv label="差异量">
                  <span className="font-mono">
                    {detail.data.diffQty.startsWith('-') ? '' : '+'}
                    {formatQty(detail.data.diffQty)}
                  </span>
                  <span className="ml-1 text-xs text-slate-400">
                    {stocktakeDirectionText(detail.data.diffQty)}
                  </span>
                </Kv>
                <Kv label="账面量">{formatQty(detail.data.bookQty)}</Kv>
                <Kv label="实盘量">{formatQty(detail.data.actualQty)}</Kv>
                <Kv label="发起人">{idLabel(detail.data.applicantId)}</Kv>
                <Kv label="审批人">{idLabel(detail.data.approverId)}</Kv>
                <Kv label="备注">{detail.data.remark ?? '—'}</Kv>
              </dl>

              {actionError ? <ErrorBar message={actionError} /> : null}

              {detail.data.approvable.allowed ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => approve.mutate(detail.data!)}
                    disabled={!canApprove || approve.isPending}
                    title={canApprove ? undefined : '当前身份没有 stocktake.approve 权限'}
                    className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
                  >
                    {approve.isPending ? '审批中…' : '批准'}
                  </button>
                  <span className="text-[11px] text-slate-400">
                    批准后会调整批次可用量并追加一条冲正流水（D47 / D67），不可撤销；一期没有驳回端点。
                  </span>
                </div>
              ) : (
                <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  {approveBlockedText(detail.data.approvable.reason) ?? '当前状态不可审批'}
                </p>
              )}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
