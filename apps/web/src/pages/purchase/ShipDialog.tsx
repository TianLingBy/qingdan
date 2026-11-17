/**
 * 采购发货弹层（D94 ①）：**按明细行**选去向，不是整单一个。
 *
 * 为什么不放在页面文件里：这一块有自己的表格与逐行状态，页面已经 1200 多行；
 * 但字段与请求都跟着采购单走，所以留在同目录，不搬去 `components/`。
 *
 * 与视觉稿的关系：本轮只做功能（#332），外观等 #337 统一按 `design/v0.13/` 重做。
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
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`采购发货 ${order.orderNo}`}
        className="mt-8 w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">发货 · {order.orderNo}</h2>
            <p className="mt-1 text-xs text-slate-500">
              {order.supplierName} · 版本 {order.version} · 发货后状态变「在途」，到货确认后才算完成。
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
          一张单可以部分回仓、部分直发加工厂（D94 ①）：<b>逐行</b>选去向，直发的那行必须选加工厂。
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500">
              <tr>
                <th className="py-2">行</th>
                <th className="py-2">商品</th>
                <th className="py-2">数量</th>
                <th className="py-2">去向</th>
                <th className="py-2">加工厂</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line, index) => {
                const direction = directions[index] ?? { transitTo: 'warehouse', processorId: '' };
                return (
                  <tr key={`${line.productId}-${index}`} className="border-b border-slate-100">
                    <td className="py-2 text-slate-500">{index + 1}</td>
                    <td className="py-2">{productLabel(line.productId)}</td>
                    <td className="py-2">{formatQty(line.qty)}</td>
                    <td className="py-2">
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
                        className="rounded border border-slate-300 px-2 py-1"
                      >
                        <option value="warehouse">{TRANSIT_LABEL.warehouse}</option>
                        <option value="processor" disabled={processorLocked}>
                          {TRANSIT_LABEL.processor}
                        </option>
                      </select>
                    </td>
                    <td className="py-2">
                      <select
                        aria-label={`第 ${index + 1} 行加工厂`}
                        value={direction.processorId}
                        disabled={busy || processorLocked || direction.transitTo !== 'processor'}
                        onChange={(event) => onChange(index, { processorId: event.target.value })}
                        className="w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-50 disabled:text-slate-400"
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

        {processorsError && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {processorsError}
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
