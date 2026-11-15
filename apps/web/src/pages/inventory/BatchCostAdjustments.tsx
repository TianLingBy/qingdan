import type {
  CostAdjustmentCreateInput,
  CostAdjustmentRejectInput,
  InventoryCostAdjustment,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { formatMoney, isPositiveDecimal } from '../../lib/decimal';
import {
  COST_ADJUSTMENT_STATUS_LABEL,
  COST_ADJUSTMENT_TIER_LABEL,
  costAdjustmentApi,
  costAdjustmentQueryKeys,
  type CostAdjustmentFilters,
} from './inventory-cost-adjustment-api';
import { errorText, formatDateTime, Pagination, shortId } from './inventory-ui';

export interface BatchCostAdjustmentsProps {
  readonly batchId: string;
  /** `inventory_qty.read`：没有读权限时整个面板不出现。 */
  readonly canRead: boolean;
  /** `inventory_qty.update`：只能发起，不得审批。 */
  readonly canUpdate: boolean;
  /** `inventory_qty.approve`：审批通过 / 驳回，必须带行版本。 */
  readonly canApprove: boolean;
  /** `inventory_qty.view_price`：false 时金额由接口脱敏，页面也兜底显示占位。 */
  readonly canViewPrice: boolean;
}

export interface CostAdjustmentDraft {
  readonly afterUnitCost: string;
  readonly reason: string;
}

/** 与服务端 decimal 契约一致；真正的档位与资格判定仍由服务端完成。 */
export function validateCostAdjustmentDraft(draft: CostAdjustmentDraft): string[] {
  const errors: string[] = [];
  const afterUnitCost = draft.afterUnitCost.trim();
  const reason = draft.reason.trim();
  if (!isPositiveDecimal(afterUnitCost)) {
    errors.push('更正后单位成本必须是非负 decimal，最多 6 位小数。');
  }
  if (reason.length === 0) {
    errors.push('必须填写更正原因。');
  } else if (reason.length > 200) {
    errors.push('更正原因不能超过 200 字。');
  }
  return errors;
}

function detailsOf(error: ApiError): Record<string, unknown> | null {
  return typeof error.details === 'object' && error.details !== null
    ? (error.details as Record<string, unknown>)
    : null;
}

/** 把 428 / 版本冲突 / T3 已结算锁定翻译成可操作提示。 */
export function costAdjustmentErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 428) {
      return `${fallback}：缺少版本条件，请刷新后重试。`;
    }
    const details = detailsOf(error);
    if (details?.reason === 'COST_ADJUSTMENT_LOCKED') {
      return '该批次已进入结算，成本已锁定，不能更正；如需调整请走退货单据。';
    }
    if (error.status === 409) {
      return `${fallback}：数据已被更新，已刷新到最新状态，请核对后重试。`;
    }
  }
  return errorText(error, fallback);
}

function amountText(value: string | null, canViewPrice: boolean): string {
  return canViewPrice && value !== null ? formatMoney(value) : '—';
}

function referenceText(item: InventoryCostAdjustment): string {
  const refs = item.referenceSnapshot.references;
  if (refs.length === 0) {
    return item.referenceSnapshot.referenced ? '有下游引用' : '无下游引用';
  }
  return refs
    .map((ref) => `${ref.module} ${ref.docType} ${shortId(ref.docId)}`)
    .join('；');
}

