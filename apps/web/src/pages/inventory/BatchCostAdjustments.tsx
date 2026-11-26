import type {
  CostAdjustmentCreateInput,
  CostAdjustmentRejectInput,
  InventoryCostAdjustment,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
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
export function validateCostAdjustmentDraft(
  draft: CostAdjustmentDraft,
): string[] {
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
export function costAdjustmentErrorText(
  error: unknown,
  fallback: string,
): string {
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
      queryClient.invalidateQueries({
        queryKey: ['inventory', 'cost-adjustments'],
      }),
      queryClient.invalidateQueries({ queryKey: ['inventory', 'batches'] }),
      queryClient.invalidateQueries({ queryKey: ['inventory', 'batch'] }),
    ]);
  };

  const recoverFromWriteError = (error: unknown) => {
    if (
      error instanceof ApiError &&
      (error.status === 409 || error.status === 428)
    ) {
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
      costAdjustmentApi.reject(input.item.id, input.item.version, {
        reason: input.reason,
      } satisfies CostAdjustmentRejectInput),
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
    <section className="cost-panel">
      <div className="panel-row">
        <div>
          <h3 className="section-title">成本更正</h3>
          <p className="section-sub">
            只改批次成本、不改数量。档位由服务端按下游引用自动判定：T1
            直接生效，T2 待审批，T3 已结算锁定。
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
          className="btn btn-primary"
        >
          {formOpen ? '收起更正' : '发起成本更正'}
        </button>
      </div>

      {!canViewPrice ? (
        <p className="notice notice-warn">
          当前身份没有
          inventory_qty.view_price，成本与差额统一显示占位；接口仍会返回记录状态。
        </p>
      ) : null}

      {formOpen ? (
        <div className="edit-panel">
          <div className="form-grid form-grid-2">
            <label className="field">
              <span className="field-label">更正后单位成本</span>
              <input
                value={afterUnitCost}
                onChange={(event) => setAfterUnitCost(event.target.value)}
                inputMode="decimal"
                placeholder="例如 21.50"
                className="field-control"
              />
            </label>
            <label className="field">
              <span className="field-label">更正原因</span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
                placeholder="例如 补录供应商运费"
                className="field-control"
              />
            </label>
          </div>
          {clientErrors.length > 0 ? (
            <ul className="notice notice-warn">
              {clientErrors.map((error) => (
                <li key={error}>· {error}</li>
              ))}
            </ul>
          ) : null}
          <div className="form-actions">
            <button
              type="button"
              disabled={!canUpdate || create.isPending}
              onClick={submitCreate}
              className="btn btn-primary"
            >
              {create.isPending ? '提交中…' : '提交更正'}
            </button>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                setClientErrors([]);
              }}
              className="btn"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {actionResult ? (
        <p className="notice notice-success">{actionResult}</p>
      ) : null}
      {actionError ? (
        <p className="notice notice-error">{actionError}</p>
      ) : null}

      <div className="cost-table-wrap">
        {list.isPending ? (
          <ListLoading label="成本更正历史加载中…" />
        ) : list.isError ? (
          <ListError
            title="成本更正历史加载失败"
            error={list.error}
            message={costAdjustmentErrorText(
              list.error,
              '成本更正历史加载失败',
            )}
            onRetry={() => void list.refetch()}
          />
        ) : items.length === 0 ? (
          <ListEmpty title="暂无成本更正记录。只有确实需要修正批次锁价时才发起。" />
        ) : (
          <table className="data-table wide-cost compact-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>档位 / 状态</th>
                <th>成本变动</th>
                <th>差额</th>
                <th>原因</th>
                <th>发起 / 审批</th>
                <th>下游引用</th>
                <th className="cell-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="r-row">
                  <td className="cell-nowrap cell-muted">
                    {formatDateTime(item.createdAt)}
                  </td>
                  <td className="cell-nowrap">
                    <div className="stacked">
                      <div>{COST_ADJUSTMENT_TIER_LABEL[item.tier]}</div>
                      <div className="cell-muted">
                        {COST_ADJUSTMENT_STATUS_LABEL[item.status]}
                      </div>
                    </div>
                  </td>
                  <td className="cell-nowrap mono-small">
                    {amountText(item.beforeUnitCost, canViewPrice)} →{' '}
                    {amountText(item.afterUnitCost, canViewPrice)}
                  </td>
                  <td className="cell-nowrap mono-small">
                    {amountText(item.deltaAmount, canViewPrice)}
                  </td>
                  <td className="wrap-cell">{item.reason}</td>
                  <td className="cell-muted">
                    <div className="stacked">
                      <div title={item.requestedBy}>
                        {shortId(item.requestedBy)}
                      </div>
                      <div title={item.approvedBy ?? undefined}>
                        {item.approvedBy ? shortId(item.approvedBy) : '—'}
                      </div>
                    </div>
                  </td>
                  <td className="wrap-cell cell-muted">
                    {referenceText(item)}
                  </td>
                  <td className="cell-nowrap cell-right">
                    {item.status === 'pending_approval' && canApprove ? (
                      <div className="row-actions">
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
                          className="btn btn-s"
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
                          className="btn btn-s danger"
                        >
                          驳回
                        </button>
                      </div>
                    ) : (
                      <span className="row-state">
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
        <div className="reject-panel">
          <p className="reject-title">驳回成本更正</p>
          <p className="reject-copy">
            原更正原因：{rejectingItem.reason}。驳回不会改变批次锁定成本。
          </p>
          <div className="form-actions">
            <label className="field field-lg">
              <span className="field-label">驳回原因</span>
              <input
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                maxLength={200}
                className="field-control reject-control"
              />
            </label>
            <button
              type="button"
              disabled={reject.isPending}
              onClick={submitReject}
              className="btn btn-primary"
            >
              {reject.isPending ? '驳回中…' : '确认驳回'}
            </button>
            <button
              type="button"
              onClick={() => {
                setRejectingId(null);
                setRejectError(null);
              }}
              className="btn"
            >
              取消
            </button>
          </div>
          {rejectError ? <p className="reject-error">{rejectError}</p> : null}
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
