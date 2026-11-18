/**
 * 采购单 A 页面（`/purchase-orders`，22 页 IA 第 3 页）。
 *
 * 视觉与字段对齐 `prototype.html` 的 `pages.a`：单号 / 供应商 / 物料 / 数量 / 货款 / 状态 / 经手，
 * 上面一条「新建采购单」工具条，金额列受「看价」权限控制（D27 / D79）。
 *
 * 与原型不同的地方，都是本批接口口径决定的：
 * - 原型里「审核」按钮本批没有对应端点（采购单没有审批状态机），不画假按钮；
 * - 「完成」已接入（D94 起权限是 `purchase.approve`，不再是 `update`）：服务端为每行创建
 *   库存批次并写库存流水，再把单据置为「已完成」；取消仍是另一个动作。
 * - 明细里只有 `productId`，商品名靠主数据映射（没有 `product.read` 时降级显示短 id）。
 *
 * D94（在途）在这一页落地为三个动作（`ship-flow.ts` 里是全部口径）：
 * 发货 `purchase.ship` + 进行中 → 在途（按明细行选去向）；撤销发货 `purchase.ship` + 在途
 * （原因必填）；到货确认 `purchase.approve` + 在途 → 已完成。进行中仍可直接完成（跳过在途）。
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
import {
  DetailHead,
  DetailMetaDot,
  DocMeta,
  DocPill,
  LinesFooter,
  type DocPillTone,
} from '../../components/OrderDetailUI';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { allows, type ScopeAction } from '../../lib/access';
import { useCompanyLabel } from '../../lib/company-directory';
import { useEmployeeLabel } from '../../lib/employee-directory';
import { resolveListState } from '../../lib/list-state';
import { orderEditBlockedText } from '../../lib/order-edit-guard';
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
  isPositiveDecimal,
  multiplyDecimal,
  purchaseApi,
  purchaseQueryKeys,
  sumDecimal,
} from './purchase-api';
import { ShipDialog } from './ShipDialog';
import {
  buildShipInput,
  defaultDirections,
  receiveBlockedText,
  revokeReasonError,
  revokeShipBlockedText,
  shipBlockedText,
  validateDirections,
  type ShipDirection,
} from './ship-flow';

/**
 * 四态 → v0.13 `.st` 语义档（与 N / C 同口径，`#337`）。
 *
 * `在途` 单独给 `transit`（蓝）：它和「进行中」会同时出现在列表里，
 * 颜色一样就分不清货到底出没出门（D94 的中间态就是为这个加的）。
 */
const STATUS_TONE: Readonly<Record<PurchaseOrderStatus, DocPillTone>> = {
  进行中: 'now',
  在途: 'transit',
  已完成: 'ok',
  已取消: 'cancel',
};

const PAGE_DESCRIPTION =
  '原材料采购：选供应商、填物料与单价，费用行可含运费 / 杂费（不得为负，最低 0）。单号由服务端生成（D16）；完成时费用按明细金额占比摊入批次成本（D83）。';

interface LineDraft {
  productId: string;
  qty: string;
  unitPrice: string;
}

