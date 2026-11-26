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
import { ListPager } from '../../components/ListPager';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { SuggestHint } from '../../components/SuggestHint';
import type { SuggestCandidate } from '../../components/masterdata-suggest-api';
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
  EMPTY_NEW_SUPPLIER,
  MASKED_AMOUNT,
  buildSupplierDraft,
  cancelDisabledReason,
  formatMoney,
  formatQty,
  isPositiveDecimal,
  multiplyDecimal,
  purchaseApi,
  purchaseQueryKeys,
  sumDecimal,
  type NewSupplierFields,
  type PurchaseOrderSort,
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

/**
 * 页头说明：一字不改照抄 `design/v3.0/index.html` 的 `DOC['purchase-orders'].sub`。
 * 以前这里是自写的三行长文（选供应商、填物料、费用摊入成本…），与稿子对不上，
 * #431 重做第一轮因此被打回 —— 稿子是验收基准，不是参考意见。
 */
const PAGE_DESCRIPTION = '向供应商采购，货到入库建批次并锁定批次价（D5）。';

/**
 * 可排序表头（D95）。点一次切方向，再点换字段。
 *
 * 排序真发给服务端、不是只排当前页：一页 20 行，用户点「货款」想看的是
 * **全部单里最大的**，只排这 20 行会让最大值藏在第 3 页看不见——看起来还挺正常，
 * 比没有排序更糟。所以只有后端白名单里那三列（单号 / 货款 / 开单时间）能点，
 * 其余列表头保持纯文本，不画一个点了没反应的箭头。
 */
function SortableHead(props: {
  readonly field: PurchaseOrderSort;
  readonly current: PurchaseOrderSort;
  readonly order: 'asc' | 'desc';
  readonly onSort: (field: PurchaseOrderSort) => void;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  const active = props.current === props.field;
  const ariaSort = active ? (props.order === 'asc' ? 'ascending' : 'descending') : 'none';
  /**
   * 稿子的排序表头是「`th.so` + 伪元素画 ↕ / ↑ / ↓」（`design/v3.0/index.html` L237–238），
   * 不是表头里再嵌一个自绘按钮。这里照稿子的结构写：整格可点、可聚焦，方向由 class 表达。
   */
  const direction = active ? (props.order === 'asc' ? 'asc' : 'desc') : '';
  return (
    <th
      className={`so ${direction}${props.className ? ` ${props.className}` : ''}`.trim()}
      aria-sort={ariaSort}
      data-sort={active ? '' : undefined}
      tabIndex={0}
      onClick={() => props.onSort(props.field)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onSort(props.field);
        }
      }}
      title={`按${typeof props.children === 'string' ? props.children : '该列'}排序`}
    >
      {props.children}
    </th>
  );
}

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

/**
 * 列表「日期」列：稿子这一列只写到天（`2026-11-22`），列表不再是「开单时间 + 操作」两列。
 * 具体到分钟的创建时间仍在详情面板里，列表不重复占宽度。
 */
function formatDateOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  })
    .format(date)
    .replace(/\//g, '-');
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
  /**
   * 开单现场建档（D100）：传了它就**不再要求** `supplierId`，改为要求供应商名称。
   * 与 E 销售单同一口径 —— 这两条是互斥的同一件事，分成两个函数必然被同时调用。
   */
  newSupplier?: { readonly name: string } | null,
): string[] {
  const errors: string[] = [];
  if (newSupplier) {
    const name = newSupplier.name.trim();
    if (name === '') errors.push('新建供应商：请填写供应商名称');
    else if (name.length > 64) errors.push('新建供应商：名称最多 64 字');
  } else if (!supplierId) {
    errors.push('请选择供应商');
  }
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

/**
 * 开单现场建档的内联小表单（D100「静默建档」）。
 *
 * 对外导出是为了能在本仓不带 jsdom 的测试里静态渲染（`OrderForm` props 二十多个，
 * 为一条断言造二十个 mock 不值）。只收名称 + 联系人 + 电话：供货物料这类字段属于
 * 主数据页的事，开单现场不该顺手猜。
 */
export function NewSupplierInlineForm({
  fields,
  onChange,
  companyId,
  onPickExisting,
}: {
  readonly fields: NewSupplierFields;
  readonly onChange: (patch: Partial<NewSupplierFields>) => void;
  /** 当前单据公司：建档防重查询的必传参数（D99，漏传 422）。 */
  readonly companyId: string;
  /** 点了「已有相同供应商」的候选：调用方改回从下拉里选这条档案。 */
  readonly onPickExisting: (candidate: SuggestCandidate) => void;
}) {
  return (
    <div className="form-sec">
      <div className="form-sec-b fm c3">
        <label>
          <span>供应商名称（必填）</span>
          <input
            aria-label="新建供应商名称"
            value={fields.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <label>
          <span>联系人（选填）</span>
          <input
            aria-label="新建供应商联系人"
            value={fields.contactName}
            onChange={(event) => onChange({ contactName: event.target.value })}
          />
        </label>
        <label>
          <span>电话（选填）</span>
          <input
            aria-label="新建供应商电话"
            value={fields.contactPhone}
            onChange={(event) => onChange({ contactPhone: event.target.value })}
          />
        </label>
        {/* `.fm > .w` 横跨整行（v3.0 稿子的写法），这里放建档说明 */}
        <p className="detail-why w">
          保存单据时一起建档，不必先去主数据页。建档对你是透明的 —— 保存成功后只提示单据保存，
          不额外提示建档结果，也不需要建供应商权限（有开单权即可）。
        </p>
      </div>
    </div>
  );
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
  /** 开单现场建档（D100）：打开后供应商走草档，下拉被替换。 */
  readonly newSupplierOpen: boolean;
  readonly newSupplier: NewSupplierFields;
  readonly onNewSupplierToggle: (open: boolean) => void;
  readonly onNewSupplierChange: (patch: Partial<NewSupplierFields>) => void;
  /** 草档里打了名字、命中已有供应商：改回从下拉里选这条档案（D99）。 */
  readonly onNewSupplierPick: (candidate: SuggestCandidate) => void;
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
  newSupplierOpen,
  newSupplier,
  onNewSupplierToggle,
  onNewSupplierChange,
  onNewSupplierPick,
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
    <form onSubmit={onSubmit} className="form-card">
      <div className="form-head">
        <h2>{editing ? `编辑采购单 ${editing.orderNo}` : '新建采购单'}</h2>
        <span className="detail-why">单号由服务端生成（D16）· 金额按 6 位小数定点（D54）</span>
      </div>

      <div className="fm c3">
        <label>
          <span>所属公司</span>
          <select
            value={companyId}
            onChange={(event) => onCompanyChange(event.target.value)}
            disabled={editing !== null}
          >
            {companyIds.length === 0 && <option value="">当前账号没有可用公司</option>}
            {companyIds.map((id) => (
              <option key={id} value={id} title={id}>
                {companyLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>供应商</span>
          {newSupplierOpen ? (
            <p className="fm-readonly">
              开单时新建：
              <b className="cell-clip">
                {newSupplier.name.trim() === '' ? '在下方填名称' : newSupplier.name.trim()}
              </b>
            </p>
          ) : (
            <select
              required
              value={supplierId}
              onChange={(event) => onSupplierChange(event.target.value)}
            >
              <option value="">请选择供应商</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          )}
        </label>
        {/* 经手人 = 当前登录人，改不了；用只读块而不是输入框，免得像「填了没生效」 */}
        <label>
          <span>经手人</span>
          <p className="fm-readonly">{handlerName}</p>
        </label>
      </div>

      {/**
       * 开单现场建档（D100）：只能开单时用。改单顺带建新供应商会让「这张单原来向谁买」
       * 无从追溯，所以编辑态不提供。
       */}
      {editing === null && (
        <div className="form-stack">
          {/* `.form-add` 把按钮收回内容宽：表单是纵向 flex，不给就会拉成整条 */}
          <button
            type="button"
            onClick={() => onNewSupplierToggle(!newSupplierOpen)}
            className="btn btn-s form-add"
          >
            {newSupplierOpen ? '取消新建，改从已有供应商里选' : '+ 新建供应商'}
          </button>
          {newSupplierOpen && (
            <NewSupplierInlineForm
              fields={newSupplier}
              onChange={onNewSupplierChange}
              companyId={companyId}
              onPickExisting={onNewSupplierPick}
            />
          )}
        </div>
      )}

      {(suppliers.length === 0 || products.length === 0) && (
        <div className="alert alert-warn alert-sm">
          {suppliers.length === 0 && (
            <p>还没有可选供应商：先去「主数据 → 供应商」新增，或当前身份没有 supplier.read。</p>
          )}
          {products.length === 0 && (
            <p>还没有可选商品：先去「主数据 → 商品资料」新增，或当前身份没有 product.read。</p>
          )}
        </div>
      )}

      {/*
        商品明细从表格改成「一行商品一张卡」（v3.0 `.line-card` + `.fm lines`）：
        表格版要 640px 才不挤，窄屏得横向滚；改成卡之后 860px 以下自动落成单列。
      */}
      <div className="form-stack">
        <div className="form-head">
          <h3 className="form-title">商品明细（至少 1 行）</h3>
          <span className="detail-why">
            金额 = 数量 × 单价，前端按 6 位小数定点算（D54），不用浮点。
          </span>
        </div>

        {lines.map((line, index) => {
          const amount = lineAmountOf(line);
          return (
            <div key={index} className="line-card">
              <div className="fm lines">
                <label>
                  <span>第 {index + 1} 行商品</span>
                  {products.length > 0 ? (
                    <select
                      required
                      value={line.productId}
                      onChange={(event) => onLineChange(index, { productId: event.target.value })}
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
                      className="mono"
                    />
                  )}
                </label>
                <label>
                  <span>数量</span>
                  <input
                    required
                    inputMode="decimal"
                    value={line.qty}
                    onChange={(event) => onLineChange(index, { qty: event.target.value })}
                    placeholder="如 500"
                  />
                </label>
                <label>
                  <span>单价</span>
                  <input
                    required
                    inputMode="decimal"
                    value={line.unitPrice}
                    onChange={(event) => onLineChange(index, { unitPrice: event.target.value })}
                    placeholder="如 8.6"
                  />
                </label>
                <div className="line-amount">金额 {amount ? formatMoney(amount) : '—'}</div>
                <button
                  type="button"
                  onClick={() => onRemoveLine(index)}
                  disabled={lines.length === 1}
                  className="btn btn-row"
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}

        <button type="button" onClick={onAddLine} className="btn form-add">
          + 加一行商品
        </button>
      </div>

      <div className="form-stack">
        <div className="form-head">
          <h3 className="form-title">费用明细（运费 / 杂费，可选）</h3>
          <button type="button" onClick={onAddFee} className="btn btn-row">
            + 加一行
          </button>
        </div>
        {fees.length === 0 ? (
          <p className="form-empty">暂无费用行。</p>
        ) : (
          <div className="ln">
            <table>
              <thead>
                <tr>
                  <th>费用名称</th>
                  <th className="num">数量</th>
                  <th className="num">单价</th>
                  <th className="num">金额（可负）</th>
                  <th>备注</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {fees.map((fee, index) => (
                  <tr key={index}>
                    <td>
                      <input
                        required
                        value={fee.feeName}
                        onChange={(event) => onFeeChange(index, { feeName: event.target.value })}
                        placeholder="如 运费"
                        className="ipt"
                      />
                    </td>
                    <td>
                      <input
                        inputMode="decimal"
                        value={fee.qty}
                        onChange={(event) => onFeeChange(index, { qty: event.target.value })}
                        className="ipt"
                      />
                    </td>
                    <td>
                      <input
                        inputMode="decimal"
                        value={fee.unitPrice}
                        onChange={(event) => onFeeChange(index, { unitPrice: event.target.value })}
                        className="ipt"
                      />
                    </td>
                    <td>
                      <input
                        inputMode="decimal"
                        value={fee.amount}
                        onChange={(event) => onFeeChange(index, { amount: event.target.value })}
                        placeholder={feeAmountOf({ ...fee, amount: '' })}
                        className="ipt"
                      />
                    </td>
                    <td>
                      <input
                        value={fee.remark}
                        onChange={(event) => onFeeChange(index, { remark: event.target.value })}
                        placeholder="可选"
                        className="ipt"
                      />
                    </td>
                    <td className="row-acts">
                      <button
                        type="button"
                        onClick={() => onRemoveFee(index)}
                        className="btn btn-row"
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
      </div>

      <div className="sum-bar">
        <span>
          货款 <b>{formatMoney(goodsPreview)}</b>
        </span>
        <span>
          费用 <b>{formatMoney(feePreview)}</b>
        </span>
        <span>
          合计 <b>{formatMoney(totalPreview)}</b>
        </span>
      </div>

      {errors.length > 0 && (
        <ul className="alert alert-bad alert-sm">
          {errors.map((message) => (
            <li key={message}>· {message}</li>
          ))}
        </ul>
      )}
      {serverIssues.length > 0 && (
        <ul className="alert alert-bad alert-sm">
          {serverIssues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              · {issue.path ? `${issue.path}：` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="detail-acts">
        <button type="submit" disabled={busy || !companyId} className="btn btn-primary">
          {busy ? '提交中…' : editing ? '保存修改' : '开单'}
        </button>
        <button type="button" onClick={onCancel} className="btn">
          取消
        </button>
      </div>
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
    <section className="card detail">
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

      <div className="ln">
        <table>
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
              <tr key={`${line.productId}-${index}`}>
                <td>{productName(products, line.productId)}</td>
                <td className="num">{formatQty(line.qty)}</td>
                <td className="num">{formatMoney(line.unitPrice)}</td>
                <td className="num">{formatMoney(line.amount)}</td>
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
        <div className="ln">
          <table>
            <thead>
              <tr>
                <th>费用</th>
                <th className="num">数量</th>
                <th className="num">单价</th>
                <th>备注</th>
                <th className="num">金额</th>
              </tr>
            </thead>
            <tbody>
              {order.fees.map((fee, index) => (
                <tr key={`${fee.feeName}-${index}`}>
                  <td>{fee.feeName}</td>
                  <td className="num">{formatQty(fee.qty)}</td>
                  <td className="num">{formatMoney(fee.unitPrice)}</td>
                  <td className="cell-muted">{fee.remark ?? '—'}</td>
                  <td className="num">{formatMoney(fee.amount)}</td>
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

      <div className="detail-acts">
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
          className="btn danger act-end"
        >
          {canceling ? '取消中…' : '取消采购单'}
        </button>
        {disabledReason && <span className="detail-why">{disabledReason}</span>}
        {editBlocked && <span className="detail-why">{editBlocked}</span>}
        {!canCancel && order.cancelable.allowed && (
          <span className="detail-why">当前身份无取消权限（purchase.delete）</span>
        )}
        {/*
          三个在途动作的禁用原因都要说出口，不能只挂在 title 上——
          鼠标不在按钮上时，用户只会看到「点不动」。
        */}
        {shipBlocked && order.status === '进行中' && (
          <span className="detail-why">{shipBlocked}</span>
        )}
        {order.status === '在途' && receiveBlocked && (
          <span className="detail-why">{receiveBlocked}</span>
        )}
        {order.status === '在途' && revokeBlocked && (
          <span className="detail-why">{revokeBlocked}</span>
        )}
        {completeBlocked && <span className="detail-why">{completeBlocked}</span>}
      </div>

      {revoking && (
        <div className="alert alert-bad">
          <h4>撤销发货</h4>
          <p>
            撤销会把单据退回「进行中」，并清掉这一单的在途批次（不转司、不写库存流水）。
            已有下游占用时服务端会拒。
          </p>
          <div className="detail-acts">
            <label className="reason-field">
              <span>撤销原因（必填，会记审计）</span>
              <input
                value={revokeReason}
                onChange={(event) => onRevokeReasonChange(event.target.value)}
                maxLength={200}
                placeholder="例如：供应商发错货，重新安排发货"
                className="ipt"
              />
            </label>
            <button
              type="button"
              disabled={revokeBusy}
              onClick={onSubmitRevoke}
              className="btn btn-primary"
            >
              {revokeBusy ? '撤销中…' : '确认撤销'}
            </button>
            <button
              type="button"
              disabled={revokeBusy}
              onClick={onCancelRevoke}
              className="btn btn-ghost"
            >
              取消
            </button>
          </div>
          {revokeError && <p className="detail-why">{revokeError}</p>}
        </div>
      )}
    </section>
  );
}

export function PurchaseOrdersPage() {
  const employeeLabel = useEmployeeLabel();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me });
  const meData = me.data;
  const can = (action: ScopeAction) => allows(meData?.scope, 'purchase', action);
  const canViewPrice = can('view_price');
  const companyIds = meData?.companyIds ?? [];

  /*
   * 列表过滤只留「状态 / 关键字 / 看谁的」三样 —— 与稿子的工具栏一一对应。
   * 公司由顶栏的公司切换器决定（外壳已有），供应商名走关键字（后端 keyword 就搜单号与供应商名），
   * 所以页面里不再各摆一个下拉：两个下拉会把工具栏挤到换行（1440 下实测），也和稿子对不上。
   */
  const [status, setStatus] = useState<'' | PurchaseOrderStatus>('');
  /**
   * 看谁的（D106）。空串 = 不传参数，由服务端按权限定。
   *
   * 只在有 `purchase.read_all` 时给这个开关 —— 没权限的人拿到一个切不动的下拉框
   * 比没有更糟：他会以为「全部」里应该有别人的单，只是自己点不动。
   */
  const [scopeFilter, setScopeFilter] = useState<'' | 'mine' | 'all'>('');
  const [keyword, setKeyword] = useState('');
  /**
   * 页码模式（D95）。原来是 `cursors: (string|null)[]` + `pageIndex` 的游标栈：
   * 游标下「上一页」得靠回退栈、页码只能显示「第 N 批」且不知道总页数。
   * 采购单是后端三个试点之一，列表已回 `total`，页码条能画 `1 / 12 页 · 共 N 张`。
   */
  const [page, setPage] = useState(1);
  /**
   * 每页条数由用户在页脚选（v3.0 `.pager` 的 `10 / 20 / 50 条/页`）。
   * 改条数必须回第 1 页：原来停在第 5 页是因为 20 条/页，换成 50 条后总页数可能只剩 2 页。
   */
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort] = useState<PurchaseOrderSort>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseOrderDetail | null>(null);
  const [formCompanyId, setFormCompanyId] = useState('');
  const [formSupplierId, setFormSupplierId] = useState('');
  /** 非错误提示（如「已选中已有供应商」）。与 `actionError` 互斥 —— 成功的事别挂在红条上。 */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 开单现场建档（D100）：打开后供应商不选下拉，改为填草档随单据一起提交。
   * 与 `formSupplierId` 分开是因为「打开了但没填名称」与「没打开」提交时报的错不同。
   */
  const [newSupplierOpen, setNewSupplierOpen] = useState(false);
  const [newSupplier, setNewSupplier] = useState<NewSupplierFields>({ ...EMPTY_NEW_SUPPLIER });
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
    setPage(1);
  }, [status, keyword]);

  const filters = useMemo(
    () => ({
      status: status || undefined,
      keyword: optionalText(keyword),
      page,
      pageSize,
      sort,
      order,
      scope: scopeFilter || undefined,
    }),
    [status, keyword, page, pageSize, sort, order, scopeFilter],
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
        /** 二选一（D100）：两个都给会被服务端 422（`details.field = supplierId`）。 */
        ...(newSupplierOpen
          ? { supplierDraft: buildSupplierDraft(newSupplier) }
          : { supplierId: formSupplierId }),
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
      setNewSupplierOpen(false);
      setNewSupplier({ ...EMPTY_NEW_SUPPLIER });
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
    setNewSupplierOpen(false);
    setNewSupplier({ ...EMPTY_NEW_SUPPLIER });
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
    setNewSupplierOpen(false);
    setNewSupplier({ ...EMPTY_NEW_SUPPLIER });
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
  /**
   * 切排序。点同一列就翻方向，点别的列换字段并回到 `desc`（列表默认看最新的）。
   * 换排序后必须回第 1 页：第 5 页的「货款最大」在新排序下没有意义，还可能直接超界。
   */
  const handleSort = (field: PurchaseOrderSort) => {
    if (field === sort) {
      setOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setOrder('desc');
    }
    setPage(1);
  };
  const rows = list.data?.items ?? [];
  /**
   * 页码模式（D95）：`total` 才是真的总条数。为 null 说明后端走了游标模式（老端点），
   * 这时不画页码条——画了也点不动，用户会以为翻页坏了。
   */
  const total = list.data?.total ?? null;
  const totalPages = total === null ? null : Math.max(1, Math.ceil(total / pageSize));
  /**
   * 页脚合计。后端列表只回条数（`total`），不回「全部筛选结果的货款汇总」，
   * 所以只能算手上这一页——但把本页和标成「合计」是骗人（翻一页数字就变）。
   * 折中：只有「一页装得下全部」（`rows.length >= total`）时合计才等于全量，
   * 这时给合计；翻页态只写条数。无看价权限时金额是 `null`，同样不画
   * （除了看 `null` 再按 `canViewPrice` 兜一道：遮罩页面里冒出「合计 ¥…」比不显示更糟）。
   */
  const amounts = rows.map((row) => row.goodsAmount);
  const allAmountsVisible = amounts.every((value) => value !== null);
  const goodsSum =
    canViewPrice && total !== null && rows.length >= total && allAmountsVisible
      ? sumDecimal(amounts.filter((value): value is string => value !== null))
      : null;
  const detailOrder = detail.data;
  const listState = resolveListState({
    isPending: list.isPending,
    hasError: list.isError,
    isEmpty: rows.length === 0,
  });

  /**
   * 状态统计片的条数（稿子 `.chip > b`）。后端列表只回 `total`、不回分组计数，
   * 所以**只有一页装得下全部时**计数才等于全量；翻页态下不画数字，
   * 免得用户把「本页 7 张进行中」当成「全部 7 张」。
   */
  const statusesInPage = (['进行中', '在途', '已完成', '已取消'] as const).filter(
    (value) => status === value || rows.some((row) => row.status === value),
  );
  const countsVisible = total !== null && rows.length >= total;
  const countOf = (value: '' | PurchaseOrderStatus) =>
    value === '' ? rows.length : rows.filter((row) => row.status === value).length;

  return (
    <section className="page-body">
      {/* 页头照稿子 `.ph`：一行大标题 + 一行短说明，右侧只放「+ 新建采购单」。
          以前自写的 eyebrow、三行说明、告示条都不在稿子里，已删。 */}
      <div className="ph">
        <div>
          <h1>采购单 A</h1>
          <p>{PAGE_DESCRIPTION}</p>
        </div>
        <div className="acts">
          <button
            type="button"
            onClick={beginCreate}
            disabled={!can('create') || companyIds.length === 0}
            className="btn btn-p"
            title={
              !can('create')
                ? '需要 purchase.create 权限'
                : companyIds.length === 0
                  ? '当前账号没有可下单的公司，请联系管理员分配公司权限'
                  : '执行「新建采购单」· 需要 purchase.create 权限'
            }
          >
            + 新建采购单
          </button>
        </div>
      </div>

      {/*
        工具栏照稿子 `orderTools()`（`design/v3.0/index.html` L1608–1618）的顺序：
        搜索框 → 状态统计片 →（撑开）→ 范围控件。
        状态从 `.seg` 分段改成 `.chips` 统计片（稿子就是统计片，带条数）。
        右侧：稿子是「全部单据 / 只看我的」+「全部经手人」。经手人下拉后端列表没有对应
        查询参数（`PurchaseOrderListQuerySchema` 只有 companyId / supplierId / status /
        keyword / scope），不画一个接线不上的空壳，已在 PR 里列为有意差异。
      */}
      <div className="tools">
        <label className="field">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索单号、供应商、物料…"
            aria-label="搜索单号、供应商或物料"
          />
        </label>
        <div className="chips" role="group" aria-label="按状态筛选">
          <button
            type="button"
            className={status === '' ? 'chip on' : 'chip'}
            aria-pressed={status === ''}
            onClick={() => setStatus('')}
          >
            全部
            {countsVisible && <b>{countOf('')}</b>}
          </button>
          {statusesInPage.map((value) => (
            <button
              key={value}
              type="button"
              className={status === value ? 'chip on' : 'chip'}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {value}
              {countsVisible && <b>{countOf(value)}</b>}
            </button>
          ))}
        </div>
        <div className="grow" />
        {/*
          看谁的（D106）：有 `purchase.read_all` 才给开关；没有就直说「仅显示本人单据」，
          不画一个切不动的框 —— 那会让人以为「全部」里该有别人的单。
          不传 scope 时由服务端按权限定，所以「全部单据」是默认亮着的那一档。
        */}
        {can('read_all') ? (
          <div className="seg" role="group" aria-label="看谁的单据">
            <button
              type="button"
              className={scopeFilter !== 'mine' ? 'on' : undefined}
              aria-pressed={scopeFilter !== 'mine'}
              onClick={() => {
                setScopeFilter('all');
                setPage(1);
              }}
            >
              全部单据
            </button>
            <button
              type="button"
              className={scopeFilter === 'mine' ? 'on' : undefined}
              aria-pressed={scopeFilter === 'mine'}
              onClick={() => {
                setScopeFilter('mine');
                setPage(1);
              }}
            >
              只看我的
            </button>
          </div>
        ) : (
          <span className="note">仅显示本人单据（无 read_all 权限）</span>
        )}
        {meData && !canViewPrice && (
          <span className="note">
            当前身份无「看价」权限，金额显示为 {MASKED_AMOUNT}（D79）
          </span>
        )}
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
          newSupplierOpen={newSupplierOpen}
          newSupplier={newSupplier}
          onNewSupplierToggle={(open) => {
            setNewSupplierOpen(open);
            // 双向清空另一条路：服务端对「supplierId 与 supplierDraft 都给」是 422。
            if (open) setFormSupplierId('');
            else setNewSupplier({ ...EMPTY_NEW_SUPPLIER });
          }}
          onNewSupplierChange={(patch) => setNewSupplier((current) => ({ ...current, ...patch }))}
          onNewSupplierPick={(candidate) => {
            // 选中已有档案就不再建档：清草档、关新建，否则 supplierId 与 supplierDraft 同时给会 422。
            setFormSupplierId(candidate.id);
            setNewSupplierOpen(false);
            setNewSupplier({ ...EMPTY_NEW_SUPPLIER });
            setNotice(`已选中已有供应商「${candidate.name}」，这次不再新建档案。`);
          }}
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
            const errors = validateDraft(
              formSupplierId,
              lines,
              fees,
              newSupplierOpen ? newSupplier : null,
            );
            setClientErrors(errors);
            if (errors.length > 0) return;
            save.mutate();
          }}
          onCancel={resetForm}
        />
      )}

      {staleNotice && <p className="alert alert-warn">{staleNotice}</p>}
      {save.error && serverIssues.length === 0 && !isStaleVersionError(save.error) && (
        <p className="alert alert-bad">{errorText(save.error)}</p>
      )}
      {actionError && <p className="alert alert-bad">{actionError}</p>}

      {/*
        列表（v3.0 `list-card`）：容器与 tbody 挂同一个 data-state，数据行 `r-row`、
        三行状态行常驻且带 `st-tr st-*`，显隐交给 `app-v013.css`；
        `.tf` 页脚在空 / 加载 / 错误态自动收起分页（`app-v30.css`）。
        分页走页码模式（D95）：后端回 `total`，页脚画「共 N 张 / 首上下末 / 条数」，
        可点的表头只限排序白名单里的单号 / 货款 / 开单时间三列。
      */}
      <div className="card list-card" data-state={listState}>
        <div className="tw">
          {/*
            列头照稿子 `orderTable()`（L1627）：单号 / 供应商 / 物料 / 数量 / 金额 / 状态 /
            负责人 / 日期，共 8 列。此前是「货款 / 开单时间 + 一个操作列」，少了两列、
            却多塞了三个行内按钮 —— 重做第一轮被打回的第二条就是这个。
            宽度靠 `.tw` 横向滚，不再挂 Tailwind 的 `min-w-[920px]`。
          */}
          <table>
            <thead>
              <tr>
                <SortableHead field="orderNo" current={sort} order={order} onSort={handleSort}>
                  单号
                </SortableHead>
                <th>供应商</th>
                <th>物料</th>
                <th className="r">数量</th>
                <SortableHead
                  field="totalAmount"
                  current={sort}
                  order={order}
                  onSort={handleSort}
                  className="r"
                >
                  金额
                </SortableHead>
                <th>状态</th>
                <th>负责人</th>
                <SortableHead field="createdAt" current={sort} order={order} onSort={handleSort}>
                  日期
                </SortableHead>
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
                  <ListEmpty title="暂无采购单。可调整筛选条件，或用右上角「+ 新建采购单」开第一张。" />
                </td>
              </tr>
              {rows.map((order) => (
                /*
                  整行可点进详情（稿子 `tr.r-row.click`）：行内不再放「详情 / 编辑 / 取消」，
                  编辑与取消都在详情面板里，列表只负责「找到并打开」。
                  键盘用户 Enter 同效，`tabIndex` 让行可以聚焦。
                */
                <tr
                  key={order.id}
                  className="r-row click"
                  tabIndex={0}
                  onClick={() => setDetailId(order.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setDetailId(order.id);
                    }
                  }}
                >
                  <td className="mono">
                    <b>{order.orderNo}</b>
                  </td>
                  <td>{order.supplierName}</td>
                  <td>{lineSummary(order, products)}</td>
                  <td className="r num">{qtySummary(order)}</td>
                  <td className="r num">{formatMoney(order.goodsAmount)}</td>
                  <td>
                    <StatusBadge status={order.status} />
                  </td>
                  <td>{employeeLabel(order.handlerId)}</td>
                  <td className="mono muted">{formatDateOnly(order.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/*
          页脚条照稿子（`.tf`）：左边「共 N 条 · 合计」，右边首 / 上 / 页码 / 下 / 末 + 条数。
          `total` 为 null 说明后端还走游标模式（老端点），这时不画分页——画了也点不动。
          非 filled 态整条分页由 `.list-card:not([data-state="filled"])` 收起，只留汇总。
        */}
        <div className="tf">
          <span>
            共 {total ?? rows.length} 条
            {goodsSum !== null ? (
              <>
                {' '}
                · 合计 <b className="num">{formatMoney(goodsSum)}</b>
              </>
            ) : null}
          </span>
          {totalPages !== null && (
            <ListPager
              page={page}
              totalPages={totalPages}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              label="采购单分页"
            />
          )}
        </div>
      </div>

      {detailId !== null && (
        <>
          {detail.isPending && <p className="alert alert-info">正在加载采购单详情…</p>}
          {detail.error && <p className="alert alert-bad">{errorText(detail.error)}</p>}
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
