/**
 * 销售单 E 页面（`/sales-orders`，22 页 IA 第 5 页）。
 *
 * 视觉与字段对齐 `prototype.html` 的 `pages.e`：单号 / 客户 / 成交额 / 状态 / 经手，
 * 工具条上「新建销售单」，金额受「看价」权限控制（D27 / D79）；
 * 详情按 D24 内嵌「收款记录」块（退款是负数行，块内余额服务端算）。
 *
 * 与原型不同的地方，都是本批接口口径决定的：
 * - **商品行必须引用批次**（D22）：一行可引多批次，完成时按行内批次均分扣减（D72）；
 *   所以批次不是「附加信息」，是开单的硬门槛——没批次就没法出售；
 * - **售价低于加权平均批次成本会被服务端 422**（D20）：本批没有审批端点，
 *   页面如实展示服务端回的 `costFloor`，**不画「提交审批」的假按钮**；
 * - **完成会扣库存并生成 C 单草稿**（D72 / D19）：按钮带二次确认，不让人误点；
 * - 无看价权限时金额一律 `—`（D79），并且禁用「编辑」与「追加收款」——
 *   看不到原单价就改单、看不到金额就录收款，都会把钱账改错。
 */

import type {
  Customer,
  InventoryBatch,
  Product,
  SalesOrderDetail,
  SalesOrderStatus,
  SalesReceiptDirection,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { allows, type ScopeAction } from '../../lib/access';
import { useCompanyLabel } from '../../lib/company-directory';
import { useEmployeeLabel } from '../../lib/employee-directory';
import {
  describeWriteError,
  isStaleVersionError,
  recoverFromStaleVersion,
  staleActionRetryText,
  staleVersionRecoveredText,
} from '../../lib/write-error';
import {
  MASKED_AMOUNT,
  cancelDisabledReason,
  formatMoney,
  formatQty,
  isPositiveNonZeroDecimal,
  sumDecimal,
} from '../../lib/decimal';
import { authApi, authKeys } from '../auth/auth-api';
import { extractIssues, masterdataApi, optionalText } from '../masterdata/masterdata-api';
import {
  RECEIPT_METHODS,
  batchOptionLabel,
  feeAmountOf,
  lineAmountOf,
  nowLocalInput,
  orderTotalOf,
  receiptAmountText,
  salesApi,
  salesQueryKeys,
  signedReceiptAmount,
  sumNullable,
  toIsoDateTime,
  validateDraft,
  type SalesFeeDraft,
  type SalesLineDraft,
} from './sales-api';

const STATUS_STYLE: Readonly<Record<SalesOrderStatus, string>> = {
  进行中: 'bg-blue-50 text-blue-700',
  已完成: 'bg-emerald-50 text-emerald-700',
  已取消: 'bg-slate-100 text-slate-500',
};

const PAGE_DESCRIPTION =
  '选 A / B 批次出售，售价随单据；破下限需 platform 审批（D20）；费用行 ≥ 0（D39）；「已完成」= 货已发出并生成结算单草稿，不等于已结算（D19 / D72）。';

const EMPTY_LINE: SalesLineDraft = { productId: '', batchIds: [], qty: '', unitPrice: '' };
const EMPTY_FEE: SalesFeeDraft = {
  feeName: '',
  qty: '1',
  unitPrice: '',
  amount: '',
  remark: '',
};

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

function productLabel(products: readonly Product[], productId: string): string {
  const hit = products.find((item) => item.id === productId);
  return hit ? hit.name : `商品 ${shortId(productId)}`;
}

function batchLabel(batches: readonly InventoryBatch[], batchId: string): string {
  const hit = batches.find((item) => item.id === batchId);
  return hit ? hit.batchNo : `批次 ${shortId(batchId)}`;
}

function totalLineQty(lines: readonly { readonly qty: string }[]): string {
  return lines.length === 0 ? '0' : sumDecimal(lines.map((line) => line.qty));
}

function StatusBadge({ status }: { status: SalesOrderStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`}>{status}</span>
  );
}

// ============================ 开单 / 改单表单 ============================

interface OrderFormProps {
  readonly editing: SalesOrderDetail | null;
  readonly companyIds: readonly string[];
  readonly customers: readonly Customer[];
  readonly customersError: string | null;
  readonly products: readonly Product[];
  readonly batches: readonly InventoryBatch[];
  readonly batchesError: string | null;
  readonly handlerName: string;
  readonly companyId: string;
  readonly customerId: string;
  readonly lines: readonly SalesLineDraft[];
  readonly fees: readonly SalesFeeDraft[];
  readonly busy: boolean;
  readonly errors: readonly string[];
  readonly serverIssues: readonly { path: string; message: string }[];
  readonly onCompanyChange: (value: string) => void;
  readonly onCustomerChange: (value: string) => void;
  readonly onLineChange: (index: number, patch: Partial<SalesLineDraft>) => void;
  readonly onAddLine: () => void;
  readonly onRemoveLine: (index: number) => void;
  readonly onFeeChange: (index: number, patch: Partial<SalesFeeDraft>) => void;
  readonly onAddFee: () => void;
  readonly onRemoveFee: (index: number) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onCancel: () => void;
}

function OrderForm({
  editing,
  companyIds,
  customers,
  customersError,
  products,
  batches,
  batchesError,
  handlerName,
  companyId,
  customerId,
  lines,
  fees,
  busy,
  errors,
  serverIssues,
  onCompanyChange,
  onCustomerChange,
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
  const lineTotal = sumDecimal(lines.map((line) => lineAmountOf(line)));
  const feeTotal = sumDecimal(fees.map((fee) => feeAmountOf(fee)));
  const total = orderTotalOf(lines, fees);

  const batchesOf = (productId: string) =>
    batches.filter((batch) => batch.productId === productId);

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          {editing ? `编辑销售单 ${editing.orderNo}` : '新建销售单'}
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
              <option key={id} value={id} title={id}>
                {companyLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">客户</span>
          <select
            required
            value={customerId}
            onChange={(event) => onCustomerChange(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">请选择客户</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
            {customerId.length > 0 && !customers.some((item) => item.id === customerId) && (
              <option value={customerId}>{`客户 ${shortId(customerId)}（已停用或不可见）`}</option>
            )}
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
        <div className="text-sm">
          <span className="text-slate-600">单据合计（预览）</span>
          <p className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono">
            {formatMoney(total)}
          </p>
        </div>
      </div>

      {(customers.length === 0 || products.length === 0 || batches.length === 0) && (
        <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          {customers.length === 0 && (
            <p>
              {customersError ??
                '本公司还没有可选客户：先去「主数据 → 客户」新增，或当前身份没有 customer.read。'}
            </p>
          )}
          {products.length === 0 && (
            <p>还没有可选商品：先去「主数据 → 商品资料」新增，或当前身份没有 product.read。</p>
          )}
          {batches.length === 0 && (
            <p>
              {batchesError ??
                '本公司还没有可用批次：批次由 A 采购单入库 / B 加工单产出生成（D5 / D67），先有批次才能出售。'}
            </p>
          )}
        </div>
      )}

      <section className="rounded-lg border border-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium">商品明细</h3>
            <span className="text-xs text-slate-500">
              行合计 <b className="font-mono">{formatMoney(lineTotal)}</b>
              （数量 × 单价，定点计算，D54）
            </span>
          </div>
          <button
            type="button"
            onClick={onAddLine}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
          >
            + 加一行
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2">商品</th>
                <th className="px-4 py-2 w-28">数量</th>
                <th className="px-4 py-2 w-32">单价（售价）</th>
                <th className="px-4 py-2 w-32">金额</th>
                <th className="px-4 py-2">引用批次（D22，至少 1 个）</th>
                <th className="px-4 py-2 w-16" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const candidates = batchesOf(line.productId);
                const available = candidates.filter(
                  (batch) => !line.batchIds.includes(batch.id),
                );
                return (
                  <tr key={index} className="border-t border-slate-100 align-top">
                    <td className="px-4 py-2">
                      <select
                        required
                        value={line.productId}
                        onChange={(event) =>
                          onLineChange(index, { productId: event.target.value, batchIds: [] })
                        }
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
                    </td>
                    <td className="px-4 py-2">
                      <input
                        required
                        inputMode="decimal"
                        value={line.qty}
                        onChange={(event) => onLineChange(index, { qty: event.target.value })}
                        placeholder="0"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        required
                        inputMode="decimal"
                        value={line.unitPrice}
                        onChange={(event) =>
                          onLineChange(index, { unitPrice: event.target.value })
                        }
                        placeholder="0"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {formatMoney(lineAmountOf(line))}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {line.batchIds.map((batchId) => (
                          <span
                            key={batchId}
                            className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                          >
                            <span className="font-mono">{batchLabel(batches, batchId)}</span>
                            <button
                              type="button"
                              aria-label={`移除批次 ${batchLabel(batches, batchId)}`}
                              onClick={() =>
                                onLineChange(index, {
                                  batchIds: line.batchIds.filter((id) => id !== batchId),
                                })
                              }
                              className="text-slate-400 hover:text-red-700"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        {line.productId.length === 0 ? (
                          <span className="text-xs text-slate-400">先选商品，再挑批次</span>
                        ) : candidates.length === 0 ? (
                          <span className="text-xs text-amber-700">
                            该商品暂无可用批次，先在 A / B 单里入库
                          </span>
                        ) : available.length === 0 ? (
                          <span className="text-xs text-slate-400">已引用全部可选批次</span>
                        ) : (
                          <select
                            value=""
                            onChange={(event) => {
                              if (!event.target.value) return;
                              onLineChange(index, {
                                batchIds: [...line.batchIds, event.target.value],
                              });
                            }}
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          >
                            <option value="">+ 添加批次</option>
                            {available.map((batch) => (
                              <option key={batch.id} value={batch.id}>
                                {batchOptionLabel(batch)}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onRemoveLine(index)}
                        disabled={lines.length <= 1}
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
        <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
          一行引用多个批次时，完成按行内批次<b>均分扣减</b>，除不尽的余量由最后一个批次承接（D72）。
          售价低于该行加权平均批次成本会被服务端拒绝（D20）——本批没有审批端点，只能先走 platform 审批。
        </p>
      </section>

      <section className="rounded-lg border border-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium">费用明细（选填）</h3>
            <span className="text-xs text-slate-500">
              运费 / 杂费，金额必须 ≥ 0（D39）；合计{' '}
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
        {fees.length === 0 ? (
          <p className="px-4 py-3 text-xs text-slate-500">没有费用行；需要时点「+ 加一行」。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
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
                        onChange={(event) =>
                          onFeeChange(index, { feeName: event.target.value })
                        }
                        placeholder="运费 / 包装费"
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
                        onChange={(event) =>
                          onFeeChange(index, { unitPrice: event.target.value })
                        }
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
        )}
      </section>

      <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm">
        商品行 <b className="font-mono">{formatMoney(lineTotal)}</b>
        <span className="mx-2 text-slate-400">+</span>
        费用 <b className="font-mono">{formatMoney(feeTotal)}</b>
        <span className="mx-2 text-slate-400">=</span>
        单据合计 <b className="font-mono">{formatMoney(total)}</b>
      </p>

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
          单号由服务端生成（D16）；开单是业务动作，AI 默认禁止（D52）。
        </span>
      </div>
    </form>
  );
}

// ============================ 收款记录块 ============================

interface ReceiptBlockProps {
  readonly orderId: string;
  readonly receipts: SalesOrderDetail['receipts'];
  readonly balance: string | null;
  readonly canViewPrice: boolean;
  readonly canAdd: boolean;
  readonly status: SalesOrderStatus;
  readonly onError: (message: string) => void;
}

function ReceiptBlock({
  orderId,
  receipts,
  balance,
  canViewPrice,
  canAdd,
  status,
  onError,
}: ReceiptBlockProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<SalesReceiptDirection>('收款');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof RECEIPT_METHODS)[number]>('线下转账');
  const [occurredAt, setOccurredAt] = useState(nowLocalInput);
  const [remark, setRemark] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      salesApi.createReceipt(orderId, {
        direction,
        amount: signedReceiptAmount(direction, amount),
        method,
        occurredAt: toIsoDateTime(occurredAt),
        remark: optionalText(remark) ?? null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: salesQueryKeys.detail(orderId) });
      await queryClient.invalidateQueries({ queryKey: ['sales-orders', 'list'] });
      setOpen(false);
      setAmount('');
      setRemark('');
      setLocalError(null);
    },
    onError: (error) => onError(describeWriteError(error, '追加收款失败，请稍后重试')),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    /**
     * D54：金额是 decimal 字符串，校验不能过 Number——`Number('0.0000001') !== 0` 会放行，
     * 但入库按 numeric(18,6) 会截成 0。`isPositiveNonZeroDecimal` 走 BigInt 定点，安全。
     */
    if (!isPositiveNonZeroDecimal(amount.trim())) {
      setLocalError('金额必须是大于 0 的数字（退款也填正数，系统按负数行追加）');
      return;
    }
    setLocalError(null);
    create.mutate();
  };

  return (
    <section className="rounded-lg border border-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium">收款记录</h3>
          <span className="text-xs text-slate-500">
            块内余额{' '}
            <b className="font-mono">{balance === null ? MASKED_AMOUNT : formatMoney(balance)}</b>
            （收款合计 − 退款合计，服务端计算，D34）
          </span>
        </div>
        {canAdd && status !== '已取消' && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
          >
            {open ? '收起' : '+ 追加收款 / 退款'}
          </button>
        )}
      </div>

      {!canViewPrice && (
        <p className="px-4 py-3 text-xs text-amber-900">
          无「看价」权限：收款金额显示为 {MASKED_AMOUNT}，也不能追加收款——
          看不到金额就录钱账，会把余额改错（D27 / D79）。
        </p>
      )}
      {canViewPrice && !canAdd && (
        <p className="px-4 py-3 text-xs text-slate-500">
          追加收款需要 sales.update；当前身份只能查看收款台账。
        </p>
      )}
      {canViewPrice && canAdd && status === '已取消' && (
        <p className="px-4 py-3 text-xs text-slate-500">已取消的销售单不可追加收款或退款。</p>
      )}

      {receipts.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500">还没有收款记录。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2">方向</th>
                <th className="px-4 py-2">金额</th>
                <th className="px-4 py-2">方式</th>
                <th className="px-4 py-2">发生时间</th>
                <th className="px-4 py-2">备注</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((receipt) => (
                <tr key={receipt.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        receipt.direction === '退款'
                          ? 'bg-amber-50 text-amber-700'
                          : 'bg-emerald-50 text-emerald-700'
                      }`}
                    >
                      {receipt.direction}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {canViewPrice && receipt.amount !== null
                      ? formatMoney(receiptAmountText(receipt.direction, receipt.amount))
                      : MASKED_AMOUNT}
                  </td>
                  <td className="px-4 py-2">{receipt.method}</td>
                  <td className="px-4 py-2 text-slate-600">{formatDateTime(receipt.occurredAt)}</td>
                  <td className="px-4 py-2 text-slate-600">{receipt.remark ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && canAdd && canViewPrice && status !== '已取消' && (
        <form onSubmit={submit} className="grid gap-3 border-t border-slate-200 px-4 py-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-sm">
            <span className="text-slate-600">方向</span>
            <select
              value={direction}
              onChange={(event) => {
                const next = event.target.value as SalesReceiptDirection;
                setDirection(next);
                setMethod(next === '退款' ? '原路退款' : '线下转账');
              }}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1"
            >
              <option value="收款">收款</option>
              <option value="退款">退款</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="text-slate-600">金额（填正数）</span>
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">方式</span>
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value as typeof method)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1"
            >
              {RECEIPT_METHODS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-slate-600">发生时间</span>
            <input
              required
              type="datetime-local"
              value={occurredAt}
              onChange={(event) => setOccurredAt(event.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">备注（选填）</span>
            <input
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
              maxLength={200}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {create.isPending ? '提交中…' : direction === '退款' ? '追加退款行' : '追加收款行'}
            </button>
            <span className="text-xs text-slate-500">
              退款只追加负数行，不改历史行（D34 / D40）；涉及钱账，AI 默认禁止（D52①）。
            </span>
            {localError && <span className="text-xs text-red-700">{localError}</span>}
          </div>
        </form>
      )}
    </section>
  );
}

// ============================ 详情面板 ============================

interface DetailPanelProps {
  readonly order: SalesOrderDetail;
  readonly products: readonly Product[];
  readonly batches: readonly InventoryBatch[];
  readonly canViewPrice: boolean;
  readonly canUpdate: boolean;
  readonly canCancel: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onComplete: () => void;
  readonly onCancel: () => void;
  readonly onPrint: () => void;
  readonly onError: (message: string) => void;
}

function DetailPanel({
  order,
  products,
  batches,
  canViewPrice,
  canUpdate,
  canCancel,
  busy,
  onClose,
  onEdit,
  onComplete,
  onCancel,
  onPrint,
  onError,
}: DetailPanelProps) {
  const employeeLabel = useEmployeeLabel();
  const lineTotal = sumNullable(order.lines.map((line) => line.amount));
  const feeTotal = sumNullable(order.fees.map((fee) => fee.amount));
  const cancelReason = cancelDisabledReason(order.cancelable.reason);

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-mono text-sm text-slate-900">{order.orderNo}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <StatusBadge status={order.status} />
            <span>{order.customerName}</span>
            <span className="text-slate-300">|</span>
            <span>经手人 {employeeLabel(order.handlerId)}</span>
            <span className="text-slate-300">|</span>
            <span>开单 {formatDateTime(order.createdAt)}</span>
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
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th className="py-2">商品</th>
              <th className="py-2">数量</th>
              <th className="py-2">单价</th>
              <th className="py-2">金额</th>
              <th className="py-2">引用批次</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line, index) => (
              <tr key={`${line.productId}-${index}`} className="border-b border-slate-100">
                <td className="py-2">{productLabel(products, line.productId)}</td>
                <td className="py-2">{formatQty(line.qty)}</td>
                <td className="py-2">{canViewPrice ? formatMoney(line.unitPrice) : MASKED_AMOUNT}</td>
                <td className="py-2">{canViewPrice ? formatMoney(line.amount) : MASKED_AMOUNT}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    {line.batchIds.map((batchId) => (
                      <span
                        key={batchId}
                        className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700"
                      >
                        {batchLabel(batches, batchId)}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
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
                  <td className="py-2">{canViewPrice ? formatMoney(fee.unitPrice) : MASKED_AMOUNT}</td>
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
          <dt className="text-slate-500">数量合计</dt>
          <dd className="font-medium">{formatQty(totalLineQty(order.lines))}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">商品合计</dt>
          <dd className="font-medium">{canViewPrice ? formatMoney(lineTotal) : MASKED_AMOUNT}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">费用合计</dt>
          <dd className="font-medium">{canViewPrice ? formatMoney(feeTotal) : MASKED_AMOUNT}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">单据合计</dt>
          <dd className="font-medium">
            {canViewPrice ? formatMoney(order.totalAmount) : MASKED_AMOUNT}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">收款余额</dt>
          <dd className="font-medium">
            {canViewPrice ? formatMoney(order.receiptBalance) : MASKED_AMOUNT}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-500">更新时间</dt>
          <dd className="font-medium">{formatDateTime(order.updatedAt)}</dd>
        </div>
      </dl>

      <ReceiptBlock
        orderId={order.id}
        receipts={order.receipts}
        balance={order.receiptBalance}
        canViewPrice={canViewPrice}
        canAdd={canUpdate}
        status={order.status}
        onError={onError}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onEdit}
          disabled={order.status !== '进行中' || !canViewPrice}
          title={!canViewPrice ? '无看价权限：看不到原单价就没法安全改单' : undefined}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          编辑
        </button>
        <button
          type="button"
          onClick={onComplete}
          disabled={order.status !== '进行中' || !canUpdate || busy}
          className="rounded border border-emerald-300 px-3 py-1.5 text-sm text-emerald-700 disabled:opacity-40"
        >
          完成销售单
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={!order.cancelable.allowed || !canCancel || busy}
          className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-700 disabled:opacity-40"
        >
          取消销售单
        </button>
        <button
          type="button"
          onClick={onPrint}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
        >
          打印客户联
        </button>
        {cancelReason && <span className="text-xs text-slate-500">{cancelReason}</span>}
        {!canCancel && order.cancelable.allowed && (
          <span className="text-xs text-slate-500">当前身份无取消权限（sales.delete）</span>
        )}
        {!canUpdate && order.status === '进行中' && (
          <span className="text-xs text-slate-500">完成需要 sales.update</span>
        )}
      </div>
      <p className="text-xs text-slate-500">
        完成会按 D72 扣减批次可用量并生成结算单 C 草稿（同事务）；已完成不可取消，错账走冲正（D21）。
      </p>
    </section>
  );
}

// ============================ 页面 ============================

export function SalesOrdersPage() {
  const companyLabel = useCompanyLabel();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me });
  const meData = me.data;
  const can = (action: ScopeAction) => allows(meData?.scope, 'sales', action);
  const canViewPrice = can('view_price');
  const companyIds = meData?.companyIds ?? [];

  const [companyId, setCompanyId] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [status, setStatus] = useState<'' | SalesOrderStatus>('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SalesOrderDetail | null>(null);
  const [formCompanyId, setFormCompanyId] = useState('');
  const [formCustomerId, setFormCustomerId] = useState('');
  const [lines, setLines] = useState<SalesLineDraft[]>([{ ...EMPTY_LINE }]);
  const [fees, setFees] = useState<SalesFeeDraft[]>([]);
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 版本冲突后已把最新 version 接上时的提示（与红色报错互斥）。 */
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const printUrlRef = useRef<string | null>(null);

  const productsQuery = useQuery({
    queryKey: salesQueryKeys.products,
    queryFn: () => masterdataApi.listProducts({ limit: 200, status: '启用' }),
    staleTime: 5 * 60_000,
  });
  const products = productsQuery.data?.items ?? [];

  /** 筛选栏的客户下拉：跟随筛选公司；未选公司时按可见公司收口（服务端）。 */
  const filterCustomersQuery = useQuery({
    queryKey: salesQueryKeys.customers(companyId, ''),
    queryFn: () => salesApi.listCustomers({ companyId: optionalText(companyId), limit: 200 }),
    staleTime: 5 * 60_000,
  });
  const filterCustomers = filterCustomersQuery.data?.items ?? [];

  /** 表单客户下拉按「表单公司」查：客户归属公司（D15）。 */
  const formCustomersQuery = useQuery({
    queryKey: salesQueryKeys.customers(formCompanyId, 'form'),
    queryFn: () => salesApi.listCustomers({ companyId: formCompanyId, limit: 200 }),
    enabled: formCompanyId.length > 0,
    staleTime: 5 * 60_000,
  });
  const formCustomers = formCustomersQuery.data?.items ?? [];
  const customersError = formCustomersQuery.error ? errorText(formCustomersQuery.error) : null;

  useEffect(() => {
    if (formCompanyId.length === 0 && companyIds[0]) setFormCompanyId(companyIds[0]);
  }, [companyIds, formCompanyId]);

  /** 批次按「表单公司」查：只能引用本公司批次（D22），商品行再按 productId 过滤。 */
  const batchesQuery = useQuery({
    queryKey: salesQueryKeys.batches(formCompanyId, ''),
    queryFn: () => salesApi.listBatches({ companyId: formCompanyId, limit: 200 }),
    enabled: formCompanyId.length > 0,
    staleTime: 60_000,
  });
  const batches = batchesQuery.data?.items ?? [];
  const batchesError = batchesQuery.error ? errorText(batchesQuery.error) : null;

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [companyId, customerFilter, status, keyword]);

  useEffect(() => {
    return () => {
      if (printUrlRef.current) URL.revokeObjectURL(printUrlRef.current);
    };
  }, []);

  const filters = useMemo(
    () => ({
      companyId: optionalText(companyId),
      customerId: optionalText(customerFilter),
      status: status || undefined,
      keyword: optionalText(keyword),
      cursor: cursors[pageIndex] ?? null,
    }),
    [companyId, customerFilter, status, keyword, cursors, pageIndex],
  );

  const list = useQuery({
    queryKey: salesQueryKeys.list(filters),
    queryFn: () => salesApi.list(filters),
  });

  const detail = useQuery({
    queryKey: salesQueryKeys.detail(detailId),
    queryFn: () => salesApi.detail(detailId!),
    enabled: detailId !== null,
  });

  /** 详情行里只有 batchId，批次号要靠批次表回填；按详情单所属公司再查一次。 */
  const detailCompanyId = detail.data?.companyId ?? '';
  const detailBatchesQuery = useQuery({
    queryKey: salesQueryKeys.batches(detailCompanyId, 'detail'),
    queryFn: () => salesApi.listBatches({ companyId: detailCompanyId, limit: 200 }),
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
    setFormCustomerId('');
    setLines([{ ...EMPTY_LINE }]);
    setFees([]);
    setClientErrors([]);
    save.reset();
    setStaleNotice(null);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!meData) throw new Error('会话未就绪，请刷新后重试');
      const payloadLines = lines.map((line) => {
        const qty = line.qty.trim();
        const unitPrice = line.unitPrice.trim();
        return {
          productId: line.productId,
          batchIds: line.batchIds,
          qty,
          unitPrice,
          amount: lineAmountOf(line),
        };
      });
      const payloadFees = fees.map((fee) => ({
        feeName: fee.feeName.trim(),
        qty: fee.qty.trim(),
        unitPrice: fee.unitPrice.trim(),
        amount: feeAmountOf(fee),
        remark: optionalText(fee.remark) ?? null,
      }));

      if (editing) {
        return salesApi.update(
          editing.id,
          {
            customerId: formCustomerId,
            lines: payloadLines,
            fees: payloadFees,
          },
          editing.version,
        );
      }
      return salesApi.create({
        companyId: formCompanyId,
        customerId: formCustomerId,
        handlerId: meData.employeeId,
        lines: payloadLines,
        fees: payloadFees,
      });
    },
    onSuccess: async (order) => {
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
      resetForm();
      setDetailId(order.id);
    },
    /**
     * 版本冲突（别人先改过）：把最新 version 接回表单，用户点一次「保存修改」就能过。
     * 不自动重提——那等于拿旧内容覆盖别人的改动，得让用户先核对（D60）。
     */
    onError: async (error) => {
      if (!editing) return;
      const fresh = await recoverFromStaleVersion(error, editing.id, salesApi.detail);
      if (!fresh) return;
      setEditing({ ...editing, version: fresh.version });
      setStaleNotice(staleVersionRecoveredText(fresh.version));
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
    },
  });

  const completeOrder = useMutation({
    mutationFn: (order: SalesOrderDetail) => salesApi.complete(order.id, order.version),
    onSuccess: async (order) => {
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
      setNotice(
        `销售单 ${order.orderNo} 已完成：已扣减批次可用量并生成结算单 C 草稿（D72）。`,
      );
    },
    /**
     * 完成撞版本冲突（别人刚改过 / 刚取消了这张单）：同步最新版本并说明当前状态。
     * **不自动重提**——完成会扣库存、生成 C 草稿，不可逆，必须让用户看清再点（D60）。
     */
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, salesApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '完成失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '完成'));
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
    },
  });

  const cancelOrder = useMutation({
    mutationFn: (order: SalesOrderDetail) => salesApi.cancel(order.id, order.version),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
    },
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, salesApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '取消失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '取消'));
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
    },
  });

  const print = useMutation({
    mutationFn: (id: string) => salesApi.print(id),
    onSuccess: (doc) => {
      if (printUrlRef.current) URL.revokeObjectURL(printUrlRef.current);
      const url = URL.createObjectURL(new Blob([doc.content], { type: doc.contentType }));
      printUrlRef.current = url;
      setNotice(null);
      window.open(url, '_blank', 'noopener');
    },
    onError: (error) => setNotice(`打印失败：${errorText(error)}`),
  });

  const exportCsv = useMutation({
    mutationFn: () => salesApi.exportCsv(filters),
    onSuccess: (doc) => {
      const url = URL.createObjectURL(new Blob([doc.content], { type: doc.contentType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = doc.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${doc.filename}（敏感读，服务端已记审计）。`);
    },
    onError: (error) => setNotice(`导出失败：${errorText(error)}`),
  });

  const beginCreate = () => {
    setEditing(null);
    setFormCustomerId('');
    setLines([{ ...EMPTY_LINE }]);
    setFees([]);
    setClientErrors([]);
    save.reset();
    setFormOpen(true);
    setDetailId(null);
  };

  const beginEdit = (order: SalesOrderDetail) => {
    setEditing(order);
    setFormCompanyId(order.companyId);
    setFormCustomerId(order.customerId);
    setLines(
      order.lines.length > 0
        ? order.lines.map((line) => ({
            productId: line.productId,
            batchIds: [...line.batchIds],
            qty: line.qty,
            // 无看价时 unitPrice 为 null（D79）；编辑按钮已禁用，这里兜底避免类型错。
            unitPrice: line.unitPrice ?? '0',
          }))
        : [{ ...EMPTY_LINE }],
    );
    setFees(
      order.fees.map((fee) => ({
        feeName: fee.feeName,
        qty: fee.qty,
        unitPrice: fee.unitPrice ?? '0',
        amount: fee.amount ?? '',
        remark: fee.remark ?? '',
      })),
    );
    setClientErrors([]);
    save.reset();
    setFormOpen(true);
  };

  /**
   * 完成 / 取消 / 编辑都要**先取最新详情**：列表里的是旧版本，
   * 直接拿它的 version 去写会 409（D60）。
   */
  const withFreshDetail = async (
    orderId: string,
    action: (fresh: SalesOrderDetail) => void,
  ): Promise<void> => {
    setActionError(null);
    try {
      const fresh = await salesApi.detail(orderId);
      setDetailId(orderId);
      action(fresh);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const askComplete = (order: SalesOrderDetail) => {
    /** 列表行按钮只按「进行中」判断，但列表可能是旧的（别人刚取消/完成了）。别静默失败。 */
    if (order.status !== '进行中') {
      setActionError(`这张单当前是「${order.status}」，不能再完成；请刷新列表查看最新状态。`);
      return;
    }
    setActionError(null);
    const message = `确认完成销售单 ${order.orderNo} 吗？\n\n完成后会：\n· 按行内批次均分扣减库存可用量（D72）\n· 同事务生成结算单 C 草稿，财务确认后才算结算（D19）\n\n完成后不可取消，错账请走冲正。`;
    if (globalThis.confirm?.(message) === false) return;
    completeOrder.mutate(order);
  };

  const askCancel = (order: SalesOrderDetail) => {
    /**
     * 列表行按钮只按「进行中」判断，服务端还可能因为「已完成 / 已被别人取消 / 有下游结算单」
     * 拒绝取消。以前这里直接 return，用户点了取消毫无反应——必须把原因说出来。
     */
    if (!order.cancelable.allowed) {
      setActionError(cancelDisabledReason(order.cancelable.reason) ?? '当前状态不能取消这张单');
      return;
    }
    setActionError(null);
    if (
      globalThis.confirm?.(`确认取消销售单 ${order.orderNo} 吗？取消后不可恢复，错账请走冲正。`) ===
      false
    ) {
      return;
    }
    cancelOrder.mutate(order);
  };

  const serverIssues = save.error instanceof ApiError ? extractIssues(save.error.details) : [];
  const rows = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  const detailOrder = detail.data;
  /** D20：破下限被拒时服务端带回 costFloor，如实展示，不自己编审批入口。 */
  const priceFloorIssue =
    save.error instanceof ApiError &&
    save.error.details !== null &&
    typeof save.error.details === 'object' &&
    'costFloor' in (save.error.details as Record<string, unknown>)
      ? (save.error.details as { lineNo?: number; costFloor?: string })
      : null;

  return (
    <section className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">销售单 E</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">{PAGE_DESCRIPTION}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => exportCsv.mutate()}
            disabled={!can('export') || exportCsv.isPending}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm disabled:opacity-40"
          >
            {exportCsv.isPending ? '导出中…' : '导出 CSV'}
          </button>
          <button
            type="button"
            onClick={beginCreate}
            disabled={!can('create') || companyIds.length === 0}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            新建销售单
          </button>
        </div>
      </header>

      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        完成 = 货已发出：扣批次可用量 + 生成结算单 C 草稿（D72）；
        「已结算」由财务在 C 单确认，不在这张单上（D19）。
        收款记录内嵌详情，退款只追加负数行，不改历史行（D24 / D34 / D40）。
      </p>

      {meData && !canViewPrice && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          当前身份无「看价」权限，金额显示为 <b>{MASKED_AMOUNT}</b>（D79）。
          此时不能编辑单据，也不能追加收款——看不到金额就改钱账，会把账面改错。
        </p>
      )}

      {meData && !can('create') && (
        <p className="text-xs text-slate-500">
          「新建」需要 sales.create；当前身份只能查看（权限判定在服务端，前端只是不画按钮）。
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
          value={customerFilter}
          onChange={(event) => setCustomerFilter(event.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部客户</option>
          {filterCustomers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
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
          placeholder="按单号或客户名搜索"
          className="min-w-56 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      {formOpen && (
        <OrderForm
          editing={editing}
          companyIds={companyIds}
          customers={formCustomers}
          customersError={customersError}
          products={products}
          batches={batches}
          batchesError={batchesError}
          handlerName={meData?.displayName ?? '当前登录人'}
          companyId={formCompanyId}
          customerId={formCustomerId}
          lines={lines}
          fees={fees}
          busy={save.isPending}
          errors={clientErrors}
          serverIssues={serverIssues}
          onCompanyChange={(value) => {
            setFormCompanyId(value);
            setFormCustomerId('');
            setLines((current) => current.map((line) => ({ ...line, batchIds: [] })));
          }}
          onCustomerChange={setFormCustomerId}
          onLineChange={(index, patch) =>
            setLines((current) =>
              current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
            )
          }
          onAddLine={() => setLines((current) => [...current, { ...EMPTY_LINE }])}
          onRemoveLine={(index) =>
            setLines((current) =>
              current.length > 1 ? current.filter((_, i) => i !== index) : current,
            )
          }
          onFeeChange={(index, patch) =>
            setFees((current) => current.map((fee, i) => (i === index ? { ...fee, ...patch } : fee)))
          }
          onAddFee={() => setFees((current) => [...current, { ...EMPTY_FEE }])}
          onRemoveFee={(index) =>
            setFees((current) => current.filter((_, i) => i !== index))
          }
          onSubmit={(event) => {
            event.preventDefault();
            const errors = validateDraft(formCustomerId, lines, fees);
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
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <p>{errorText(save.error)}</p>
          {priceFloorIssue && (
            <p className="mt-1 text-xs">
              第 {priceFloorIssue.lineNo ?? '?'} 行售价低于加权平均批次成本（下限{' '}
              {priceFloorIssue.costFloor ?? '—'}）。本批没有审批端点（D20），
              需先完成 platform 审批再重试——这里不代做审批。
            </p>
          )}
        </div>
      )}
      {completeOrder.error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          完成失败：{errorText(completeOrder.error)}
        </p>
      )}
      {actionError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}
      {notice && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{notice}</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {list.isPending ? (
          <p className="p-6 text-sm text-slate-500">正在加载销售单…</p>
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
            暂无销售单。可调整筛选条件，或用右上角「新建销售单」开第一张。
          </p>
        ) : (
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">单号</th>
                <th className="px-4 py-3">客户</th>
                <th className="px-4 py-3">数量</th>
                <th className="px-4 py-3">成交额</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">经手人</th>
                <th className="px-4 py-3">开单时间</th>
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
                  <td className="px-4 py-3">{order.customerName}</td>
                  <td className="px-4 py-3 font-mono text-xs">{formatQty(totalLineQty(order.lines))}</td>
                  <td className="px-4 py-3">
                    {canViewPrice ? formatMoney(order.totalAmount) : MASKED_AMOUNT}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {shortId(order.handlerId)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{formatDateTime(order.createdAt)}</td>
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
                        title={!canViewPrice ? '无看价权限：看不到原单价就没法安全改单' : undefined}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={!can('update') || order.status !== '进行中' || completeOrder.isPending}
                        onClick={() => void withFreshDetail(order.id, askComplete)}
                        className="rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-700 disabled:opacity-40"
                      >
                        完成
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
              正在加载销售单详情…
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
              canUpdate={can('update')}
              canCancel={can('delete')}
              busy={completeOrder.isPending || cancelOrder.isPending}
              onClose={() => setDetailId(null)}
              onEdit={() => beginEdit(detailOrder)}
              onComplete={() => askComplete(detailOrder)}
              onCancel={() => askCancel(detailOrder)}
              onPrint={() => print.mutate(detailOrder.id)}
              onError={setActionError}
            />
          )}
        </>
      )}
    </section>
  );
}