interface FeeDraft {
  feeName: string;
  qty: string;
  unitPrice: string;
  /** 留空则按 数量 × 单价 自动算；不得为负，最低 0（费用一律增加成本）。 */
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

/** 列表用的短时间：`11-18 15:21`。表格里塞完整年月日会把「操作」列挤出卡片。 */
function formatShortDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
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
  return <DocPill label={status} tone={STATUS_TONE[status] ?? 'cancel'} />;
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
    if (amount.length > 0 && !/^\d{1,12}(\.\d{1,6})?$/.test(amount)) {
      errors.push(`${row}：金额必须是非负数字（最多 6 位小数）`);
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
                        placeholder="可选"
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

export function DetailPanel({
  order,
  products,
  handlerLabel,
  canCancel,
  canceling,
  canComplete,
  completing,
  canUpdate,
  canViewPrice,
  canShip,
  canApprove,
  shipping,
  receiving,
  revoking,
  revokeBusy,
  revokeReason,
  revokeError,
  onClose,
  onEdit,
  onCancel,
  onComplete,
  onShip,
  onReceive,
  onStartRevoke,
  onRevokeReasonChange,
  onCancelRevoke,
  onSubmitRevoke,
}: {
  order: PurchaseOrderDetail;
  products: readonly Product[];
  /** 经手人显示名：列表不再占一列（宽度不够），改成在详情里给。 */
  handlerLabel: string;
  canCancel: boolean;
  canceling: boolean;
  canComplete: boolean;
  completing: boolean;
  canUpdate: boolean;
  canViewPrice: boolean;
  /** 发货 / 撤销发货：`purchase.ship`。 */
  canShip: boolean;
  /** 到货确认：`purchase.approve`。 */
  canApprove: boolean;
  shipping: boolean;
  receiving: boolean;
  /** 这一单正在填撤销原因（点「撤销发货」只展开输入区，不发请求）。 */
  revoking: boolean;
  revokeBusy: boolean;
  revokeReason: string;
  revokeError: string | null;
  onClose: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onComplete: () => void;
  onShip: () => void;
  onReceive: () => void;
  onStartRevoke: () => void;
  onRevokeReasonChange: (value: string) => void;
  onCancelRevoke: () => void;
  onSubmitRevoke: () => void;
}) {
  const disabledReason = cancelDisabledReason(order.cancelable.reason);
  /**
   * 详情面板的「编辑」要和列表行用同一把尺子（#261 同型缺陷）：
   * 只判状态会让人点得动，点开改完保存才 403。
   */
  const editBlocked = orderEditBlockedText({
    domain: 'purchase',
    canUpdate,
    canViewPrice,
    status: order.status,
  });
  // 三个在途动作的可点判定全在 `ship-flow.ts`（纯函数、有测试），这里只取结果渲染。
  const shipBlocked = shipBlockedText({ canShip, status: order.status });
  const revokeBlocked = revokeShipBlockedText({ canShip, status: order.status });
  const receiveBlocked = receiveBlockedText({ canApprove, status: order.status });
  /**
   * 「完成」的权限点：D94 之后是 `purchase.approve`（此前是 `update`）。
   * 顺序照旧——先权限后状态，否则没 `approve` 的人会以为换个状态就能完成。
   */
  const completeBlocked = !canComplete
    ? '当前身份没有 purchase.approve 权限（完成采购单会建批次入库，属于审批动作）'
    : order.status === '在途'
      ? '这张单在途，请点「到货确认」入库；要退回可点「撤销发货」。'
      : order.status === '进行中'
        ? null
        : `只有「进行中」的采购单能直接完成，当前是「${order.status}」`;
  return (
    <section className="card min-w-0 space-y-3 p-4">
      <DetailHead
        docLabel="采购单"
        orderNo={order.orderNo}
        pill={<StatusBadge status={order.status} />}
        meta={
          <>
            <span>{order.supplierName}</span>
            <DetailMetaDot />
            <span>开单 {formatDateTime(order.createdAt)}</span>
            <DetailMetaDot />
            <span>最近更新 {formatDateTime(order.updatedAt)}</span>
            <DetailMetaDot />
            <span>版本 {order.version}</span>
          </>
        }
        onClose={onClose}
        closeLabel="收起"
      />

      <div className="overflow-x-auto">
        <table className="w-full text-left" style={{ minWidth: '560px' }}>
          <thead>
            <tr>
              <th>商品</th>
              <th className="num">数量</th>
              <th className="num">单价</th>
              <th className="num">金额</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line, index) => (
              <tr key={`${line.productId}-${index}`} className="r-row">
                <td>{productName(products, line.productId)}</td>
                <td className="num whitespace-nowrap">{formatQty(line.qty)}</td>
                <td className="num whitespace-nowrap">{formatMoney(line.unitPrice)}</td>
                <td className="num whitespace-nowrap">{formatMoney(line.amount)}</td>
              </tr>
            ))}
          </tbody>
          <LinesFooter
            colSpan={3}
            note={`共 ${order.lines.length} 行 · 数量不跨行合计（单位可能不同）`}
            sum={formatMoney(order.goodsAmount)}
          />
        </table>
      </div>

