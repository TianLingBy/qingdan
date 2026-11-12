/**
 * 采购单 A 页面（`/purchase-orders`，22 页 IA 第 3 页）。
 *
 * 视觉与字段对齐 `prototype.html` 的 `pages.a`：单号 / 供应商 / 物料 / 数量 / 货款 / 状态 / 经手，
 * 上面一条「新建采购单」工具条，金额列受「看价」权限控制（D27 / D79）。
 *
 * 与原型不同的地方，都是本批接口口径决定的：
 * - 原型里「审核」按钮本批没有对应端点（采购单没有审批状态机），不画假按钮；
 * - 「入库 / 完成」也不做（D5 锁价依赖 inventory，等它落地），所以 A 单只有「进行中 → 已取消」；
 * - 明细里只有 `productId`，商品名靠主数据映射（没有 `product.read` 时降级显示短 id）。
 */

import type {
  Product,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderStatus,
  Supplier,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { allows, type ScopeAction } from '../../lib/access';
import { useCompanyLabel } from '../../lib/company-directory';
import { useEmployeeLabel } from '../../lib/employee-directory';
import {
  describeWriteError,
  isStaleVersionError,
  recoverFromStaleVersion,
  staleActionRetryText,
  staleUnrecoveredText,
  staleVersionRecoveredText,
} from '../../lib/write-error';
import { authApi, authKeys } from '../auth/auth-api';
import { extractIssues, masterdataApi, optionalText } from '../masterdata/masterdata-api';
import {
  EMPTY_LINES_HINT,
  MASKED_AMOUNT,
  cancelDisabledReason,
  formatMoney,
  formatQty,
  isNegativeDecimal,
  isPositiveDecimal,
  multiplyDecimal,
  purchaseApi,
  purchaseQueryKeys,
  sumDecimal,
} from './purchase-api';

const STATUS_STYLE: Readonly<Record<PurchaseOrderStatus, string>> = {
  进行中: 'bg-blue-50 text-blue-700',
  已完成: 'bg-emerald-50 text-emerald-700',
  已取消: 'bg-slate-100 text-slate-500',
};

const PAGE_DESCRIPTION =
  '原材料采购：选供应商、填物料与单价，费用行可含运费 / 杂费（负数须填备注，D39）。单号由服务端生成（D16），本批不含入库锁价（D5，随库存一起上）。';

interface LineDraft {
  productId: string;
  qty: string;
  unitPrice: string;
}

interface FeeDraft {
  feeName: string;
  qty: string;
  unitPrice: string;
  /** 留空则按 数量 × 单价 自动算；允许手填负数（供应商返利，D39）。 */
  amount: string;
  remark: string;
}

const EMPTY_LINE: LineDraft = { productId: '', qty: '', unitPrice: '' };
const EMPTY_FEE: FeeDraft = { feeName: '', qty: '1', unitPrice: '', amount: '', remark: '' };

function errorText(error: unknown): string {
  return describeWriteError(error);
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

/** 商品名映射：没有 `product.read` 时回退短 id，不假装有名字。 */
function productName(products: readonly Product[], productId: string): string {
  const hit = products.find((item) => item.id === productId);
  return hit ? hit.name : `商品 ${shortId(productId)}`;
}

function lineSummary(order: PurchaseOrder, products: readonly Product[]): string {
  const first = order.lines[0];
  if (!first) return '—';
  const name = productName(products, first.productId);
  return order.lines.length > 1 ? `${name} 等 ${order.lines.length} 项` : name;
}

function qtySummary(order: PurchaseOrder): string {
  if (order.lines.length === 0) return '—';
  return formatQty(sumDecimal(order.lines.map((line) => line.qty)));
}

function StatusBadge({ status }: { status: PurchaseOrderStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`}>{status}</span>
  );
}

function feeAmountOf(fee: FeeDraft): string {
  const manual = fee.amount.trim();
  if (manual.length > 0) return manual;
  if (isPositiveDecimal(fee.qty) && isPositiveDecimal(fee.unitPrice)) {
    return multiplyDecimal(fee.qty, fee.unitPrice);
  }
  return '0';
}

function lineAmountOf(line: LineDraft): string | null {
  if (!isPositiveDecimal(line.qty) || !isPositiveDecimal(line.unitPrice)) return null;
  return multiplyDecimal(line.qty, line.unitPrice);
}

/** 提交前的本地校验：只挡「明显错」，字段级口径仍以服务端 422 为准。 */
export function validateDraft(
  supplierId: string,
  lines: readonly LineDraft[],
  fees: readonly FeeDraft[],
): string[] {
  const errors: string[] = [];
  if (!supplierId) errors.push('请选择供应商');
  if (lines.length === 0) errors.push(EMPTY_LINES_HINT);

  lines.forEach((line, index) => {
    const row = `第 ${index + 1} 行商品`;
    if (!line.productId) errors.push(`${row}：请选择商品`);
    if (!isPositiveDecimal(line.qty)) errors.push(`${row}：数量必须是非负数字（最多 6 位小数）`);
    else if (Number(line.qty) === 0) errors.push(`${row}：数量必须大于 0`);
    if (!isPositiveDecimal(line.unitPrice)) errors.push(`${row}：单价必须是非负数字`);
  });

  fees.forEach((fee, index) => {
    const row = `第 ${index + 1} 行费用`;
    if (fee.feeName.trim().length === 0) errors.push(`${row}：请填写费用名称`);
    if (!isPositiveDecimal(fee.qty)) errors.push(`${row}：数量必须是非负数字`);
    if (!isPositiveDecimal(fee.unitPrice)) errors.push(`${row}：单价必须是非负数字`);
    const amount = fee.amount.trim();
    if (amount.length > 0 && !/^-?\d{1,12}(\.\d{1,6})?$/.test(amount)) {
      errors.push(`${row}：金额必须是数字（可为负，最多 6 位小数）`);
    } else if (isNegativeDecimal(amount) && fee.remark.trim().length === 0) {
      errors.push(`${row}：负数费用必须填写备注（D39，返利 / 对方承担运费须可追溯）`);
    }
    if (fee.remark.trim().length > 255) errors.push(`${row}：备注最多 255 字`);
  });

  return errors;
}

interface OrderFormProps {
  readonly editing: PurchaseOrderDetail | null;
  readonly companyIds: readonly string[];
  readonly suppliers: readonly Supplier[];
  readonly products: readonly Product[];
  readonly handlerName: string;
  readonly lines: readonly LineDraft[];
  readonly fees: readonly FeeDraft[];
  readonly companyId: string;
  readonly supplierId: string;
  readonly busy: boolean;
  readonly errors: readonly string[];
  readonly serverIssues: readonly { path: string; message: string }[];
  readonly onCompanyChange: (value: string) => void;
  readonly onSupplierChange: (value: string) => void;
  readonly onLineChange: (index: number, patch: Partial<LineDraft>) => void;
  readonly onAddLine: () => void;
  readonly onRemoveLine: (index: number) => void;
  readonly onFeeChange: (index: number, patch: Partial<FeeDraft>) => void;
  readonly onAddFee: () => void;
  readonly onRemoveFee: (index: number) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onCancel: () => void;
}

function OrderForm({
  editing,
  companyIds,
  suppliers,
  products,
  handlerName,
  lines,
  fees,
  companyId,
  supplierId,
  busy,
  errors,
  serverIssues,
  onCompanyChange,
  onSupplierChange,
  onLineChange,
  onAddLine,
  onRemoveLine,
  onFeeChange,
  onAddFee,
  onRemoveFee,
  onSubmit,
  onCancel,
}: OrderFormProps) {
  const companyLabel = useCompanyLabel();
  const goodsPreview = sumDecimal(
    lines.map((line) => lineAmountOf(line) ?? '0'),
  );
  const feePreview = sumDecimal(fees.map((fee) => feeAmountOf(fee)));
  const totalPreview = sumDecimal([goodsPreview, feePreview]);

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          {editing ? `编辑采购单 ${editing.orderNo}` : '新建采购单'}
        </h2>
        <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-900">
          取消
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
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
              <option key={id} value={id} title={id}>
                {companyLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">供应商</span>
          <select
            required
            value={supplierId}
            onChange={(event) => onSupplierChange(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">请选择供应商</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
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

      {(suppliers.length === 0 || products.length === 0) && (
        <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          {suppliers.length === 0 && (
            <p>还没有可选供应商：先去「主数据 → 供应商」新增，或当前身份没有 supplier.read。</p>
          )}
          {products.length === 0 && (
            <p>还没有可选商品：先去「主数据 → 商品资料」新增，或当前身份没有 product.read。</p>
          )}
        </div>
      )}

      <section className="rounded-lg border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
          <h3 className="text-sm font-medium">商品明细</h3>
          <button
            type="button"
            onClick={onAddLine}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
          >
            + 加一行
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2">商品</th>
                <th className="px-4 py-2 w-28">数量</th>
                <th className="px-4 py-2 w-32">单价</th>
                <th className="px-4 py-2 w-32">金额</th>
                <th className="px-4 py-2 w-16" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const amount = lineAmountOf(line);
                return (
                  <tr key={index} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      {products.length > 0 ? (
                        <select
                          required
                          value={line.productId}
                          onChange={(event) => onLineChange(index, { productId: event.target.value })}
                          className="w-full rounded border border-slate-300 bg-white px-2 py-1"
                        >
                          <option value="">请选择商品</option>
                          {products.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name}
                              {product.specification ? `（${product.specification}）` : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          required
                          value={line.productId}
                          onChange={(event) => onLineChange(index, { productId: event.target.value })}
                          placeholder="商品 id（无 product.read 时手填）"
                          className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                        />
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <input
                        required
                        inputMode="decimal"
                        value={line.qty}
                        onChange={(event) => onLineChange(index, { qty: event.target.value })}
                        placeholder="如 500"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        required
                        inputMode="decimal"
                        value={line.unitPrice}
                        onChange={(event) => onLineChange(index, { unitPrice: event.target.value })}
                        placeholder="如 8.6"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2 text-slate-600">{amount ? formatMoney(amount) : '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onRemoveLine(index)}
                        disabled={lines.length === 1}
                        className="text-xs text-red-700 disabled:opacity-30"
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
        <p className="px-4 pb-3 text-xs text-slate-400">
          金额 = 数量 × 单价，前端按 6 位小数定点算（D54），不用浮点。
        </p>
      </section>

      <section className="rounded-lg border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
          <h3 className="text-sm font-medium">费用明细（运费 / 杂费，可选）</h3>
          <button
            type="button"
            onClick={onAddFee}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
          >
            + 加一行
          </button>
        </div>
        {fees.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">暂无费用行。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2">费用名称</th>
                  <th className="px-4 py-2 w-24">数量</th>
                  <th className="px-4 py-2 w-28">单价</th>
                  <th className="w-32 px-4 py-2">金额（可负）</th>
                  <th className="px-4 py-2">备注</th>
                  <th className="px-4 py-2 w-16" />
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
                        placeholder="如 运费"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        inputMode="decimal"
                        value={fee.qty}
                        onChange={(event) => onFeeChange(index, { qty: event.target.value })}
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        inputMode="decimal"
                        value={fee.unitPrice}
                        onChange={(event) => onFeeChange(index, { unitPrice: event.target.value })}
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        inputMode="decimal"
                        value={fee.amount}
                        onChange={(event) => onFeeChange(index, { amount: event.target.value })}
                        placeholder={feeAmountOf({ ...fee, amount: '' })}
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        value={fee.remark}
                        onChange={(event) => onFeeChange(index, { remark: event.target.value })}
                        placeholder={isNegativeDecimal(feeAmountOf(fee)) ? '负数必填（D39）' : '可选'}
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onRemoveFee(index)}
                        className="text-xs text-red-700"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-6 rounded-lg bg-slate-50 px-4 py-3 text-sm">
        <span className="text-slate-500">
          货款 <b className="ml-1 text-slate-900">{formatMoney(goodsPreview)}</b>
        </span>
        <span className="text-slate-500">
          费用 <b className="ml-1 text-slate-900">{formatMoney(feePreview)}</b>
        </span>
        <span className="text-slate-500">
          合计 <b className="ml-1 text-slate-900">{formatMoney(totalPreview)}</b>
        </span>
      </div>

      {errors.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {serverIssues.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {serverIssues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              {issue.path ? `${issue.path}：` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <button
        type="submit"
        disabled={busy || !companyId}
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? '提交中…' : editing ? '保存修改' : '开单'}
      </button>
    </form>
  );
}

function DetailPanel({
  order,
  products,
  canCancel,
  canceling,
  onClose,
  onEdit,
  onCancel,
}: {
  order: PurchaseOrderDetail;
  products: readonly Product[];
  canCancel: boolean;
  canceling: boolean;
  onClose: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const disabledReason = cancelDisabledReason(order.cancelable.reason);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">采购单 {order.orderNo}</h2>
          <p className="mt-1 text-xs text-slate-500">
            {order.supplierName} · 开单 {formatDateTime(order.createdAt)} · 最近更新{' '}
            {formatDateTime(order.updatedAt)} · 版本 {order.version}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={order.status} />
          <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-900">
            收起
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th className="py-2">商品</th>
              <th className="py-2">数量</th>
              <th className="py-2">单价</th>
              <th className="py-2">金额</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line, index) => (
              <tr key={`${line.productId}-${index}`} className="border-b border-slate-100">
                <td className="py-2">{productName(products, line.productId)}</td>
                <td className="py-2">{formatQty(line.qty)}</td>
                <td className="py-2">{formatMoney(line.unitPrice)}</td>
                <td className="py-2">{formatMoney(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {order.fees.length > 0 && (
        <div className="mt-4 overflow-x-auto">
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
                  <td className="py-2">{formatMoney(fee.unitPrice)}</td>
                  <td className="py-2">{formatMoney(fee.amount)}</td>
                  <td className="py-2 text-slate-600">{fee.remark ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="mt-4 flex flex-wrap gap-6 rounded-lg bg-slate-50 px-4 py-3 text-sm">
        <div className="flex gap-2">
          <dt className="text-slate-500">货款</dt>
          <dd className="font-medium">{formatMoney(order.goodsAmount)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">费用</dt>
          <dd className="font-medium">{formatMoney(order.feeAmount)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">合计</dt>
          <dd className="font-medium">{formatMoney(order.totalAmount)}</dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3">
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
          {canceling ? '取消中…' : '取消采购单'}
        </button>
        {disabledReason && <span className="text-xs text-slate-500">{disabledReason}</span>}
        {!canCancel && order.cancelable.allowed && (
          <span className="text-xs text-slate-500">当前身份无取消权限（purchase.delete）</span>
        )}
      </div>
    </section>
  );
}

export function PurchaseOrdersPage() {
  const employeeLabel = useEmployeeLabel();
  const companyLabel = useCompanyLabel();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me });
  const meData = me.data;
  const can = (action: ScopeAction) => allows(meData?.scope, 'purchase', action);
  const canViewPrice = can('view_price');
  const companyIds = meData?.companyIds ?? [];

  const [companyId, setCompanyId] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [status, setStatus] = useState<'' | PurchaseOrderStatus>('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseOrderDetail | null>(null);
  const [formCompanyId, setFormCompanyId] = useState('');
  const [formSupplierId, setFormSupplierId] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);
  const [fees, setFees] = useState<FeeDraft[]>([]);
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 版本冲突后已把最新 version 接上时的提示（与红色报错互斥）。 */
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: purchaseQueryKeys.products,
    queryFn: () => masterdataApi.listProducts({ limit: 200, status: '启用' }),
    staleTime: 5 * 60_000,
  });
  const suppliersQuery = useQuery({
    queryKey: purchaseQueryKeys.suppliers,
    queryFn: () => masterdataApi.listSuppliers({ limit: 200, status: '启用' }),
    staleTime: 5 * 60_000,
  });
  const products = productsQuery.data?.items ?? [];
  const suppliers = suppliersQuery.data?.items ?? [];

  useEffect(() => {
    if (formCompanyId.length === 0 && companyIds[0]) setFormCompanyId(companyIds[0]);
  }, [companyIds, formCompanyId]);

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [companyId, supplierFilter, status, keyword]);

  const filters = useMemo(
    () => ({
      companyId: optionalText(companyId),
      supplierId: optionalText(supplierFilter),
      status: status || undefined,
      keyword: optionalText(keyword),
      cursor: cursors[pageIndex] ?? null,
    }),
    [companyId, supplierFilter, status, keyword, cursors, pageIndex],
  );

  const list = useQuery({
    queryKey: purchaseQueryKeys.list(filters),
    queryFn: () => purchaseApi.list(filters),
  });

  const detail = useQuery({
    queryKey: purchaseQueryKeys.detail(detailId),
    queryFn: () => purchaseApi.detail(detailId!),
    enabled: detailId !== null,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!meData) throw new Error('会话未就绪，请刷新后重试');
      const payloadLines = lines.map((line) => ({
        productId: line.productId.trim(),
        qty: line.qty.trim(),
        unitPrice: line.unitPrice.trim(),
        amount: multiplyDecimal(line.qty.trim(), line.unitPrice.trim()),
      }));
      const payloadFees = fees.map((fee) => ({
        feeName: fee.feeName.trim(),
        qty: fee.qty.trim(),
        unitPrice: fee.unitPrice.trim(),
        amount: feeAmountOf(fee),
        remark: optionalText(fee.remark) ?? null,
      }));

      if (editing) {
        return purchaseApi.update(
          editing.id,
          {
            supplierId: formSupplierId,
            lines: payloadLines,
            fees: payloadFees,
          },
          editing.version,
        );
      }
      return purchaseApi.create({
        companyId: formCompanyId,
        supplierId: formSupplierId,
        handlerId: meData.employeeId,
        lines: payloadLines,
        ...(payloadFees.length > 0 ? { fees: payloadFees } : {}),
      });
    },
    onSuccess: async (order) => {
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      setStaleNotice(null);
      setFormOpen(false);
      setEditing(null);
      setFormSupplierId('');
      setLines([{ ...EMPTY_LINE }]);
      setFees([]);
      setClientErrors([]);
      setDetailId(order.id);
    },
    /**
     * 版本冲突（别人先改过）：把最新 version 接回表单，用户点一次「保存修改」就能过。
     * 不自动重提——那等于拿旧内容覆盖别人的改动，得让用户先核对（D60）。
     */
    onError: async (error) => {
      if (!editing) return;
      const fresh = await recoverFromStaleVersion(error, editing.id, purchaseApi.detail);
      if (!fresh) {
        // 非 stale 的红条由 `save.error` 渲染；stale 但读不到最新版本时那条被抑制，必须在这里兜底
        if (isStaleVersionError(error)) setActionError(staleUnrecoveredText());
        return;
      }
      setEditing({ ...editing, version: fresh.version });
      setStaleNotice(staleVersionRecoveredText(fresh.version));
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

  const resetForm = () => {
    setFormOpen(false);
    setEditing(null);
    setStaleNotice(null);
    setFormSupplierId('');
    setLines([{ ...EMPTY_LINE }]);
    setFees([]);
    setClientErrors([]);
    save.reset();
  };

  const cancelOrder = useMutation({
    mutationFn: (order: PurchaseOrderDetail) => purchaseApi.cancel(order.id, order.version),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    /**
     * 取消撞版本冲突（别人刚改过、或刚把这张单取消了）：
     * 把最新版本同步过来并说清楚，**不自动重提**——取消不可逆，得让用户看清当前状态再点（D60）。
     */
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, purchaseApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '取消失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '取消'));
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

  const beginCreate = () => {
    setEditing(null);
    setFormSupplierId('');
    setLines([{ ...EMPTY_LINE }]);
    setFees([]);
    setClientErrors([]);
    save.reset();
    setFormOpen(true);
    setDetailId(null);
  };

  const beginEdit = (order: PurchaseOrderDetail) => {
    setEditing(order);
    setFormSupplierId(order.supplierId);
    // 无看价权限时单价是 null，改单会把这些行改成 0：干脆不让改（按钮已禁用，这里再兜一层）。
    setLines(
      order.lines.map((line) => ({
        productId: line.productId,
        qty: line.qty,
        unitPrice: line.unitPrice ?? '',
      })),
    );
    setFees(
      order.fees.map((fee) => ({
        feeName: fee.feeName,
        qty: fee.qty,
        unitPrice: fee.unitPrice ?? '',
        amount: fee.amount ?? '',
        remark: fee.remark ?? '',
      })),
    );
    setClientErrors([]);
    save.reset();
    setStaleNotice(null);
    setFormOpen(true);
  };

  const askCancel = (order: PurchaseOrderDetail) => {
    /**
     * 列表行的按钮只按「进行中」判断是否可点，服务端的 `cancelable` 还可能因为
     * 「已完成 / 已被别人取消 / 有下游单据」而不允许。以前这里直接 return，
     * 用户点了取消毫无反应、也不知道为什么——必须把原因说出来。
     */
    if (!order.cancelable.allowed) {
      setActionError(cancelDisabledReason(order.cancelable.reason) ?? '当前状态不能取消这张单');
      return;
    }
    setActionError(null);
    if (
      globalThis.confirm?.(`确认取消采购单 ${order.orderNo} 吗？取消后不可恢复，错账请走冲正。`) ===
      false
    ) {
      return;
    }
    cancelOrder.mutate(order);
  };

  /**
   * 取消 / 编辑都要**先取最新详情**：列表里的是旧版本，直接拿它的 version 去写会 409（D60）。
   * 这里把「取详情失败」也接住，避免 async onClick 变成静默失败。
   */
  const withFreshDetail = async (
    orderId: string,
    action: (fresh: PurchaseOrderDetail) => void,
  ): Promise<void> => {
    setActionError(null);
    try {
      const fresh = await purchaseApi.detail(orderId);
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
          <h1 className="text-2xl font-semibold tracking-tight">采购单 A</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">{PAGE_DESCRIPTION}</p>
        </div>
        <button
          type="button"
          onClick={beginCreate}
          disabled={!can('create') || companyIds.length === 0}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          新建采购单
        </button>
      </header>

      {meData && !canViewPrice && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          当前身份无「看价」权限，金额列显示为 <b>{MASKED_AMOUNT}</b>（D79）。
          服务端把金额回 <code className="font-mono">null</code>，页面不会用 0 顶替。
        </p>
      )}

      {meData && !can('create') && (
        <p className="text-xs text-slate-500">
          「新建」需要 purchase.create；当前身份只能查看（权限判定在服务端，前端只是不画按钮）。
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
              <option key={id} value={id} title={id}>
                {companyLabel(id)}
              </option>
            ))}
          </select>
        )}
        <select
          value={supplierFilter}
          onChange={(event) => setSupplierFilter(event.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部供应商</option>
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
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
          placeholder="按单号或供应商名搜索"
          className="min-w-56 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      {formOpen && (
        <OrderForm
          editing={editing}
          companyIds={companyIds}
          suppliers={suppliers}
          products={products}
          handlerName={meData?.displayName ?? '当前登录人'}
          lines={lines}
          fees={fees}
          companyId={formCompanyId}
          supplierId={formSupplierId}
          busy={save.isPending}
          errors={clientErrors}
          serverIssues={serverIssues}
          onCompanyChange={setFormCompanyId}
          onSupplierChange={setFormSupplierId}
          onLineChange={(index, patch) =>
            setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)))
          }
          onAddLine={() => setLines((current) => [...current, { ...EMPTY_LINE }])}
          onRemoveLine={(index) =>
            setLines((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current))
          }
          onFeeChange={(index, patch) =>
            setFees((current) => current.map((fee, i) => (i === index ? { ...fee, ...patch } : fee)))
          }
          onAddFee={() => setFees((current) => [...current, { ...EMPTY_FEE }])}
          onRemoveFee={(index) => setFees((current) => current.filter((_, i) => i !== index))}
          onSubmit={(event) => {
            event.preventDefault();
            const errors = validateDraft(formSupplierId, lines, fees);
            setClientErrors(errors);
            if (errors.length > 0) return;
            save.mutate();
          }}
          onCancel={resetForm}
        />
      )}

      {staleNotice && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {staleNotice}
        </p>
      )}
      {save.error && serverIssues.length === 0 && !isStaleVersionError(save.error) && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{errorText(save.error)}</p>
      )}
      {actionError && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {list.isPending ? (
          <p className="p-6 text-sm text-slate-500">正在加载采购单…</p>
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
            暂无采购单。可调整筛选条件，或用右上角「新建采购单」开第一张。
          </p>
        ) : (
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">单号</th>
                <th className="px-4 py-3">供应商</th>
                <th className="px-4 py-3">物料</th>
                <th className="px-4 py-3">数量</th>
                <th className="px-4 py-3">货款</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">经手</th>
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
                  <td className="px-4 py-3">{order.supplierName}</td>
                  <td className="px-4 py-3 text-slate-600">{lineSummary(order, products)}</td>
                  <td className="px-4 py-3">{qtySummary(order)}</td>
                  <td className="px-4 py-3">{formatMoney(order.goodsAmount)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {order.handlerId === meData?.employeeId
                      ? (meData?.displayName ?? '本人')
                      : employeeLabel(order.handlerId)}
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
                        title={!canViewPrice ? '无看价权限：看不到现价就没法改单' : undefined}
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
              正在加载采购单详情…
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
              canCancel={can('delete')}
              canceling={cancelOrder.isPending}
              onClose={() => setDetailId(null)}
              onEdit={() => beginEdit(detailOrder)}
              onCancel={() => askCancel(detailOrder)}
            />
          )}
        </>
      )}
    </section>
  );
}
