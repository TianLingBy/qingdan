/**
 * 加工发货弹层（D94 ②）：整单选一个在途分段与去向，不是逐行。
 *
 * 为什么整单一个分段而不是按行：加工单只有「料进厂」和「成品出厂」两段物流，
 * 每张单在同一时刻只可能在其中一段上（契约把 `transitStage` 放在单据头，
 * 不是明细行）。逐行反而会造出「半张单在料段、半张在成品段」这种不存在的状态。
 *
 * 外观照 `purchase/ShipDialog.tsx`：`fixed inset-0` 遮罩 + 居中卡片，不引新 UI 库。
 * 本仓没有 `components/` 级的通用弹窗——采购那张就是这么写的，这里保持一致。
 */

import { formatQty } from '../../lib/decimal';
import {
  STAGE_LABEL,
  TRANSIT_LABEL,
  type ShipDraft,
  type TransitStage,
  type TransitTo,
} from './ship-flow';

export interface ProcessingShipDialogProps {
  readonly orderNo: string;
  readonly inputQty: string;
  readonly draft: ShipDraft;
  readonly errors: readonly string[];
  /** 保管人候选（`EmployeeSummary` 精简后的 `{id,name}`）；没权限时为空数组。 */
  readonly custodians: readonly { readonly id: string; readonly name: string }[];
  /** 保管人列表读不到时的原因（没权限 / 请求失败）。 */
  readonly custodiansError: string | null;
  readonly busy: boolean;
  readonly onChange: (patch: Partial<ShipDraft>) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}

export function ProcessingShipDialog({
  orderNo,
  inputQty,
  draft,
  errors,
  custodians,
  custodiansError,
  busy,
  onChange,
  onClose,
  onSubmit,
}: ProcessingShipDialogProps) {
  /**
   * 为什么「料」段完全不显示损耗量 / 保管人 / 全损耗确认：
   * 料段还没到验收环节——货还在去加工厂的路上，实际损耗还没发生。把验收口径提前
   * 写进运输阶段，等于要求用户在路上就先承诺损耗；而契约 `superRefine` 对
   * 「料段带这些字段」本来就是报错，所以这里也不该给输入框（给了就必然 422）。
   */
  const finishedStage = draft.transitStage === 'finished';

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`加工发货 ${orderNo}`}
        className="mt-8 w-full max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">发货 · {orderNo}</h2>
            <p className="mt-1 text-xs text-slate-500">
              投入量 {formatQty(inputQty)} · 发货后状态变「在途」，到货确认后才算完成。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-sm text-slate-500 hover:text-slate-900 disabled:opacity-40"
          >
            关闭
          </button>
        </div>

        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          一段物流一个分段：<b>料</b>是材料在去加工厂路上，<b>成品</b>是货往仓或客户走。
          成品段要在发货时承诺损耗量，因为验收口径跟着成品一起走。
        </p>

        <div className="mt-4 space-y-3 text-sm">
          <label className="block">
            <span className="text-slate-600">在途分段</span>
            <select
              aria-label="在途分段"
              value={draft.transitStage}
              disabled={busy}
              onChange={(event) =>
                // 切段时清掉只有成品段才合法的字段：留着会被带到请求里，契约直接 422。
                onChange({
                  transitStage: event.target.value as TransitStage,
                  ...(event.target.value === 'materials'
                    ? { lossQty: '', custodianId: '', confirmFullLoss: false }
                    : {}),
                })
              }
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            >
              <option value="materials">{STAGE_LABEL.materials}</option>
              <option value="finished">{STAGE_LABEL.finished}</option>
            </select>
          </label>

          <label className="block">
            <span className="text-slate-600">去向</span>
            <select
              aria-label="在途去向"
              value={draft.transitTo}
              disabled={busy}
              onChange={(event) => onChange({ transitTo: event.target.value as TransitTo })}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            >
              <option value="warehouse">{TRANSIT_LABEL.warehouse}</option>
              <option value="customer">{TRANSIT_LABEL.customer}</option>
            </select>
          </label>

          {finishedStage && (
            <>
              <label className="block">
                <span className="text-slate-600">损耗量（成品段必填）</span>
                <input
                  aria-label="损耗量"
                  inputMode="decimal"
                  value={draft.lossQty}
                  disabled={busy}
                  onChange={(event) => onChange({ lossQty: event.target.value })}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                />
              </label>

              <label className="block">
                <span className="text-slate-600">损失保管人（选填）</span>
                <select
                  aria-label="损失保管人"
                  value={draft.custodianId}
                  disabled={busy || custodians.length === 0}
                  onChange={(event) => onChange({ custodianId: event.target.value })}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-50 disabled:text-slate-400"
                >
                  <option value="">{custodians.length === 0 ? '（无人员可选）' : '不指定'}</option>
                  {custodians.map((custodian) => (
                    <option key={custodian.id} value={custodian.id}>
                      {custodian.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label="确认全损耗"
                  checked={draft.confirmFullLoss}
                  disabled={busy}
                  onChange={(event) => onChange({ confirmFullLoss: event.target.checked })}
                />
                <span className="text-slate-600">确认全损耗（不生成产出批次，材料与加工费全额记损失）</span>
              </label>
            </>
          )}
        </div>

        {finishedStage && custodiansError && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {custodiansError}
          </p>
        )}

        {errors.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            className="rounded bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? '提交中…' : '确认发货'}
          </button>
        </div>
      </section>
    </div>
  );
}