      {order.fees.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left" style={{ minWidth: '560px' }}>
            <thead>
              <tr>
                <th>费用</th>
                <th className="num">数量</th>
                <th className="num">单价</th>
                <th className="num">金额</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {order.fees.map((fee, index) => (
                <tr key={`${fee.feeName}-${index}`} className="r-row">
                  <td>{fee.feeName}</td>
                  <td className="num whitespace-nowrap">{formatQty(fee.qty)}</td>
                  <td className="num whitespace-nowrap">{formatMoney(fee.unitPrice)}</td>
                  <td className="num whitespace-nowrap">{formatMoney(fee.amount)}</td>
                  <td style={{ color: 'var(--text-3)' }}>{fee.remark ?? '—'}</td>
                </tr>
              ))}
            </tbody>
            <LinesFooter
              colSpan={4}
              note={`共 ${order.fees.length} 行费用 · 完成时按明细金额占比摊入批次成本（D83）`}
              sum={formatMoney(order.feeAmount)}
            />
          </table>
        </div>
      )}

      <DocMeta
        columns={3}
        items={[
          { label: '供应商', value: order.supplierName },
          { label: '经手', value: handlerLabel },
          { label: '货款', mono: true, tone: 'money', value: formatMoney(order.goodsAmount) },
          { label: '费用', mono: true, value: formatMoney(order.feeAmount) },
          { label: '合计', mono: true, tone: 'money', value: formatMoney(order.totalAmount) },
          { label: '开单时间', mono: true, value: formatDateTime(order.createdAt) },
          { label: '最近更新', mono: true, value: formatDateTime(order.updatedAt) },
        ]}
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onEdit}
          disabled={editBlocked !== null}
          title={editBlocked ?? undefined}
          className="btn"
        >
          编辑
        </button>
        {/* 发货只在「进行中」出现；有权限才亮（D94 ①） */}
        {order.status === '进行中' && (
          <button
            type="button"
            onClick={onShip}
            disabled={shipBlocked !== null || shipping}
            title={shipBlocked ?? undefined}
            className="btn"
          >
            {shipping ? '发货中…' : '发货'}
          </button>
        )}
        {/* 到货确认与撤销发货只在「在途」出现（D94 ④/⑤） */}
        {order.status === '在途' && (
          <>
            <button
              type="button"
              onClick={onReceive}
              disabled={receiveBlocked !== null || receiving}
              title={receiveBlocked ?? undefined}
              className="btn btn-p"
            >
              {receiving ? '确认中…' : '到货确认'}
            </button>
            <button
              type="button"
              onClick={onStartRevoke}
              disabled={revokeBlocked !== null || revokeBusy || revoking}
              title={revokeBlocked ?? undefined}
              className="btn"
            >
              撤销发货
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onComplete}
          disabled={completeBlocked !== null || completing}
          title={completeBlocked ?? undefined}
          className="btn btn-p"
        >
          {completing ? '完成中…' : '完成采购单'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={!order.cancelable.allowed || !canCancel || canceling}
          className="btn danger"
        >
          {canceling ? '取消中…' : '取消采购单'}
        </button>
        {disabledReason && <span className="text-xs text-slate-500">{disabledReason}</span>}
        {editBlocked && <span className="text-xs text-slate-500">{editBlocked}</span>}
        {!canCancel && order.cancelable.allowed && (
          <span className="text-xs text-slate-500">当前身份无取消权限（purchase.delete）</span>
        )}
        {/*
          三个在途动作的禁用原因都要说出口，不能只挂在 title 上——
          鼠标不在按钮上时，用户只会看到「点不动」。
        */}
        {shipBlocked && order.status === '进行中' && (
          <span className="text-xs text-slate-500">{shipBlocked}</span>
        )}
        {order.status === '在途' && receiveBlocked && (
          <span className="text-xs text-slate-500">{receiveBlocked}</span>
        )}
        {order.status === '在途' && revokeBlocked && (
          <span className="text-xs text-slate-500">{revokeBlocked}</span>
        )}
        {completeBlocked && <span className="text-xs text-slate-500">{completeBlocked}</span>}
      </div>

      {revoking && (
        <div className="mt-3 space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
          <p className="text-sm font-medium text-rose-900">撤销发货</p>
          <p className="text-xs text-rose-700">
            撤销会把单据退回「进行中」，并清掉这一单的在途批次（不转司、不写库存流水）。
            已有下游占用时服务端会拒。
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-64 flex-1 text-sm">
              <span className="text-slate-600">撤销原因（必填，会记审计）</span>
              <input
                value={revokeReason}
                onChange={(event) => onRevokeReasonChange(event.target.value)}
                maxLength={200}
                placeholder="例如：供应商发错货，重新安排发货"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
              />
            </label>
            <button
              type="button"
              disabled={revokeBusy}
              onClick={onSubmitRevoke}
              className="rounded-lg bg-rose-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {revokeBusy ? '撤销中…' : '确认撤销'}
            </button>
            <button
              type="button"
              disabled={revokeBusy}
              onClick={onCancelRevoke}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 disabled:opacity-40"
            >
              取消
            </button>
          </div>
          {revokeError && <p className="text-xs text-rose-700">{revokeError}</p>}
        </div>
      )}
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

  /* -------------------------- D94 在途：发货 / 撤销 / 到货 -------------------------- */
  /** 发货弹层所在的单（点「发货」时重新取的最详情，version 与 lines 都是最新的）。 */
  const [shipTarget, setShipTarget] = useState<PurchaseOrderDetail | null>(null);
  const [shipDirections, setShipDirections] = useState<ShipDirection[]>([]);
  const [shipErrors, setShipErrors] = useState<string[]>([]);
  /** 正在填撤销原因的单 id（只展开输入区，不发请求）。 */
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: purchaseQueryKeys.products,
    queryFn: () => masterdataApi.listProducts({ limit: 200 }),
    staleTime: 5 * 60_000,
  });
  const suppliersQuery = useQuery({
    queryKey: purchaseQueryKeys.suppliers,
    queryFn: () => masterdataApi.listSuppliers({ limit: 200 }),
    staleTime: 5 * 60_000,
  });
  /**
   * 加工厂下拉（发货弹层里的「直发加工厂」）。
   * 需要 `processor.read`：没有权限时这个列表会是 403，页面必须说清楚「不是没有加工厂，
   * 是你看不到」，否则用户会以为主数据没录。
   */
  const processorsQuery = useQuery({
    queryKey: purchaseQueryKeys.processors,
    queryFn: () => masterdataApi.listProcessors({ limit: 200 }),
    staleTime: 5 * 60_000,
  });
  const products = productsQuery.data?.items ?? [];
  const suppliers = suppliersQuery.data?.items ?? [];
  const processors = processorsQuery.data?.items ?? [];
  const processorsError = processorsQuery.isError
    ? `加工厂列表读不到（需要 processor.read）：${describeWriteError(processorsQuery.error, '请稍后重试')}`
    : null;

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

  const completeOrder = useMutation({
    mutationFn: (order: PurchaseOrderDetail) => purchaseApi.complete(order.id, order.version),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    /**
     * 完成撞版本冲突（别人刚改过、或刚把这张单完成了）：
     * 把最新版本同步过来并说清楚，**不自动重提**——完成不可逆（状态单向），
     * 得让用户看清当前状态再点（D60）。
     */
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, purchaseApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '完成失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '完成'));
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

  /* ---------------------------- D94：发货 ---------------------------- */
  const shipOrder = useMutation({
    mutationFn: (input: { order: PurchaseOrderDetail; directions: readonly ShipDirection[] }) =>
      purchaseApi.ship(
        input.order.id,
        buildShipInput(input.order, input.directions),
        input.order.version,
      ),
    onSuccess: async () => {
      setActionError(null);
      setShipErrors([]);
      setShipTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    /**
     * 发货撞版本冲突（别人刚改过这张单 / 刚发过货）：**不自动重提**。
     * 行号是按 `order.lines` 的顺序算的，别人改过明细后同一行号可能已是另一个商品——
     * 拿旧行号重发等于把货发错地方（D94 ①）。关弹层、说清楚，让人重新看过再发。
     */
    onError: async (error, input) => {
      const fresh = await recoverFromStaleVersion(error, input.order.id, purchaseApi.detail);
      if (!fresh) {
        setShipErrors([describeWriteError(error, '发货失败，请稍后重试')]);
        return;
      }
      setShipTarget(null);
      setShipErrors([]);
      setStaleNotice(staleActionRetryText(fresh.version, '发货'));
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

  /* -------------------------- D94：撤销发货 -------------------------- */
  const revokeShip = useMutation({
    mutationFn: (input: { order: PurchaseOrderDetail; reason: string }) =>
      purchaseApi.revokeShip(input.order.id, input.order.version, input.reason),
    onSuccess: async () => {
      setActionError(null);
      setRevokeError(null);
      setRevokingId(null);
      setRevokeReason('');
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    onError: async (error, input) => {
      const fresh = await recoverFromStaleVersion(error, input.order.id, purchaseApi.detail);
      if (!fresh) {
        setRevokeError(describeWriteError(error, '撤销发货失败，请稍后重试'));
        return;
      }
      setRevokingId(null);
      setRevokeReason('');
      setStaleNotice(staleActionRetryText(fresh.version, '撤销发货'));
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

  /* -------------------------- D94：到货确认 -------------------------- */
  const receiveOrder = useMutation({
    mutationFn: (order: PurchaseOrderDetail) => purchaseApi.receive(order.id, order.version),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, purchaseApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '到货确认失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '到货确认'));
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

  /** 打开发货弹层：单据必须是这份**刚取回来的**详情（version 与行序都不能是列表里的旧值）。 */
  const openShipDialog = (order: PurchaseOrderDetail) => {
    const blocked = shipBlockedText({ canShip: can('ship'), status: order.status });
    if (blocked !== null) {
      setActionError(blocked);
      return;
    }
    setActionError(null);
    setShipErrors([]);
    setShipDirections(defaultDirections(order));
    setShipTarget(order);
  };

  const submitShip = () => {
    if (!shipTarget) return;
    // 直发没选加工厂的话，本地先拦一次，别等 422（服务端还会再校）
    const errors = validateDirections(shipTarget, shipDirections, {
      processorReadable: processorsError === null ? undefined : false,
    });
    setShipErrors(errors);
    if (errors.length > 0) return;
    shipOrder.mutate({ order: shipTarget, directions: shipDirections });
  };

  const startRevoke = (order: PurchaseOrderDetail) => {
    const blocked = revokeShipBlockedText({ canShip: can('ship'), status: order.status });
    if (blocked !== null) {
      setActionError(blocked);
      return;
    }
    setActionError(null);
    setRevokeError(null);
    setRevokeReason('');
    setRevokingId(order.id);
  };

  const submitRevoke = (order: PurchaseOrderDetail) => {
    if (revokingId !== order.id) return;
    const error = revokeReasonError(revokeReason);
    setRevokeError(error);
    if (error !== null) return;
    revokeShip.mutate({ order, reason: revokeReason.trim() });
  };

  const askReceive = (order: PurchaseOrderDetail) => {
    const blocked = receiveBlockedText({ canApprove: can('approve'), status: order.status });
    if (blocked !== null) {
      setActionError(blocked);
      return;
    }
    setActionError(null);
    if (
      globalThis.confirm?.(
        `确认采购单 ${order.orderNo} 的货已到？确认后按行入批次：回仓库的直接可用，直发加工厂的挂在加工厂名下。`,
      ) === false
    ) {
      return;
    }
    receiveOrder.mutate(order);
  };

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

  const askComplete = (order: PurchaseOrderDetail) => {
    setActionError(null);
    if (
      globalThis.confirm?.(
        `确认完成采购单 ${order.orderNo} 吗？完成后状态变为「已完成」，不可撤销。`,
      ) === false
    ) {
      return;
    }
    completeOrder.mutate(order);
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
  const listState = resolveListState({
    isPending: list.isPending,
    hasError: list.isError,
    isEmpty: rows.length === 0,
  });

  return (
    <section className="mx-auto max-w-7xl space-y-4">
      <div className="p-head">
        <div>
          <div className="eyebrow">采购单 A · 货到入库</div>
          <h1>采购单 A</h1>
          <p className="sub">{PAGE_DESCRIPTION}</p>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={beginCreate}
            disabled={!can('create') || companyIds.length === 0}
            className="btn-primary"
          >
            + 新建
          </button>
        </div>
      </div>

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

      {/*
        工具条：状态用 `.seg` 分段（视觉稿 `采购单A.html` 就是分段，不是下拉），
        供应商 / 公司 / 关键字仍用下拉与搜索框。四态里没有「草稿」——契约里采购单
        没有草稿态，所以分段里也不画（画了就是个永远点不出数据的按钮）。
      */}
      <div className="toolbar">
        <div className="seg" role="group" aria-label="按状态筛选">
          {(['', '进行中', '在途', '已完成', '已取消'] as const).map((value) => (
            <button
              key={value === '' ? 'all' : value}
              type="button"
              className={status === value ? 'on' : undefined}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {value === '' ? '全部状态' : value}
            </button>
          ))}
        </div>
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
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索单号、供应商名"
          aria-label="搜索单号或供应商名"
          className="search"
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

      {/*
        列表（v0.13）：容器与 tbody 挂同一个 data-state，数据行 `r-row`、
        三行状态行常驻且带 `st-tr st-*`，显隐交给 `app-v013.css`。
        分页按游标契约写「上一批 / 下一批」（ListQuery 没有 total，画页码只能靠猜）。
      */}
      <div className="card" data-state={listState}>
        <div className="overflow-x-auto">
          <table className="w-full text-left" style={{ minWidth: '920px' }}>
            <thead>
              <tr>
                <th>单号</th>
                <th>供应商</th>
                <th>物料</th>
                <th className="num">数量</th>
                <th className="num">货款</th>
                <th>状态</th>
                <th className="num">开单时间</th>
                <th />
              </tr>
            </thead>
            <tbody data-state={listState}>
              <tr className="st-tr st-loading">
                <td colSpan={8}>
                  <ListLoading label="正在加载采购单…" />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={8}>
                  <ListError
                    title="采购单加载失败"
                    error={list.error}
                    onRetry={() => void list.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={8}>
                  <ListEmpty title="暂无采购单。可调整筛选条件，或用右上角「+ 新建」开第一张。" />
                </td>
              </tr>
              {rows.map((order) => (
                <tr key={order.id} className="r-row">
                  <td className="whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setDetailId(order.id)}
                      className="font-mono text-xs underline-offset-2 hover:underline"
                    >
                      {order.orderNo}
                    </button>
                  </td>
                  <td className="whitespace-nowrap">{order.supplierName}</td>
                  <td style={{ color: 'var(--text-3)' }}>{lineSummary(order, products)}</td>
                  <td className="num whitespace-nowrap">{qtySummary(order)}</td>
                  <td className="num whitespace-nowrap">{formatMoney(order.goodsAmount)}</td>
                  <td className="whitespace-nowrap">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="num whitespace-nowrap" style={{ color: 'var(--text-3)' }}>
                    {formatShortDateTime(order.createdAt)}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setDetailId(order.id)}
                        className="btn btn-s"
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        disabled={!can('update') || !canViewPrice || order.status !== '进行中'}
                        onClick={() => void withFreshDetail(order.id, beginEdit)}
                        className="btn btn-s"
                        title={
                          orderEditBlockedText({
                            domain: 'purchase',
                            canUpdate: can('update'),
                            canViewPrice,
                            status: order.status,
                          }) ?? undefined
                        }
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={!can('delete') || order.status !== '进行中' || cancelOrder.isPending}
                        onClick={() => void withFreshDetail(order.id, askCancel)}
                        className="btn btn-s danger"
                      >
                        取消
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <span className="count">
            共 {rows.length} 条 · 第 {pageIndex + 1} 批
          </span>
          <div className="nav">
            <button
              type="button"
              className="btn btn-s"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            >
              上一批
            </button>
            <button
              type="button"
              className="btn btn-s"
              disabled={!nextCursor}
              onClick={() => {
                if (!nextCursor) return;
                setCursors((items) => [...items.slice(0, pageIndex + 1), nextCursor]);
                setPageIndex((index) => index + 1);
              }}
            >
              下一批
            </button>
          </div>
        </div>
      </div>

      {detailId !== null && (
        <>
          {detail.isPending && (
            <p className="card p-4 text-sm" style={{ color: 'var(--text-3)' }}>
              正在加载采购单详情…
            </p>
          )}
          {detail.error && (
            <p className="card p-4 text-sm" style={{ color: 'var(--danger-on-surface)' }}>
              {errorText(detail.error)}
            </p>
          )}
          {detailOrder && (
            <DetailPanel
              order={detailOrder}
              products={products}
              handlerLabel={
                detailOrder.handlerId === meData?.employeeId
                  ? (meData?.displayName ?? '本人')
                  : employeeLabel(detailOrder.handlerId)
              }
              canCancel={can('delete')}
              canceling={cancelOrder.isPending}
              canComplete={can('approve')}
              completing={completeOrder.isPending}
              canUpdate={can('update')}
              canViewPrice={canViewPrice}
              canShip={can('ship')}
              canApprove={can('approve')}
              shipping={shipOrder.isPending}
              receiving={receiveOrder.isPending}
              revoking={revokingId === detailOrder.id}
              revokeBusy={revokeShip.isPending}
              revokeReason={revokeReason}
              revokeError={revokeError}
              onClose={() => setDetailId(null)}
              onEdit={() => beginEdit(detailOrder)}
              onCancel={() => askCancel(detailOrder)}
              onComplete={() => askComplete(detailOrder)}
              onShip={() => void withFreshDetail(detailOrder.id, openShipDialog)}
              onReceive={() => askReceive(detailOrder)}
              onStartRevoke={() => startRevoke(detailOrder)}
              onRevokeReasonChange={(value) => {
                setRevokeReason(value);
                setRevokeError(null);
              }}
              onCancelRevoke={() => {
                setRevokingId(null);
                setRevokeReason('');
                setRevokeError(null);
              }}
              onSubmitRevoke={() => submitRevoke(detailOrder)}
            />
          )}
        </>
      )}

      {shipTarget && (
        <ShipDialog
          order={shipTarget}
          productLabel={(productId) => productName(products, productId)}
          processors={processors}
          processorsError={processorsError}
          directions={shipDirections}
          errors={shipErrors}
          busy={shipOrder.isPending}
          onChange={(index, patch) =>
            setShipDirections((current) =>
              current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
            )
          }
          onClose={() => {
            if (shipOrder.isPending) return;
            setShipTarget(null);
            setShipErrors([]);
          }}
          onSubmit={submitShip}
        />
      )}
    </section>
  );
}
