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

import type {
  Stocktake,
  StocktakeDetail,
  StocktakeStatus,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { formatQty } from '../../lib/decimal';
import { useEmployeeLabel } from '../../lib/employee-directory';
import {
  STOCKTAKE_STATUS_TONE,
  approveBlockedText,
  batchOptionLabel,
  idLabel,
  reversalsApi,
  reversalsQueryKeys,
  stocktakeDiffText,
  stocktakeDirection,
  stocktakeDirectionText,
  validateStocktakeDraft,
  validateStocktakeRejectReason,
} from './reversals-api';
import {
  BasisNote,
  ErrorBar,
  ErrorList,
  FIELD_CLASS,
  Field,
  ReversalListCard,
  ReversalPager,
  TableSkeleton,
} from './reversals-ui';
import { DetailHead, DocMeta, DocPill } from '../../components/OrderDetailUI';
import { resolveListState } from '../../lib/list-state';

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
  const employeeLabel = useEmployeeLabel();
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
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);

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
    (needsIncreaseRight && !canIncrease) ||
    (needsDecreaseRight && !canDecrease);

  const submit = useMutation({
    mutationFn: () =>
      reversalsApi.createStocktake(
        direction === 'increase' ? 'increase' : 'decrease',
        {
          companyId,
          batchId,
          bookQty: bookQty.trim(),
          actualQty: actualQty.trim(),
          remark: remark.trim() || null,
        },
      ),
    onSuccess: () => {
      setFormOpen(false);
      setBatchId('');
      setBookQty('');
      setActualQty('');
      setRemark('');
      setClientErrors([]);
      setActionError(null);
      void queryClient.invalidateQueries({
        queryKey: ['reversals', 'stocktake'],
      });
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiError ? error.message : '提交失败，请稍后重试',
      );
    },
  });

  const approve = useMutation({
    mutationFn: (row: StocktakeDetail) =>
      reversalsApi.approveStocktake(row.id, row.version),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['reversals', 'stocktake'],
      });
      // 批准会真的改批次可用量（D67）：批次下拉是缓存过的，不失效就会继续显示批准前的数。
      void queryClient.invalidateQueries({
        queryKey: ['reversals', 'refs', 'batches'],
      });
      setActionError(null);
      setActionResult('盘点单已批准，批次数量与冲正流水已更新。');
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiError ? error.message : '审批失败，请稍后重试',
      );
    },
  });

  const reject = useMutation({
    mutationFn: (input: { row: StocktakeDetail; reason: string }) =>
      reversalsApi.rejectStocktake(input.row.id, input.row.version, {
        confirm: true,
        reason: input.reason,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['reversals', 'stocktake'],
      });
      setRejectOpen(false);
      setRejectReason('');
      setRejectError(null);
      setActionError(null);
      setActionResult('盘点单已驳回；库存数量与流水均未改变。');
    },
    onError: (error) => {
      setActionResult(null);
      setRejectError(
        error instanceof ApiError ? error.message : '驳回失败，请稍后重试',
      );
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 428)
      ) {
        void queryClient.invalidateQueries({
          queryKey: ['reversals', 'stocktake'],
        });
      }
    },
  });

  const onSubmit = () => {
    setActionError(null);
    setActionResult(null);
    const errors = validateStocktakeDraft({
      companyId,
      batchId,
      bookQty,
      actualQty,
    });
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

  const submitReject = (row: StocktakeDetail) => {
    setRejectError(null);
    const errors = validateStocktakeRejectReason(rejectReason);
    if (errors.length > 0) {
      setRejectError(errors[0] ?? '必须填写驳回原因。');
      return;
    }
    reject.mutate({ row, reason: rejectReason.trim() });
  };

  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  const listState = resolveListState({
    isPending: list.isPending,
    hasError: list.isError,
    isEmpty: items.length === 0,
  });

  return (
    <div className="space-y-3">
      <BasisNote>
        盘点是仓库里<b>唯一能直接改批次数量</b>
        的单据：审批通过后调整入库量并追加一条冲正流水， 历史行不改不删（D47 /
        D67）。状态是审批流三态（待审批 / 已批准 / 已驳回）， 不是单据的「进行中
        / 已完成 / 已取消」。盘盈走 create、盘亏走 delete（D71）。
      </BasisNote>

      <div className="flex flex-wrap items-end gap-3">
        {companyIds.length > 1 ? (
          <Field label="公司" className="min-w-[180px]">
            <select
              value={companyId}
              onChange={(event) => onCompanyChange(event.target.value)}
              className={FIELD_CLASS}
            >
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
            onChange={(event) =>
              setStatus(event.target.value as '' | StocktakeStatus)
            }
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
            canIncrease || canDecrease
              ? undefined
              : '需要 stocktake.create 或 stocktake.delete 权限'
          }
          className="btn btn-primary mb-0.5"
        >
          {formOpen ? '收起开单' : '发起盘点单'}
        </button>
      </div>

      <p className="text-sm text-[var(--text-3)]">
        当前筛选：公司 {companyId ? idLabel(companyId) : '全部可见公司'} ·{' '}
        {status || '全部状态'} · 单号 {keyword.trim() || '全部'}
      </p>

      {formOpen ? (
        <section className="space-y-3 rounded-xl border border-[var(--line-2)] bg-[var(--surf-1)] p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--text-1)]">
              发起盘点单
            </h3>
            <span className="text-xs text-[var(--text-3)]">
              一张盘点单对应一个批次；差异量由服务端算，前端只填账面量与实盘量
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="盘点批次"
              hint="选批次后自动带出可用量作为账面量，可改"
            >
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

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg bg-[var(--surf-2)] px-3 py-2 text-xs text-[var(--text-2)]">
            <span>
              差异量{' '}
              <b className="font-mono">
                {stocktakeDiffText(bookQty, actualQty)}
              </b>
            </span>
            <span>
              方向{' '}
              <b>
                {direction === 'none'
                  ? '无差异（不能开单）'
                  : stocktakeDirectionText(
                      stocktakeDiffText(bookQty, actualQty),
                    )}
              </b>
            </span>
            <span className="text-[var(--text-3)]">
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
              disabled={
                submit.isPending || direction === 'none' || rightMissing
              }
              className="btn btn-primary"
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
              className="btn"
            >
              取消
            </button>
          </div>
        </section>
      ) : null}

      <ReversalListCard
        title="盘点单"
        meta={`共 ${items.length} 条 · 审批后批次数量才会变`}
        state={listState}
        colCount={7}
        minWidth="720px"
        head={
          <tr>
            <th>单号</th>
            <th>批次</th>
            <th className="num">账面量</th>
            <th className="num">实盘量</th>
            <th className="num">差异</th>
            <th>状态</th>
            <th />
          </tr>
        }
        emptyText="还没有盘点单"
        emptyHint="盘点只用于盘盈盘亏冲正；实盘量与账面量一致时不需要开单。"
        errorTitle="盘点单加载失败"
        error={list.error}
        onRetry={() => void list.refetch()}
        pager={
          <ReversalPager
            batchIndex={pageIndex}
            count={items.length}
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
          />
        }
      >
        {items.map((item: Stocktake) => (
          <tr key={item.id} className="r-row">
            <td className="whitespace-nowrap">
              <button
                type="button"
                onClick={() => setDetailId(item.id)}
                className="font-mono text-xs underline-offset-2 hover:underline"
              >
                {item.stocktakeNo}
              </button>
            </td>
            <td
              className="whitespace-nowrap font-mono text-xs"
              style={{ color: 'var(--text-3)' }}
            >
              {batchNoById.get(item.batchId) ?? idLabel(item.batchId)}
            </td>
            <td className="num whitespace-nowrap">{formatQty(item.bookQty)}</td>
            <td className="num whitespace-nowrap">
              {formatQty(item.actualQty)}
            </td>
            <td className="num whitespace-nowrap">
              {item.diffQty.startsWith('-') ? '' : '+'}
              {formatQty(item.diffQty)}
              <span className="ml-1 text-xs" style={{ color: 'var(--text-3)' }}>
                {stocktakeDirectionText(item.diffQty)}
              </span>
            </td>
            <td className="whitespace-nowrap">
              <DocPill
                label={item.status}
                tone={STOCKTAKE_STATUS_TONE[item.status] ?? 'warn'}
              />
            </td>
            <td className="whitespace-nowrap text-right">
              <button
                type="button"
                onClick={() => setDetailId(item.id)}
                className="btn btn-s"
              >
                详情
              </button>
            </td>
          </tr>
        ))}
      </ReversalListCard>

      {detailId !== null ? (
        <section className="card min-w-0 p-4">
          {detail.isError ? (
            <ErrorBar
              message="详情加载失败"
              onRetry={() => void detail.refetch()}
            />
          ) : detail.isPending || !detail.data ? (
            <TableSkeleton rows={2} />
          ) : (
            <div className="space-y-3">
              <DetailHead
                docLabel="盘点单"
                orderNo={detail.data.stocktakeNo}
                pill={
                  <DocPill
                    label={detail.data.status}
                    tone={STOCKTAKE_STATUS_TONE[detail.data.status] ?? 'warn'}
                  />
                }
                meta={
                  <>
                    <span>{stocktakeDirectionText(detail.data.diffQty)}</span>
                    <span aria-hidden="true" style={{ color: 'var(--line-3)' }}>
                      ·
                    </span>
                    <span>
                      批次{' '}
                      {batchNoById.get(detail.data.batchId) ??
                        idLabel(detail.data.batchId)}
                    </span>
                  </>
                }
                actions={
                  detail.data.approvable.allowed ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setActionResult(null);
                          setActionError(null);
                          approve.mutate(detail.data!);
                        }}
                        disabled={
                          !canApprove || approve.isPending || reject.isPending
                        }
                        title={
                          canApprove
                            ? '执行「批准」· 需要 stocktake.approve 权限'
                            : '需要 stocktake.approve 权限'
                        }
                        className="btn btn-p"
                      >
                        {approve.isPending ? '审批中…' : '批准'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRejectOpen(true);
                          setRejectError(null);
                          setActionResult(null);
                        }}
                        disabled={
                          !canApprove || approve.isPending || reject.isPending
                        }
                        title={
                          canApprove
                            ? '执行「驳回」· 需要 stocktake.approve 权限'
                            : '需要 stocktake.approve 权限'
                        }
                        className="btn btn-s"
                      >
                        驳回
                      </button>
                    </>
                  ) : null
                }
                onClose={() => {
                  setDetailId(null);
                  setRejectOpen(false);
                  setRejectError(null);
                }}
              />

              <DocMeta
                columns={3}
                items={[
                  {
                    label: '批次',
                    mono: true,
                    value:
                      batchNoById.get(detail.data.batchId) ??
                      idLabel(detail.data.batchId),
                  },
                  {
                    label: '账面量',
                    mono: true,
                    value: formatQty(detail.data.bookQty),
                  },
                  {
                    label: '实盘量',
                    mono: true,
                    value: formatQty(detail.data.actualQty),
                  },
                  {
                    label: '差异量',
                    mono: true,
                    tone: 'money',
                    value: `${detail.data.diffQty.startsWith('-') ? '' : '+'}${formatQty(
                      detail.data.diffQty,
                    )}（${stocktakeDirectionText(detail.data.diffQty)}）`,
                  },
                  {
                    label: '发起人',
                    value: employeeLabel(detail.data.applicantId),
                  },
                  {
                    label: '审批人',
                    value: employeeLabel(detail.data.approverId),
                  },
                  {
                    label: '备注',
                    tone: detail.data.remark ? undefined : 'dim',
                    value: detail.data.remark ?? '—',
                  },
                ]}
              />

              {actionResult ? (
                <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  {actionResult}
                </p>
              ) : null}
              {actionError ? <ErrorBar message={actionError} /> : null}

              {detail.data.approvable.allowed ? (
                <p
                  className="text-xs leading-relaxed"
                  style={{ color: 'var(--text-3)' }}
                >
                  批准后会调整批次可用量并追加一条冲正流水（D47 /
                  D67）；驳回只终止审批流，不改库存、不写流水。
                </p>
              ) : (
                <p
                  className="rounded-lg px-3 py-2 text-xs"
                  style={{
                    background: 'var(--surf-2)',
                    color: 'var(--text-3)',
                  }}
                >
                  {approveBlockedText(detail.data.approvable.reason) ??
                    '当前状态不可审批'}
                </p>
              )}

              {rejectOpen && detail.data.approvable.allowed ? (
                <section className="rounded-xl border border-rose-200 bg-rose-50 p-4">
                  <h3 className="font-semibold text-rose-900">驳回盘点单</h3>
                  <p className="mt-1 text-sm text-rose-700">
                    驳回后不可再次审批；库存数量与流水不会改变。
                  </p>
                  <label className="mt-3 block text-sm">
                    <span className="text-rose-900">驳回原因</span>
                    <input
                      value={rejectReason}
                      onChange={(event) => setRejectReason(event.target.value)}
                      maxLength={200}
                      className="mt-1 w-full rounded-lg border border-rose-300 bg-white px-3 py-2"
                    />
                  </label>
                  {rejectError ? (
                    <p className="mt-2 text-sm text-rose-700">{rejectError}</p>
                  ) : null}
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={reject.isPending}
                      onClick={() => submitReject(detail.data)}
                      className="btn btn-s"
                    >
                      {reject.isPending ? '驳回中…' : '确认驳回'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRejectOpen(false);
                        setRejectReason('');
                        setRejectError(null);
                      }}
                      className="btn"
                    >
                      取消
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
