/**
 * 加工发货弹层（D94 ②）：整单选一个在途分段，成品段再选去向；不是逐行。
 *
 * 为什么整单一个分段而不是按行：加工单只有「料进厂」和「成品出厂」两段物流，
 * 每张单在同一时刻只可能在其中一段上（契约把 `transitStage` 放在单据头，
 * 不是明细行）。逐行反而会造出「半张单在料段、半张在成品段」这种不存在的状态。
 *
 * 为什么料段没有「去向」下拉（#333 复核）：料往加工厂去，方向由单据上的加工厂
 * 唯一决定，这里只把它显示出来，不让用户选。原来两段共用 warehouse/customer 下拉，
 * 料在路上时会写入一个成品去向，读单的人会以为料要回仓。
 *
 * 外观照 `purchase/ShipDialog.tsx`（#431 第三轮统一）：`mask-scroll` 遮罩 + `sheet` 三段
 * （`-h` 标题 / `-b` 正文 / `-f` 按钮），不引新 UI 库 —— 本仓没有 `components/` 级通用弹窗。
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
  /** 单据上的加工厂：料段的去向**就是它**，只读展示，不给下拉。 */
  readonly processorName: string;
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
  processorName,
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
    <div className="mask-scroll">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`加工发货 ${orderNo}`}
        className="sheet"
      >
        <div className="sheet-h">
          <div>
            <h2>发货 · {orderNo}</h2>
            <small>
              投入量 {formatQty(inputQty)} · 发货后状态变「在途」，到货确认后才算完成。
            </small>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="sheet-close">
            关闭
          </button>
        </div>

        <div className="sheet-b form-stack">
          <p className="alert alert-info alert-sm">
            一段物流一个分段：<b>料</b>是材料在去加工厂路上（去哪就是本单的加工厂，不用选）；
            <b>成品</b>是货往仓或客户走。成品段要在发货时承诺损耗量，因为验收口径跟着成品一起走。
          </p>

          <div className="fm">
            <label>
              <span>在途分段</span>
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
              >
                <option value="materials">{STAGE_LABEL.materials}</option>
                <option value="finished">{STAGE_LABEL.finished}</option>
              </select>
            </label>

            {finishedStage ? (
              <label>
                <span>去向</span>
                <select
                  aria-label="在途去向"
                  value={draft.transitTo}
                  disabled={busy}
                  onChange={(event) => onChange({ transitTo: event.target.value as TransitTo })}
                >
                  <option value="warehouse">{TRANSIT_LABEL.warehouse}</option>
                  <option value="customer">{TRANSIT_LABEL.customer}</option>
                </select>
              </label>
            ) : (
              /**
               * 料段不给下拉：方向由单据上的加工厂唯一决定。只读展示是为了让人确认
               * 「料是送到这家」，而不是给一个能改的方向（改了与单据头冲突）。
               */
              <label>
                <span>去向</span>
                <p className="fm-readonly" aria-label="料段去向">
                  加工厂 · {processorName}
                </p>
              </label>
            )}
          </div>

          {finishedStage && (
            <>
              <div className="fm">
                <label>
                  <span>损耗量（成品段必填）</span>
                  <input
                    aria-label="损耗量"
                    inputMode="decimal"
                    value={draft.lossQty}
                    disabled={busy}
                    onChange={(event) => onChange({ lossQty: event.target.value })}
                  />
                </label>

                <label>
                  <span>损失保管人（选填）</span>
                  <select
                    aria-label="损失保管人"
                    value={draft.custodianId}
                    disabled={busy || custodians.length === 0}
                    onChange={(event) => onChange({ custodianId: event.target.value })}
                  >
                    <option value="">{custodians.length === 0 ? '（无人员可选）' : '不指定'}</option>
                    {custodians.map((custodian) => (
                      <option key={custodian.id} value={custodian.id}>
                        {custodian.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label>
                <input
                  type="checkbox"
                  aria-label="确认全损耗"
                  checked={draft.confirmFullLoss}
                  disabled={busy}
                  onChange={(event) => onChange({ confirmFullLoss: event.target.checked })}
                />{' '}
                确认全损耗（不生成产出批次，材料与加工费全额记损失）
              </label>
            </>
          )}

          {finishedStage && custodiansError && (
            <p className="alert alert-warn alert-sm">{custodiansError}</p>
          )}

          {errors.length > 0 && (
            <ul className="alert alert-bad alert-sm">
              {errors.map((message) => (
                <li key={message}>· {message}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="sheet-f">
          <button type="button" onClick={onClose} disabled={busy} className="btn">
            取消
          </button>
          <button type="button" onClick={onSubmit} disabled={busy} className="btn btn-primary">
            {busy ? '提交中…' : '确认发货'}
          </button>
        </div>
      </section>
    </div>
  );
}
