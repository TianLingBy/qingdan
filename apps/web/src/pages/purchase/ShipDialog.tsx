/**
 * 采购发货弹层（D94 ①）：**按明细行**选去向，不是整单一个。
 *
 * 为什么不放在页面文件里：这一块有自己的表格与逐行状态，页面已经 1200 多行；
 * 但字段与请求都跟着采购单走，所以留在同目录，不搬去 `components/`。
 *
 * 与视觉稿的关系：功能是 #332，外观在 #431 第三轮按 v3.0 稿子的浮层重做
 * （`.mask-scroll` + `.sheet` 三段，表格换成 `.ln`）。
 */

import type { Processor, PurchaseOrderDetail } from '@qingdan/contracts';
import { formatQty } from '../../lib/decimal';
import { TRANSIT_LABEL, type ShipDirection, type TransitTo } from './ship-flow';

export interface ShipDialogProps {
  readonly order: PurchaseOrderDetail;
  /** 商品名映射（明细只有 `productId`，没有 `product.read` 时回退短 id）。 */
  readonly productLabel: (productId: string) => string;
  readonly processors: readonly Processor[];
  /** 加工厂列表读不到时的原因（没权限 / 请求失败）；有值就禁用「直发加工厂」。 */
  readonly processorsError: string | null;
  readonly directions: readonly ShipDirection[];
  readonly errors: readonly string[];
  readonly busy: boolean;
  readonly onChange: (index: number, patch: Partial<ShipDirection>) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}

export function ShipDialog({
  order,
  productLabel,
  processors,
  processorsError,
  directions,
  errors,
  busy,
  onChange,
  onClose,
  onSubmit,
}: ShipDialogProps) {
  const processorLocked = processorsError !== null || processors.length === 0;

  return (
    <div className="mask-scroll">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`采购发货 ${order.orderNo}`}
        className="sheet"
      >
        <div className="sheet-h">
          <div>
            <h2>发货 · {order.orderNo}</h2>
            <small>
              {order.supplierName} · 版本 {order.version} · 发货后状态变「在途」，到货确认后才算完成。
            </small>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="sheet-close">
            关闭
          </button>
        </div>

        <div className="sheet-b form-stack">
          <p className="alert alert-info alert-sm">
            一张单可以部分回仓、部分直发加工厂（D94 ①）：<b>逐行</b>选去向，直发的那行必须选加工厂。
          </p>

          <div className="ln">
            <table>
              <thead>
                <tr>
                  <th>行</th>
                  <th>商品</th>
                  <th className="num">数量</th>
                  <th>去向</th>
                  <th>加工厂</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line, index) => {
                  const direction = directions[index] ?? { transitTo: 'warehouse', processorId: '' };
                  return (
                    <tr key={`${line.productId}-${index}`}>
                      <td className="cell-muted">{index + 1}</td>
                      <td>{productLabel(line.productId)}</td>
                      <td className="num">{formatQty(line.qty)}</td>
                      <td>
                        <select
                          aria-label={`第 ${index + 1} 行去向`}
                          value={direction.transitTo}
                          disabled={busy}
                          onChange={(event) => {
                            const transitTo = event.target.value as TransitTo;
                            // 切回「回仓库」时顺手清掉加工厂：留着会让提交带上一段无用字段，
                            // 也会让人误以为这行还是直发。
                            onChange(index, {
                              transitTo,
                              processorId: transitTo === 'warehouse' ? '' : direction.processorId,
                            });
                          }}
                          className="ipt"
                        >
                          <option value="warehouse">{TRANSIT_LABEL.warehouse}</option>
                          <option value="processor" disabled={processorLocked}>
                            {TRANSIT_LABEL.processor}
                          </option>
                        </select>
                      </td>
                      <td>
                        <select
                          aria-label={`第 ${index + 1} 行加工厂`}
                          value={direction.processorId}
                          disabled={busy || processorLocked || direction.transitTo !== 'processor'}
                          onChange={(event) => onChange(index, { processorId: event.target.value })}
                          className="ipt"
                        >
                          <option value="">
                            {processorLocked
                              ? '（无加工厂可选）'
                              : direction.transitTo === 'processor'
                                ? '请选择加工厂'
                                : '—'}
                          </option>
                          {processors.map((processor) => (
                            <option key={processor.id} value={processor.id}>
                              {processor.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {processorsError && <p className="alert alert-warn alert-sm">{processorsError}</p>}

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
