/**
 * 加工单 B 页面（`/processing-orders`，22 页 IA 第 4 页）。
 *
 * 视觉与字段对齐 `prototype.html` 的 `pages.b`：单号 / 物料 / 投入→产出 / 损耗 / 加工费 /
 * 状态 / 归属单，工具条上「新建加工单」，金额受「看价」权限控制（D27 / D79）。
 *
 * 与原型不同的地方，都是本批接口口径决定的：
 * - **「完成 / 验收」本批没有端点**（D5 锁价要生成产出批次，依赖 inventory 写能力，
 *   API 侧 `processing.order.complete` 还没登记），所以 B 单现在只能「进行中 → 已取消」，
 *   损耗量也只能等完成后才有——不画「填损耗」的假按钮；
 * - **投入量由材料行合计自动派生**（F2b：各行 `qty` 合计必须等于 `inputQty`），
 *   让人手填两个数字去对齐是故意制造 422；
 * - 材料投入要选批次，批次来自 inventory 只读端点；一个批次都没有时页面说清原因，
 *   不让人对着空气开单。
 */

import type {
  InventoryBatch,
  ProcessingOrderDetail,
  ProcessingOrderStatus,
  Product,
  Processor,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import {
  MASKED_AMOUNT,
  formatMoney,
  formatQty,
  isPositiveDecimal,
  multiplyDecimal,
  sumDecimal,
} from '../../lib/decimal';
import { authApi, authKeys } from '../auth/auth-api';
import { extractIssues, masterdataApi, optionalText } from '../masterdata/masterdata-api';
import {
  EMPTY_FEES_HINT,
  EMPTY_MATERIALS_HINT,
  isAttributionDoc,
  processingApi,
  processingQueryKeys,
} from './processing-api';

const STATUS_STYLE: Readonly<Record<ProcessingOrderStatus, string>> = {
  进行中: 'bg-blue-50 text-blue-700',
  已完成: 'bg-emerald-50 text-emerald-700',
  已取消: 'bg-slate-100 text-slate-500',
};

const PAGE_DESCRIPTION =
  '委外加工：引用本公司批次 + 辅料 + 加工费 / 运费，完成后产出新批次并按 D5 锁价；「归属单」用于全损耗（可售量 = 0）的损失归属（D35 / G2）。';

interface MaterialDraft {
  batchId: string;
  qty: string;
}

interface FeeDraft {
  feeName: string;
  qty: string;
  unitPrice: string;
  /** 留空按 数量 × 单价 自动算；B 单金额必须 ≥ 0（D39）。 */
  amount: string;
  remark: string;
}

const EMPTY_MATERIAL: MaterialDraft = { batchId: '', qty: '' };
const EMPTY_FEE: FeeDraft = { feeName: '', qty: '1', unitPrice: '', amount: '', remark: '' };

function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

function productLabel(products: readonly Product[], productId: string | null): string {
  if (productId === null) return '—（历史单未登记成品）';
  const hit = products.find((item) => item.id === productId);
  return hit ? hit.name : `商品 ${shortId(productId)}`;
}

function batchLabel(batches: readonly InventoryBatch[], batchId: string): string {
  const hit = batches.find((item) => item.id === batchId);
  return hit ? hit.batchNo : `批次 ${shortId(batchId)}`;
}

function feeAmountOf(fee: FeeDraft): string {
  const manual = fee.amount.trim();
  if (manual.length > 0) return manual;
  if (isPositiveDecimal(fee.qty) && isPositiveDecimal(fee.unitPrice)) {
    // 定点乘法：0.1 × 3 用浮点会得 0.30000000000000004（D54）。
    return multiplyDecimal(fee.qty, fee.unitPrice);
  }
  return '0';
}

function materialTotal(materials: readonly MaterialDraft[]): string {
  const valid = materials.map((row) => row.qty.trim()).filter((qty) => isPositiveDecimal(qty));
  return valid.length === 0 ? '0' : sumDecimal(valid);
}

/** 提交前的本地校验：只挡「明显错」，字段级口径仍以服务端 422 为准。 */
export function validateDraft(
  processorId: string,
  outputProductId: string,
  materials: readonly MaterialDraft[],
  fees: readonly FeeDraft[],
  auxMaterials: string,
  attributionDoc: string,
): string[] {
  const errors: string[] = [];
  if (!processorId) errors.push('请选择加工厂');
  if (!outputProductId) errors.push('请选择成品商品（完成后据此生成产出批次，#150 决策 A）');

  if (materials.length === 0) errors.push(EMPTY_MATERIALS_HINT);
  materials.forEach((row, index) => {
    const label = `第 ${index + 1} 行材料`;
    if (!row.batchId) errors.push(`${label}：请选择批次`);
    if (!isPositiveDecimal(row.qty)) errors.push(`${label}：投入数量必须是非负数字（最多 6 位小数）`);
    else if (Number(row.qty) === 0) errors.push(`${label}：投入数量必须大于 0`);
  });
  if (materials.length > 0 && materialTotal(materials) === '0' && !errors.some((e) => e.includes('数量必须大于 0'))) {
    errors.push('投入量必须大于 0');
  }

  if (fees.length === 0) errors.push(EMPTY_FEES_HINT);
  fees.forEach((fee, index) => {
    const label = `第 ${index + 1} 行费用`;
    if (fee.feeName.trim().length === 0) errors.push(`${label}：请填写费用名称`);
    if (!isPositiveDecimal(fee.qty)) errors.push(`${label}：数量必须是非负数字`);
    if (!isPositiveDecimal(fee.unitPrice)) errors.push(`${label}：单价必须是非负数字`);
    const amount = fee.amount.trim();
    if (amount.length > 0 && !/^\d{1,12}(\.\d{1,6})?$/.test(amount)) {
      errors.push(`${label}：金额必须是非负数字（D39：B 单加工费 / 运杂费不可为负）`);
    }
    if (fee.remark.trim().length > 255) errors.push(`${label}：备注最多 255 字`);
  });

  if (auxMaterials.trim().length > 500) errors.push('辅料说明最多 500 字');
  if (attributionDoc.trim().length > 0 && !isAttributionDoc(attributionDoc)) {
    errors.push('归属单只收 E / N 单号，格式如 E-0001-20261105-0001（D16 / D35）');
  }

  return errors;
}

function StatusBadge({ status }: { status: ProcessingOrderStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`}>{status}</span>
  );
}

interface OrderFormProps {
  readonly editing: ProcessingOrderDetail | null;
  readonly companyIds: readonly string[];
  readonly processors: readonly Processor[];
  readonly products: readonly Product[];
  readonly batches: readonly InventoryBatch[];
  readonly batchesError: string | null;
  readonly handlerName: string;
  readonly companyId: string;
  readonly processorId: string;
  readonly outputProductId: string;
  readonly materials: readonly MaterialDraft[];
  readonly fees: readonly FeeDraft[];
  readonly auxMaterials: string;
  readonly attributionDoc: string;
  readonly busy: boolean;
  readonly errors: readonly string[];
  readonly serverIssues: readonly { path: string; message: string }[];
  readonly onCompanyChange: (value: string) => void;
  readonly onProcessorChange: (value: string) => void;
  readonly onOutputProductChange: (value: string) => void;
  readonly onMaterialChange: (index: number, patch: Partial<MaterialDraft>) => void;
  readonly onAddMaterial: () => void;
  readonly onRemoveMaterial: (index: number) => void;
  readonly onFeeChange: (index: number, patch: Partial<FeeDraft>) => void;
  readonly onAddFee: () => void;
  readonly onRemoveFee: (index: number) => void;
  readonly onAuxMaterialsChange: (value: string) => void;
  readonly onAttributionDocChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onCancel: () => void;
}

function OrderForm({
  editing,
  companyIds,
  processors,
  products,
  batches,
  batchesError,
  handlerName,
  companyId,
  processorId,
  outputProductId,
  materials,
  fees,
  auxMaterials,
  attributionDoc,
  busy,
  errors,
  serverIssues,
  onCompanyChange,
  onProcessorChange,
  onOutputProductChange,
  onMaterialChange,
  onAddMaterial,
  onRemoveMaterial,
  onFeeChange,
  onAddFee,
  onRemoveFee,
  onAuxMaterialsChange,
  onAttributionDocChange,
  onSubmit,
  onCancel,
}: OrderFormProps) {
  const inputQty = materialTotal(materials);
  const feeTotal = sumDecimal(fees.map((fee) => feeAmountOf(fee)));

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          {editing ? `编辑加工单 ${editing.orderNo}` : '新建加工单'}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          取消
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm">
          <span className="text-slate-600">所属公司</span>
          <select
            value={companyId}
            onChange={(event) => onCompanyChange(event.target.value)}
            disabled={editing !== null}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:bg-slate-100"
          >
            {companyIds.length === 0 && <option value="">当前账号没有可用公司</option>}
            {companyIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">加工厂</span>
          <select
            required
            value={processorId}
            onChange={(event) => onProcessorChange(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">请选择加工厂</option>
            {processors.map((processor) => (
              <option key={processor.id} value={processor.id}>
                {processor.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">成品商品</span>
          <select
            required
            value={outputProductId}
            onChange={(event) => onOutputProductChange(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">请选择成品</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
                {product.specification ? `（${product.specification}）` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">经手人</span>
          <input
            readOnly
            value={handlerName}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600"
          />
        </label>
      </div>

      {(processors.length === 0 || products.length === 0 || batches.length === 0) && (
        <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          {processors.length === 0 && (
            <p>还没有可选加工厂：先去「主数据 → 加工厂档案」新增，或当前身份没有 processor.read。</p>
          )}
          {products.length === 0 && (
            <p>还没有可选商品：先去「主数据 → 商品资料」新增，或当前身份没有 product.read。</p>
          )}
          {batches.length === 0 && (
            <p>
              {batchesError ??
                '本公司还没有可用批次：批次由 A 采购单入库生成（D5 / D67），先在对应公司入库再来开加工单。'}
            </p>
          )}
        </div>
      )}

      <section className="rounded-lg border border-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium">材料投入</h3>
            <span className="text-xs text-slate-500">
              投入量合计 <b className="font-mono">{formatQty(inputQty)}</b>
              （由各行自动汇总，F2b 要求与投入量一致）
            </span>
          </div>
          <button
            type="button"
            onClick={onAddMaterial}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
          >
            + 加一行
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2">批次</th>
                <th className="px-4 py-2 w-32">投入数量</th>
                <th className="px-4 py-2 w-28">可用量</th>
                <th className="px-4 py-2 w-16" />
              </tr>
            </thead>
            <tbody>
              {materials.map((row, index) => {
                const batch = batches.find((item) => item.id === row.batchId);
                return (
                  <tr key={index} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      {batches.length > 0 ? (
                        <select
                          required
                          value={row.batchId}
                          onChange={(event) => onMaterialChange(index, { batchId: event.target.value })}
                          className="w-full rounded border border-slate-300 bg-white px-2 py-1"
                        >
                          <option value="">请选择批次</option>
                          {batches.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.batchNo}（可用 {formatQty(item.availableQty)}）
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          required
                          value={row.batchId}
                          onChange={(event) => onMaterialChange(index, { batchId: event.target.value })}
                          placeholder="批次 id（无 inventory_qty.read 时手填）"
                          className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                        />
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <input
                        required
                        inputMode="decimal"
                        value={row.qty}
                        onChange={(event) => onMaterialChange(index, { qty: event.target.value })}
                        placeholder="0"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">
                      {batch ? formatQty(batch.availableQty) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onRemoveMaterial(index)}
                        disabled={materials.length <= 1}
                        className="whitespace-nowrap text-xs text-slate-500 hover:text-red-700 disabled:opacity-30"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-200 px-4 py-2">
          <label className="block text-sm">
            <span className="text-slate-600">辅料（选填，默认我方采购，进成本）</span>
            <input
              value={auxMaterials}
              onChange={(event) => onAuxMaterialsChange(event.target.value)}
              placeholder="如：包装膜 20 卷、胶水 5 桶"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium">费用明细</h3>
            <span className="text-xs text-slate-500">
              加工费 / 运杂费，金额必须 ≥ 0（D39）；合计{' '}
              <b className="font-mono">{formatMoney(feeTotal)}</b>
            </span>
          </div>
          <button
            type="button"
            onClick={onAddFee}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
          >
            + 加一行
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2">费用名称</th>
                <th className="px-4 py-2 w-24">数量</th>
                <th className="px-4 py-2 w-28">单价</th>
                <th className="px-4 py-2 w-28">金额</th>
                <th className="px-4 py-2">备注</th>
                <th className="px-4 py-2 w-12" />
              </tr>
            </thead>
            <tbody>
              {fees.map((fee, index) => (
                <tr key={index} className="border-t border-slate-100">
                  <td className="px-4 py-2">
                    <input
                      required
                      value={fee.feeName}
                      onChange={(event) => onFeeChange(index, { feeName: event.target.value })}
                      placeholder="加工费 / 运费"
                      className="w-full rounded border border-slate-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      required
                      inputMode="decimal"
                      value={fee.qty}
                      onChange={(event) => onFeeChange(index, { qty: event.target.value })}
                      className="w-full rounded border border-slate-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      required
                      inputMode="decimal"
                      value={fee.unitPrice}
                      onChange={(event) => onFeeChange(index, { unitPrice: event.target.value })}
                      className="w-full rounded border border-slate-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      value={fee.amount}
                      onChange={(event) => onFeeChange(index, { amount: event.target.value })}
                      placeholder={feeAmountOf(fee)}
                      className="w-full rounded border border-slate-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      value={fee.remark}
                      onChange={(event) => onFeeChange(index, { remark: event.target.value })}
                      maxLength={255}
                      className="w-full rounded border border-slate-300 px-2 py-1"
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onRemoveFee(index)}
                      className="whitespace-nowrap text-xs text-slate-500 hover:text-red-700"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <label className="block text-sm">
        <span className="text-slate-600">归属单（选填，全损耗时用于损失归属，D18 / D35）</span>
        <input
          value={attributionDoc}
          onChange={(event) => onAttributionDocChange(event.target.value)}
          placeholder="E-0001-20261105-0001 或 N-0001-20261105-0001"
          className="mt-1 w-full max-w-md rounded border border-slate-300 px-2 py-1 font-mono text-xs"
        />
      </label>

      {errors.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {errors.map((message) => (
            <li key={message}>· {message}</li>
          ))}
        </ul>
      )}
      {serverIssues.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {serverIssues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              · {issue.path && <code className="font-mono text-xs">{issue.path}</code>} {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? '提交中…' : editing ? '保存修改' : '开单'}
        </button>
        <span className="text-xs text-slate-500">
          单号由服务端生成（D16）；损耗量验收时一次填入，本批完成端点未落地（F3）。
        </span>
      </div>
    </form>
  );
}

interface DetailPanelProps {
  readonly order: ProcessingOrderDetail;
  readonly products: readonly Product[];
  readonly batches: readonly InventoryBatch[];
  readonly canViewPrice: boolean;
  readonly canCancel: boolean;
  readonly canceling: boolean;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onPrint: () => void;
}

function DetailPanel({
  order,
  products,
  batches,
  canViewPrice,
  canCancel,
  canceling,
  onClose,
  onEdit,
  onCancel,
  onPrint,
}: DetailPanelProps) {
  const feeTotal = sumDecimal(order.fees.map((fee) => fee.amount));
  const lossText = order.lossQty === null ? '待验收填入' : formatQty(order.lossQty);
  const sellableText =
    order.sellableQty === null ? '待验收填入' : formatQty(order.sellableQty);
  const cancelReason = order.cancelable.allowed
    ? null
    : order.cancelable.reason === 'already_completed'
      ? '单据已完成，不能取消（错账请走冲正 R / S / I）'
      : order.cancelable.reason === 'already_cancelled'
        ? '单据已取消'
        : order.cancelable.reason === 'has_downstream'
          ? '存在下游单据，需先取消下游'
          : '当前状态不可取消';

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-mono text-sm text-slate-900">{order.orderNo}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <StatusBadge status={order.status} />
            <span>{order.processorName}</span>
            <span className="text-slate-300">|</span>
            <span>成品：{productLabel(products, order.outputProductId)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          关闭
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th className="py-2">投入批次</th>
              <th className="py-2">投入数量</th>
              <th className="py-2">批次可用量</th>
            </tr>
          </thead>
          <tbody>
            {order.materialBatchIds.map((row, index) => {
              const batch = batches.find((item) => item.id === row.batchId);
              return (
                <tr key={`${row.batchId}-${index}`} className="border-b border-slate-100">
                  <td className="py-2 font-mono text-xs">{batchLabel(batches, row.batchId)}</td>
                  <td className="py-2">{formatQty(row.qty)}</td>
                  <td className="py-2 text-slate-600">
                    {batch ? formatQty(batch.availableQty) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {order.fees.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500">
              <tr>
                <th className="py-2">费用</th>
                <th className="py-2">数量</th>
                <th className="py-2">单价</th>
                <th className="py-2">金额</th>
                <th className="py-2">备注</th>
              </tr>
            </thead>
            <tbody>
              {order.fees.map((fee, index) => (
                <tr key={`${fee.feeName}-${index}`} className="border-b border-slate-100">
                  <td className="py-2">{fee.feeName}</td>
                  <td className="py-2">{formatQty(fee.qty)}</td>
                  <td className="py-2">
                    {canViewPrice ? formatMoney(fee.unitPrice) : MASKED_AMOUNT}
                  </td>
                  <td className="py-2">{canViewPrice ? formatMoney(fee.amount) : MASKED_AMOUNT}</td>
                  <td className="py-2 text-slate-600">{fee.remark ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="grid gap-x-8 gap-y-2 rounded-lg bg-slate-50 px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex gap-2">
          <dt className="text-slate-500">投入量</dt>
          <dd className="font-medium">{formatQty(order.inputQty)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">损耗量</dt>
          <dd className="font-medium">{lossText}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">可售量</dt>
          <dd className="font-medium">{sellableText}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">费用合计</dt>
          <dd className="font-medium">{canViewPrice ? formatMoney(feeTotal) : MASKED_AMOUNT}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">产出批次</dt>
          <dd className="font-medium">{order.outputBatchId ?? '完成时生成（等 inventory 落地）'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">归属单</dt>
          <dd className="font-mono text-xs">{order.attributionDoc ?? '—'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">辅料</dt>
          <dd className="font-medium">{order.auxMaterials ?? '—'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">损失记录</dt>
          <dd className="font-medium">
            {order.lossRecord
              ? `${formatQty(order.lossRecord.lossQty)} / ${formatMoney(order.lossRecord.amount)} / ${formatDateTime(order.lossRecord.recordedAt)}`
              : '—'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">开单时间</dt>
          <dd className="font-medium">{formatDateTime(order.createdAt)}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onEdit}
          disabled={order.status !== '进行中'}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          编辑
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={!order.cancelable.allowed || !canCancel || canceling}
          className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-700 disabled:opacity-40"
        >
          {canceling ? '取消中…' : '取消加工单'}
        </button>
        <button
          type="button"
          onClick={onPrint}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
        >
          打印发厂联
        </button>
        {cancelReason && <span className="text-xs text-slate-500">{cancelReason}</span>}
        {!canCancel && order.cancelable.allowed && (
          <span className="text-xs text-slate-500">当前身份无取消权限（processing.delete）</span>
        )}
      </div>
    </section>
  );
}

export function ProcessingOrdersPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me });
  const meData = me.data;
  const can = (action: string) =>
    meData?.scope.some((entry) => entry.domain === 'processing' && entry.actions.includes(action)) ??
    false;
  const canViewPrice = can('view_price');
  const companyIds = meData?.companyIds ?? [];

  const [companyId, setCompanyId] = useState('');
  const [processorFilter, setProcessorFilter] = useState('');
  const [status, setStatus] = useState<'' | ProcessingOrderStatus>('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProcessingOrderDetail | null>(null);
  const [formCompanyId, setFormCompanyId] = useState('');
  const [formProcessorId, setFormProcessorId] = useState('');
  const [formOutputProductId, setFormOutputProductId] = useState('');
  const [materials, setMaterials] = useState<MaterialDraft[]>([{ ...EMPTY_MATERIAL }]);
  const [fees, setFees] = useState<FeeDraft[]>([{ ...EMPTY_FEE }]);
  const [auxMaterials, setAuxMaterials] = useState('');
  const [attributionDoc, setAttributionDoc] = useState('');
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const printUrlRef = useRef<string | null>(null);

  const processorsQuery = useQuery({
    queryKey: processingQueryKeys.processors,
    queryFn: () => masterdataApi.listProcessors({ limit: 200, status: '启用' }),
    staleTime: 5 * 60_000,
  });
  const productsQuery = useQuery({
    queryKey: processingQueryKeys.products,
    queryFn: () => masterdataApi.listProducts({ limit: 200, status: '启用' }),
    staleTime: 5 * 60_000,
  });
  const processors = processorsQuery.data?.items ?? [];
  const products = productsQuery.data?.items ?? [];

  useEffect(() => {
    if (formCompanyId.length === 0 && companyIds[0]) setFormCompanyId(companyIds[0]);
  }, [companyIds, formCompanyId]);

  /** 批次按「表单公司」查：材料投入只能引用本公司批次（D22）。 */
  const batchesQuery = useQuery({
    queryKey: processingQueryKeys.batches(formCompanyId, ''),
    queryFn: () => processingApi.listBatches({ companyId: formCompanyId, limit: 100 }),
    enabled: formCompanyId.length > 0,
    staleTime: 60_000,
  });
  const batches = batchesQuery.data?.items ?? [];
  const batchesError = batchesQuery.error ? errorText(batchesQuery.error) : null;

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [companyId, processorFilter, status, keyword]);

  useEffect(() => {
    return () => {
      if (printUrlRef.current) URL.revokeObjectURL(printUrlRef.current);
    };
  }, []);

  const filters = useMemo(
    () => ({
      companyId: optionalText(companyId),
      processorId: optionalText(processorFilter),
      status: status || undefined,
      keyword: optionalText(keyword),
      cursor: cursors[pageIndex] ?? null,
    }),
    [companyId, processorFilter, status, keyword, cursors, pageIndex],
  );

  const list = useQuery({
    queryKey: processingQueryKeys.list(filters),
    queryFn: () => processingApi.list(filters),
  });

  const detail = useQuery({
    queryKey: processingQueryKeys.detail(detailId),
    queryFn: () => processingApi.detail(detailId!),
    enabled: detailId !== null,
  });

  /**
   * 详情里只有 `batchId`，批次号要靠批次表回填；表单没开或换了公司时
   * 手上那份批次可能不含这张单的批次，所以按「详情单所属公司」再查一次。
   */
  const detailCompanyId = detail.data?.companyId ?? '';
  const detailBatchesQuery = useQuery({
    queryKey: processingQueryKeys.batches(detailCompanyId, 'detail'),
    queryFn: () => processingApi.listBatches({ companyId: detailCompanyId, limit: 100 }),
    enabled: detailCompanyId.length > 0,
    staleTime: 60_000,
  });
  const detailBatches = useMemo(() => {
    const merged = new Map<string, InventoryBatch>();
    for (const batch of [...batches, ...(detailBatchesQuery.data?.items ?? [])]) {
      merged.set(batch.id, batch);
    }
    return [...merged.values()];
  }, [batches, detailBatchesQuery.data]);


  const resetForm = () => {
    setFormOpen(false);
    setEditing(null);
    setFormProcessorId('');
    setFormOutputProductId('');
    setMaterials([{ ...EMPTY_MATERIAL }]);
    setFees([{ ...EMPTY_FEE }]);
    setAuxMaterials('');
    setAttributionDoc('');
    setClientErrors([]);
    save.reset();
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!meData) throw new Error('会话未就绪，请刷新后重试');
      const payloadMaterials = materials.map((row) => ({
        batchId: row.batchId.trim(),
        qty: row.qty.trim(),
      }));
      const payloadFees = fees.map((fee) => ({
        feeName: fee.feeName.trim(),
        qty: fee.qty.trim(),
        unitPrice: fee.unitPrice.trim(),
        amount: feeAmountOf(fee),
        remark: optionalText(fee.remark) ?? null,
      }));
      const inputQty = materialTotal(materials);

      if (editing) {
        return processingApi.update(
          editing.id,
          {
            processorId: formProcessorId,
            outputProductId: formOutputProductId,
            materialBatchIds: payloadMaterials,
            inputQty,
            auxMaterials: optionalText(auxMaterials) ?? null,
            fees: payloadFees,
            attributionDoc: optionalText(attributionDoc) ?? null,
          },
          editing.version,
        );
      }
      return processingApi.create({
        companyId: formCompanyId,
        processorId: formProcessorId,
        outputProductId: formOutputProductId,
        handlerId: meData.employeeId,
        materialBatchIds: payloadMaterials,
        inputQty,
        auxMaterials: optionalText(auxMaterials) ?? null,
        fees: payloadFees,
        attributionDoc: optionalText(attributionDoc) ?? null,
      });
    },
    onSuccess: async (order) => {
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
      resetForm();
      setDetailId(order.id);
    },
  });

  const cancelOrder = useMutation({
    mutationFn: (order: ProcessingOrderDetail) =>
      processingApi.cancel(order.id, order.version),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
    },
  });

  const print = useMutation({
    mutationFn: (id: string) => processingApi.print(id),
    onSuccess: (doc) => {
      if (printUrlRef.current) URL.revokeObjectURL(printUrlRef.current);
      const url = URL.createObjectURL(new Blob([doc.content], { type: doc.contentType }));
      printUrlRef.current = url;
      setNotice(null);
      window.open(url, '_blank', 'noopener');
    },
    onError: (error) => setNotice(`打印失败：${errorText(error)}`),
  });

  const beginCreate = () => {
    setEditing(null);
    setFormProcessorId('');
    setFormOutputProductId('');
    setMaterials([{ ...EMPTY_MATERIAL }]);
    setFees([{ ...EMPTY_FEE }]);
    setAuxMaterials('');
    setAttributionDoc('');
    setClientErrors([]);
    save.reset();
    setFormOpen(true);
    setDetailId(null);
  };

  const beginEdit = (order: ProcessingOrderDetail) => {
    setEditing(order);
    setFormProcessorId(order.processorId);
    setFormOutputProductId(order.outputProductId ?? '');
    setMaterials(
      order.materialBatchIds.length > 0
        ? order.materialBatchIds.map((row) => ({ batchId: row.batchId, qty: row.qty }))
        : [{ ...EMPTY_MATERIAL }],
    );
    setFees(
      order.fees.length > 0
        ? order.fees.map((fee) => ({
            feeName: fee.feeName,
            qty: fee.qty,
            unitPrice: fee.unitPrice,
            amount: fee.amount,
            remark: fee.remark ?? '',
          }))
        : [{ ...EMPTY_FEE }],
    );
    setAuxMaterials(order.auxMaterials ?? '');
    setAttributionDoc(order.attributionDoc ?? '');
    setClientErrors([]);
    save.reset();
    setFormOpen(true);
  };

  const askCancel = (order: ProcessingOrderDetail) => {
    if (!order.cancelable.allowed) return;
    const message = order.outputBatchId
      ? `确认取消加工单 ${order.orderNo} 吗？已生成产出批次，取消会释放材料占用。`
      : `确认取消加工单 ${order.orderNo} 吗？取消后不可恢复，错账请走冲正。`;
    if (globalThis.confirm?.(message) === false) return;
    cancelOrder.mutate(order);
  };

  /**
   * 取消 / 编辑都要**先取最新详情**：列表里的是旧版本，直接拿它的 version 去写会 409（D60）。
   * 这里把「取详情失败」也接住，避免 async onClick 变成静默失败。
   */
  const withFreshDetail = async (
    orderId: string,
    action: (fresh: ProcessingOrderDetail) => void,
  ): Promise<void> => {
    setActionError(null);
    try {
      const fresh = await processingApi.detail(orderId);
      setDetailId(orderId);
      action(fresh);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const serverIssues = save.error instanceof ApiError ? extractIssues(save.error.details) : [];
  const rows = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  const detailOrder = detail.data;

  return (
    <section className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">加工单 B</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">{PAGE_DESCRIPTION}</p>
        </div>
        <button
          type="button"
          onClick={beginCreate}
          disabled={!can('create') || companyIds.length === 0}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          新建加工单
        </button>
      </header>

      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        本批不含「完成 / 验收」：完成时要按 D5 生成产出批次并锁价，
        依赖 inventory 的批次写入能力（<code className="font-mono">processing.order.complete</code>{' '}
        尚未登记，调用会回 501）。所以现在加工单只能「进行中 → 已取消」，
        损耗量与可售量都停在「待验收填入」——这里不画假按钮。
      </p>

      {meData && !canViewPrice && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          当前身份无「看价」权限，金额显示为 <b>{MASKED_AMOUNT}</b>（D79）。
          <span className="block text-xs">
            注意：processing 端点目前<b>没有服务端金额脱敏</b>（与采购单不同），
            页面这里只是不渲染；已在 PR 里报给主线在 API 侧补 view_price 口径。
          </span>
        </p>
      )}

      {meData && !can('create') && (
        <p className="text-xs text-slate-500">
          「新建」需要 processing.create；当前身份只能查看（权限判定在服务端，前端只是不画按钮）。
        </p>
      )}

      <div className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-4">
        {companyIds.length > 1 && (
          <select
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">全部公司</option>
            {companyIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
        <select
          value={processorFilter}
          onChange={(event) => setProcessorFilter(event.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部加工厂</option>
          {processors.map((processor) => (
            <option key={processor.id} value={processor.id}>
              {processor.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部状态</option>
          <option value="进行中">进行中</option>
          <option value="已完成">已完成</option>
          <option value="已取消">已取消</option>
        </select>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="按单号或加工厂名搜索"
          className="min-w-56 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      {formOpen && (
        <OrderForm
          editing={editing}
          companyIds={companyIds}
          processors={processors}
          products={products}
          batches={batches}
          batchesError={batchesError}
          handlerName={meData?.displayName ?? '当前登录人'}
          companyId={formCompanyId}
          processorId={formProcessorId}
          outputProductId={formOutputProductId}
          materials={materials}
          fees={fees}
          auxMaterials={auxMaterials}
          attributionDoc={attributionDoc}
          busy={save.isPending}
          errors={clientErrors}
          serverIssues={serverIssues}
          onCompanyChange={setFormCompanyId}
          onProcessorChange={setFormProcessorId}
          onOutputProductChange={setFormOutputProductId}
          onMaterialChange={(index, patch) =>
            setMaterials((current) =>
              current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
            )
          }
          onAddMaterial={() => setMaterials((current) => [...current, { ...EMPTY_MATERIAL }])}
          onRemoveMaterial={(index) =>
            setMaterials((current) =>
              current.length > 1 ? current.filter((_, i) => i !== index) : current,
            )
          }
          onFeeChange={(index, patch) =>
            setFees((current) => current.map((fee, i) => (i === index ? { ...fee, ...patch } : fee)))
          }
          onAddFee={() => setFees((current) => [...current, { ...EMPTY_FEE }])}
          onRemoveFee={(index) =>
            setFees((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current))
          }
          onAuxMaterialsChange={setAuxMaterials}
          onAttributionDocChange={setAttributionDoc}
          onSubmit={(event) => {
            event.preventDefault();
            const errors = validateDraft(
              formProcessorId,
              formOutputProductId,
              materials,
              fees,
              auxMaterials,
              attributionDoc,
            );
            setClientErrors(errors);
            if (errors.length > 0) return;
            save.mutate();
          }}
          onCancel={resetForm}
        />
      )}

      {save.error && serverIssues.length === 0 && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{errorText(save.error)}</p>
      )}
      {cancelOrder.error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{errorText(cancelOrder.error)}</p>
      )}
      {actionError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}
      {notice && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{notice}</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {list.isPending ? (
          <p className="p-6 text-sm text-slate-500">正在加载加工单…</p>
        ) : list.error ? (
          <div className="p-6">
            <p className="text-sm text-red-700">{errorText(list.error)}</p>
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm"
            >
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">
            暂无加工单。可调整筛选条件，或用右上角「新建加工单」开第一张。
          </p>
        ) : (
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">单号</th>
                <th className="px-4 py-3">加工厂</th>
                <th className="px-4 py-3">成品</th>
                <th className="px-4 py-3">投入 → 可售</th>
                <th className="px-4 py-3">损耗</th>
                <th className="px-4 py-3">费用合计</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">归属单</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order) => (
                <tr key={order.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setDetailId(order.id)}
                      className="font-mono text-xs text-slate-900 underline-offset-2 hover:underline"
                    >
                      {order.orderNo}
                    </button>
                  </td>
                  <td className="px-4 py-3">{order.processorName}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {productLabel(products, order.outputProductId)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {formatQty(order.inputQty)} →{' '}
                    {order.sellableQty === null ? '待验收' : formatQty(order.sellableQty)}
                  </td>
                  <td className="px-4 py-3">
                    {order.lossQty === null ? (
                      <span className="text-xs text-slate-400">待验收</span>
                    ) : (
                      formatQty(order.lossQty)
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {canViewPrice
                      ? formatMoney(sumDecimal(order.fees.map((fee) => fee.amount)))
                      : MASKED_AMOUNT}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {order.attributionDoc ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setDetailId(order.id)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs"
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        disabled={!can('update') || !canViewPrice || order.status !== '进行中'}
                        onClick={() => void withFreshDetail(order.id, beginEdit)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40"
                        title={!canViewPrice ? '无看价权限：看不到加工费就没法改单' : undefined}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={!can('delete') || order.status !== '进行中' || cancelOrder.isPending}
                        onClick={() => void withFreshDetail(order.id, askCancel)}
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 disabled:opacity-40"
                      >
                        取消
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={pageIndex === 0}
          onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          上一页
        </button>
        <span className="text-sm text-slate-500">第 {pageIndex + 1} 页</span>
        <button
          type="button"
          disabled={!nextCursor}
          onClick={() => {
            if (!nextCursor) return;
            setCursors((items) => [...items.slice(0, pageIndex + 1), nextCursor]);
            setPageIndex((index) => index + 1);
          }}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          下一页
        </button>
      </div>

      {detailId !== null && (
        <>
          {detail.isPending && (
            <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
              正在加载加工单详情…
            </p>
          )}
          {detail.error && (
            <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-red-700">
              {errorText(detail.error)}
            </p>
          )}
          {detailOrder && (
            <DetailPanel
              order={detailOrder}
              products={products}
              batches={detailBatches}
              canViewPrice={canViewPrice}
              canCancel={can('delete')}
              canceling={cancelOrder.isPending}
              onClose={() => setDetailId(null)}
              onEdit={() => beginEdit(detailOrder)}
              onCancel={() => askCancel(detailOrder)}
              onPrint={() => print.mutate(detailOrder.id)}
            />
          )}
        </>
      )}
    </section>
  );
}