export function BatchCostAdjustments({
  batchId,
  canRead,
  canUpdate,
  canApprove,
  canViewPrice,
}: BatchCostAdjustmentsProps) {
  const queryClient = useQueryClient();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [afterUnitCost, setAfterUnitCost] = useState('');
  const [reason, setReason] = useState('');
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);

  const filters: CostAdjustmentFilters = {
    cursor: cursors[pageIndex] ?? null,
    limit: 50,
  };
  const list = useQuery({
    queryKey: costAdjustmentQueryKeys.list(batchId, filters),
    queryFn: () => costAdjustmentApi.list(batchId, filters),
    enabled: canRead,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inventory', 'cost-adjustments'] }),
      queryClient.invalidateQueries({ queryKey: ['inventory', 'batches'] }),
      queryClient.invalidateQueries({ queryKey: ['inventory', 'batch'] }),
    ]);
  };

  const recoverFromWriteError = (error: unknown) => {
    if (error instanceof ApiError && (error.status === 409 || error.status === 428)) {
      void refresh();
    }
  };

  const create = useMutation({
    mutationFn: (input: CostAdjustmentCreateInput) =>
      costAdjustmentApi.create(batchId, input),
    onSuccess: (adjustment) => {
      setActionResult(
        adjustment.status === 'applied'
          ? '成本更正已直接生效（T1），批次锁定成本已更新。'
          : '成本更正已提交，需由有审批权限的人处理（T2）。',
      );
      setActionError(null);
      setClientErrors([]);
      setFormOpen(false);
      setAfterUnitCost('');
      setReason('');
      void refresh();
    },
    onError: (error) => {
      setActionResult(null);
      setActionError(costAdjustmentErrorText(error, '提交成本更正失败'));
      recoverFromWriteError(error);
    },
  });

  const approve = useMutation({
    mutationFn: (item: InventoryCostAdjustment) =>
      costAdjustmentApi.approve(item.id, item.version),
    onSuccess: () => {
      setActionResult('审批通过，批次锁定成本已更新。');
      setActionError(null);
      void refresh();
    },
    onError: (error) => {
      setActionResult(null);
      setActionError(costAdjustmentErrorText(error, '审批成本更正失败'));
      recoverFromWriteError(error);
    },
  });

  const reject = useMutation({
    mutationFn: (input: { item: InventoryCostAdjustment; reason: string }) =>
      costAdjustmentApi.reject(
        input.item.id,
        input.item.version,
        { reason: input.reason } satisfies CostAdjustmentRejectInput,
      ),
    onSuccess: () => {
      setActionResult('成本更正已驳回。');
      setActionError(null);
      setRejectError(null);
      setRejectingId(null);
      setRejectReason('');
      void refresh();
    },
    onError: (error) => {
      setActionResult(null);
      setRejectError(costAdjustmentErrorText(error, '驳回成本更正失败'));
      recoverFromWriteError(error);
    },
  });

  if (!canRead) return null;

  const items = list.data?.items ?? [];
  const rejectingItem = items.find((item) => item.id === rejectingId);

  const submitCreate = () => {
    setActionResult(null);
    setActionError(null);
    const draft = { afterUnitCost, reason };
    const errors = validateCostAdjustmentDraft(draft);
    setClientErrors(errors);
    if (errors.length > 0) return;
    create.mutate({
      afterUnitCost: afterUnitCost.trim(),
      reason: reason.trim(),
    });
  };

  const submitReject = () => {
    setRejectError(null);
    const trimmed = rejectReason.trim();
    if (!trimmed) {
      setRejectError('必须填写驳回原因。');
      return;
    }
    if (trimmed.length > 200) {
      setRejectError('驳回原因不能超过 200 字。');
      return;
    }
    if (rejectingItem) {
      reject.mutate({ item: rejectingItem, reason: trimmed });
    }
  };

  return (
    <section className="space-y-3 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">成本更正</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            只改批次成本、不改数量。档位由服务端按下游引用自动判定：T1 直接生效，T2
            待审批，T3 已结算锁定。
          </p>
        </div>
        <button
          type="button"
          disabled={!canUpdate || create.isPending}
          title={canUpdate ? undefined : '需要 inventory_qty.update 权限'}
          onClick={() => {
            setFormOpen((open) => !open);
            setActionError(null);
            setActionResult(null);
          }}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
        >
          {formOpen ? '收起更正' : '发起成本更正'}
        </button>
      </div>

      {!canViewPrice ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          当前身份没有 inventory_qty.view_price，成本与差额统一显示占位；接口仍会返回记录状态。
        </p>
      ) : null}

      {formOpen ? (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="text-slate-600">更正后单位成本</span>
              <input
                value={afterUnitCost}
                onChange={(event) => setAfterUnitCost(event.target.value)}
                inputMode="decimal"
                placeholder="例如 21.50"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="text-slate-600">更正原因</span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
                placeholder="例如 补录供应商运费"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
              />
            </label>
          </div>
          {clientErrors.length > 0 ? (
            <ul className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {clientErrors.map((error) => (
                <li key={error}>· {error}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!canUpdate || create.isPending}
              onClick={submitCreate}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
            >
              {create.isPending ? '提交中…' : '提交更正'}
            </button>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                setClientErrors([]);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {actionResult ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {actionResult}
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {actionError}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        {list.isPending ? (
          <div className="space-y-2 p-4" aria-busy="true">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-8 animate-pulse rounded bg-slate-100" />
            ))}
            <p className="text-xs text-slate-400">成本更正历史加载中…</p>
          </div>
        ) : list.isError ? (
          <div className="p-5 text-center">
            <p className="text-sm text-rose-600">
              {costAdjustmentErrorText(list.error, '成本更正历史加载失败')}
            </p>
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">
            暂无成本更正记录。只有确实需要修正批次锁价时才发起。
          </p>
        ) : (
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">时间</th>
                <th className="px-3 py-2">档位 / 状态</th>
                <th className="px-3 py-2">成本变动</th>
                <th className="px-3 py-2">差额</th>
                <th className="px-3 py-2">原因</th>
                <th className="px-3 py-2">发起 / 审批</th>
                <th className="px-3 py-2">下游引用</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-slate-100 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                    {formatDateTime(item.createdAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    <div>{COST_ADJUSTMENT_TIER_LABEL[item.tier]}</div>
                    <div className="mt-0.5 text-slate-500">
                      {COST_ADJUSTMENT_STATUS_LABEL[item.status]}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                    {amountText(item.beforeUnitCost, canViewPrice)} →{' '}
                    {amountText(item.afterUnitCost, canViewPrice)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                    {amountText(item.deltaAmount, canViewPrice)}
                  </td>
                  <td className="max-w-64 px-3 py-2 text-xs text-slate-700">{item.reason}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    <div title={item.requestedBy}>{shortId(item.requestedBy)}</div>
                    <div className="mt-0.5" title={item.approvedBy ?? undefined}>
                      {item.approvedBy ? shortId(item.approvedBy) : '—'}
                    </div>
                  </td>
                  <td className="max-w-64 px-3 py-2 text-xs text-slate-500">
                    {referenceText(item)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {item.status === 'pending_approval' && canApprove ? (
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={approve.isPending || reject.isPending}
                          onClick={() => {
                            if (
                              globalThis.confirm?.(
                                `确认通过成本更正吗？\n\n${item.reason}\n\n通过后批次锁定成本将立即更新。`,
                              ) === false
                            ) {
                              return;
                            }
                            setActionError(null);
                            setActionResult(null);
                            approve.mutate(item);
                          }}
                          className="rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-700 disabled:opacity-40"
                        >
                          审批通过
                        </button>
                        <button
                          type="button"
                          disabled={approve.isPending || reject.isPending}
                          onClick={() => {
                            setRejectingId(item.id);
                            setRejectReason('');
                            setRejectError(null);
                          }}
                          className="rounded border border-rose-300 px-2 py-1 text-xs text-rose-700 disabled:opacity-40"
                        >
                          驳回
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">
                        {item.status === 'pending_approval'
                          ? '需 inventory_qty.approve'
                          : '已处理'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {rejectingItem ? (
        <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
          <p className="text-sm font-medium text-rose-900">驳回成本更正</p>
          <p className="text-xs text-rose-700">
            原更正原因：{rejectingItem.reason}。驳回不会改变批次锁定成本。
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-64 flex-1 text-sm">
              <span className="text-slate-600">驳回原因</span>
              <input
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                maxLength={200}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
              />
            </label>
            <button
              type="button"
              disabled={reject.isPending}
              onClick={submitReject}
              className="rounded-lg bg-rose-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {reject.isPending ? '驳回中…' : '确认驳回'}
            </button>
            <button
              type="button"
              onClick={() => {
                setRejectingId(null);
                setRejectError(null);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600"
            >
              取消
            </button>
          </div>
          {rejectError ? <p className="text-xs text-rose-700">{rejectError}</p> : null}
        </div>
      ) : null}

      <Pagination
        pageIndex={pageIndex}
        nextCursor={list.data?.nextCursor ?? null}
        onPrevious={() => setPageIndex((index) => Math.max(0, index - 1))}
        onNext={(cursor) => {
          setCursors((current) => [...current.slice(0, pageIndex + 1), cursor]);
          setPageIndex((index) => index + 1);
        }}
      />
    </section>
  );
}
