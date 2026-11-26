/**
 * 销售单 E 页面（`/sales-orders`，22 页 IA 第 5 页）。
 *
 * 视觉与字段对齐 `prototype.html` 的 `pages.e`：单号 / 客户 / 成交额 / 状态 / 经手，
 * 页头「+ 新建」开单，金额受「看价」权限控制（D27 / D79）；
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
import { ListPager } from '../../components/ListPager';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import {
  DetailHead,
  DetailMetaDot,
  DocMeta,
  DocPill,
  LinesFooter,
  type DocPillTone,
} from '../../components/OrderDetailUI';
import { allows, type ScopeAction } from '../../lib/access';
import { resolveListState, type ListState } from '../../lib/list-state';
import { useCompanyLabel } from '../../lib/company-directory';
import { useEmployeeLabel } from '../../lib/employee-directory';
import { orderEditBlockedText } from '../../lib/order-edit-guard';
import {
  describeWriteError,
  isStaleVersionError,
  recoverFromStaleVersion,
  staleActionRetryText,
  staleUnrecoveredText,
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
import { PaymentRequestPanel } from './PaymentRequestPanel';
import {
  EMPTY_NEW_CUSTOMER,
  RECEIPT_METHODS,
  batchOptionLabel,
  buildCustomerDraft,
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
  type NewCustomerFields,
  type SalesFeeDraft,
  type SalesLineDraft,
  type SalesOrderSort,
} from './sales-api';

/**
 * 状态色档（v0.13 `.st` 系列，选档规则见 `components/OrderDetailUI.tsx`）：
 * 进行中还要人干活 → `now`；已发货货在路上 → `transit`；已完成 → `ok`；已取消 → `cancel`。
 *
 * 原来这里是 Tailwind `bg-blue-50` / `bg-amber-50` 自拼色，同一个「已发货」在不同页
 * 会是不同深浅的琥珀 —— 换成 `.st` 之后六张单据页说的是同一种颜色。
 */
const STATUS_TONE: Readonly<Record<SalesOrderStatus, DocPillTone>> = {
  进行中: 'now',
  // D94：货已发出、等客户签收（签收走 sales.order.complete）。
  已发货: 'transit',
  已完成: 'ok',
  已取消: 'cancel',
};

/**
 * 工具条上的状态分段按钮。顺序按单据生命周期排，「全部」永远第一。
 * `已发货` 是 D94 新增的中间态（货已发出、等客户签收），不能漏——漏了它
 * 财务就筛不出发了货还没签收的单。
 */
const STATUS_TABS: readonly { readonly value: '' | SalesOrderStatus; readonly label: string }[] = [
  { value: '', label: '全部状态' },
  { value: '进行中', label: '进行中' },
  { value: '已发货', label: '已发货' },
  { value: '已完成', label: '已完成' },
  { value: '已取消', label: '已取消' },
];

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

/**
 * 可排序表头（D95）。点一次切方向，再点换字段。
 *
 * 为什么排序要真发给服务端、不能只排当前页：一页只有 20 行，用户点「金额」是想看
 * **这批单里金额最大的**，不是「这 20 行里最大的」。假排序（只排前端拿到的数组）
 * 会让最大值藏在第 3 页看不见，而且看起来还挺正常——这比没有排序更糟。
 *
 * 箭头用 `aria-sort` 给读屏用，视觉箭头只是 `↑`/`↓` 两个字，不引图标库。
 */
function SortableHead(props: {
  readonly field: SalesOrderSort;
  readonly current: SalesOrderSort;
  readonly order: 'asc' | 'desc';
  readonly onSort: (field: SalesOrderSort) => void;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  const active = props.current === props.field;
  const ariaSort = active ? (props.order === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th className={props.className} aria-sort={ariaSort} data-sort={active ? '' : undefined}>
      <button
        type="button"
        onClick={() => props.onSort(props.field)}
        className="th-sort"
        title={`按${typeof props.children === 'string' ? props.children : '该列'}排序`}
      >
        {props.children}
        <i aria-hidden="true">{active ? (props.order === 'asc' ? '↑' : '↓') : '↕'}</i>
      </button>
    </th>
  );
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

/** 列表用的短时间：`11-19 08:12`。表格里塞完整年月日会把「操作」列挤出卡片（同 A / B 页）。 */
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

/**
 * 列表「商品」列：一单可能多行多商品。
 *
 * 只写首行商品名会让人以为整单就这一种货（视觉稿的样例数据恰好都是单行单商品）；
 * 全列出来又会把「操作」列挤出卡片。折中：首行名 + 「等 N 种」，
 * N 取**不同商品数**而不是行数——同一商品两行仍然只有一种货。
 */
function orderProductSummary(
  products: readonly Product[],
  lines: readonly { readonly productId: string }[],
): string {
  const first = lines[0];
  if (!first) return '—';
  const distinct = new Set(lines.map((line) => line.productId)).size;
  const label = productLabel(products, first.productId);
  return distinct > 1 ? `${label} 等 ${distinct} 种` : label;
}

function StatusBadge({ status }: { status: SalesOrderStatus }) {
  return <DocPill label={status} tone={STATUS_TONE[status] ?? 'cancel'} />;
}

// ============================ 开单 / 改单表单 ============================

/**
 * 开单现场建档的内联小表单（D100「静默建档」）。
 *
 * 为什么单独一个组件：它要在本仓「不带 jsdom」的测试里能被静态渲染断言
 * （`OrderForm` 未导出且 props 二十多个，为一条断言造二十个 mock 不值），
 * 而且「保存后才建档、界面不提示」这条口径集中在这里，读的时候不用翻整张表单。
 *
 * 字段只收「开单现场能知道」的四个（名称 + 联系人 + 电话 + 账期），其余留给主数据页补。
 */
export function NewCustomerInlineForm({
  fields,
  onChange,
}: {
  readonly fields: NewCustomerFields;
  readonly onChange: (patch: Partial<NewCustomerFields>) => void;
}) {
  return (
    <div className="form-sec">
      <div className="form-sec-b fm c4">
        <label>
          <span>客户名称（必填）</span>
          <input
            aria-label="新建客户名称"
            value={fields.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <label>
          <span>联系人（选填）</span>
          <input
            aria-label="新建客户联系人"
            value={fields.contactName}
            onChange={(event) => onChange({ contactName: event.target.value })}
          />
        </label>
        <label>
          <span>电话（选填）</span>
          <input
            aria-label="新建客户电话"
            value={fields.contactPhone}
            onChange={(event) => onChange({ contactPhone: event.target.value })}
          />
        </label>
        <label>
          <span>账期天数（选填）</span>
          <input
            aria-label="新建客户账期"
            inputMode="numeric"
            placeholder="留空 = 现结"
            value={fields.creditTermDays}
            onChange={(event) => onChange({ creditTermDays: event.target.value })}
          />
        </label>
        {/* `.fm > .w` 横跨整行 */}
        <p className="detail-why w">
          保存单据时一起建档，不必先去主数据页。建档对你是透明的 —— 保存成功后只提示单据保存，
          不额外提示建档结果，也不需要建客户权限（有开单权即可）。
        </p>
      </div>
    </div>
  );
}

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
  /**
   * 开单现场建档（D100）：打开后客户不再从下拉里选，改为填一份最小草档，
   * 随单据一起提交；服务端在同一事务里先建客户再建单。
   */
  readonly newCustomerOpen: boolean;
  readonly newCustomer: NewCustomerFields;
  readonly onNewCustomerToggle: (open: boolean) => void;
  readonly onNewCustomerChange: (patch: Partial<NewCustomerFields>) => void;
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
  newCustomerOpen,
  newCustomer,
  onNewCustomerToggle,
  onNewCustomerChange,
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
    <form onSubmit={onSubmit} className="form-card">
      <div className="form-head">
        <h2>{editing ? `编辑销售单 ${editing.orderNo}` : '新建销售单'}</h2>
        <span className="detail-why">
          单号由服务端生成（D16）；开单是业务动作，AI 默认禁止（D52）。
        </span>
      </div>

      <div className="fm c4">
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
          <span>客户</span>
          {newCustomerOpen ? (
            <p className="fm-readonly">
              开单时新建：
              <b className="cell-clip">
                {newCustomer.name.trim() === '' ? '在下方填名称' : newCustomer.name.trim()}
              </b>
            </p>
          ) : (
            <select
              required
              value={customerId}
              onChange={(event) => onCustomerChange(event.target.value)}
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
          )}
        </label>
        {/* 经手人 = 当前登录人，改不了；用只读块而不是输入框 */}
        <label>
          <span>经手人</span>
          <p className="fm-readonly">{handlerName}</p>
        </label>
        <label>
          <span>单据合计（预览）</span>
          <p className="fm-readonly mono">{formatMoney(total)}</p>
        </label>
      </div>

      {/**
       * 开单现场建档（D100）：只能开单时用，编辑已有单据换客户得去主数据页选已有档案
       * ——改单顺带建新客户会让「这张单原来卖给谁」无从追溯。
       */}
      {editing === null && (
        <div className="form-stack">
          <button
            type="button"
            onClick={() => onNewCustomerToggle(!newCustomerOpen)}
            className="btn btn-s form-add"
          >
            {newCustomerOpen ? '取消新建，改从已有客户里选' : '+ 新建客户'}
          </button>
          {newCustomerOpen && (
            <NewCustomerInlineForm fields={newCustomer} onChange={onNewCustomerChange} />
          )}
        </div>
      )}

      {(customers.length === 0 || products.length === 0 || batches.length === 0) && (
        <div className="alert alert-warn alert-sm">
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

      <div className="form-stack">
        <div className="form-head">
          <h3 className="form-title">商品明细</h3>
          <span className="detail-why">
            行合计 <b className="mono">{formatMoney(lineTotal)}</b>（数量 × 单价，定点计算，D54）
          </span>
        </div>

        <div className="ln">
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th className="num">数量</th>
                <th className="num">单价（售价）</th>
                <th className="num">金额</th>
                <th>引用批次（D22，至少 1 个）</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const candidates = batchesOf(line.productId);
                const available = candidates.filter(
                  (batch) => !line.batchIds.includes(batch.id),
                );
                return (
                  <tr key={index} className="vtop">
                    <td>
                      <select
                        required
                        value={line.productId}
                        onChange={(event) =>
                          onLineChange(index, { productId: event.target.value, batchIds: [] })
                        }
                        className="ipt"
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
                    <td>
                      <input
                        required
                        inputMode="decimal"
                        value={line.qty}
                        onChange={(event) => onLineChange(index, { qty: event.target.value })}
                        placeholder="0"
                        className="ipt"
                      />
                    </td>
                    <td>
                      <input
                        required
                        inputMode="decimal"
                        value={line.unitPrice}
                        onChange={(event) =>
                          onLineChange(index, { unitPrice: event.target.value })
                        }
                        placeholder="0"
                        className="ipt"
                      />
                    </td>
                    <td className="mono">{formatMoney(lineAmountOf(line))}</td>
                    <td>
                      <div className="chip-row">
                        {line.batchIds.map((batchId) => (
                          <span key={batchId} className="chip">
                            <span className="mono">{batchLabel(batches, batchId)}</span>
                            <button
                              type="button"
                              aria-label={`移除批次 ${batchLabel(batches, batchId)}`}
                              onClick={() =>
                                onLineChange(index, {
                                  batchIds: line.batchIds.filter((id) => id !== batchId),
                                })
                              }
                              className="chip-x"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        {line.productId.length === 0 ? (
                          <span className="chip-none">先选商品，再挑批次</span>
                        ) : candidates.length === 0 ? (
                          <span className="chip-none text-warn">
                            该商品暂无可用批次，先在 A / B 单里入库
                          </span>
                        ) : available.length === 0 ? (
                          <span className="chip-none">已引用全部可选批次</span>
                        ) : (
                          <select
                            aria-label={`第 ${index + 1} 行添加批次`}
                            value=""
                            onChange={(event) => {
                              if (!event.target.value) return;
                              onLineChange(index, {
                                batchIds: [...line.batchIds, event.target.value],
                              });
                            }}
                            className="ipt"
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
                    <td className="row-acts">
                      <button
                        type="button"
                        onClick={() => onRemoveLine(index)}
                        disabled={lines.length <= 1}
                        className="btn btn-row"
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

        <button type="button" onClick={onAddLine} className="btn form-add">
          + 加一行商品
        </button>
      </div>

      <p className="detail-why">
        一行引用多个批次时，完成按行内批次<b>均分扣减</b>，除不尽的余量由最后一个批次承接（D72）。
        售价低于该行加权平均批次成本会被服务端拒绝（D20）——本批没有审批端点，只能先走 platform 审批。
      </p>

      <div className="form-stack">
        <div className="form-head">
          <h3 className="form-title">费用明细（选填）</h3>
          <span className="detail-why">
            运费 / 杂费，金额必须 ≥ 0（D39）；合计 <b className="mono">{formatMoney(feeTotal)}</b>
          </span>
        </div>

        {fees.length === 0 ? (
          <p className="form-empty">没有费用行；需要时点「+ 加一行」。</p>
        ) : (
          <div className="ln">
            <table>
              <thead>
                <tr>
                  <th>费用名称</th>
                  <th className="num">数量</th>
                  <th className="num">单价</th>
                  <th className="num">金额</th>
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
                        onChange={(event) =>
                          onFeeChange(index, { feeName: event.target.value })
                        }
                        placeholder="运费 / 包装费"
                        className="ipt"
                      />
                    </td>
                    <td>
                      <input
                        required
                        inputMode="decimal"
                        value={fee.qty}
                        onChange={(event) => onFeeChange(index, { qty: event.target.value })}
                        className="ipt"
                      />
                    </td>
                    <td>
                      <input
                        required
                        inputMode="decimal"
                        value={fee.unitPrice}
                        onChange={(event) =>
                          onFeeChange(index, { unitPrice: event.target.value })
                        }
                        className="ipt"
                      />
                    </td>
                    <td>
                      <input
                        value={fee.amount}
                        onChange={(event) => onFeeChange(index, { amount: event.target.value })}
                        placeholder={feeAmountOf(fee)}
                        className="ipt"
                      />
                    </td>
                    <td>
                      <input
                        value={fee.remark}
                        onChange={(event) => onFeeChange(index, { remark: event.target.value })}
                        maxLength={255}
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

        <button type="button" onClick={onAddFee} className="btn form-add">
          + 加一行费用
        </button>
      </div>

      <div className="sum-bar">
        <span>
          商品行 <b>{formatMoney(lineTotal)}</b>
        </span>
        <span>
          费用 <b>{formatMoney(feeTotal)}</b>
        </span>
        <span>
          单据合计 <b>{formatMoney(total)}</b>
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
              · {issue.path && <code className="mono">{issue.path}</code>} {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="detail-acts">
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? '提交中…' : editing ? '保存修改' : '开单'}
        </button>
        <button type="button" onClick={onCancel} className="btn">
          取消
        </button>
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
  /**
   * `payment.create`（#101 发起收款）。与 `canAdd` 是两件事：`canAdd` 是 `sales.update`
   * （线下补录收款行），这个是把二维码给客户去扫码付。能补录不等于能收钱 ——
   * 同 D85 把「出库」与「认收入」拆开的理由。
   */
  readonly canCreatePayment: boolean;
  readonly status: SalesOrderStatus;
  readonly onError: (message: string) => void;
  /** 扫码收款入账后让详情重拉（余额/收款记录/状态都可能变）。 */
  readonly onRefresh: () => void;
}

function ReceiptBlock({
  orderId,
  receipts,
  balance,
  canViewPrice,
  canAdd,
  canCreatePayment,
  status,
  onError,
  onRefresh,
}: ReceiptBlockProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
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
    <section className="form-sec">
      {/* 标题条：`form-head` 只用来把「收款记录」与「块内余额」挤在一起（它本身 space-between，
          但这一组是 auto 宽、没有多余空间，等于左对齐 + gap 8），右侧另起一组按钮。 */}
      <div className="form-sec-h">
        <div className="form-head">
          <h3>收款记录</h3>
          <span className="detail-why">
            块内余额{' '}
            <b className="mono">{balance === null ? MASKED_AMOUNT : formatMoney(balance)}</b>
            （收款合计 − 退款合计，服务端计算，D34）
          </span>
        </div>
        {(canAdd || canCreatePayment) && status !== '已取消' && (
          <div className="detail-tools">
            {/*
              扫码收款与线下补录并列但不混：一个让客户自己付、一个由操作员录入已发生的钱。
              两道权限（`payment.create` / `sales.update`）各自判、各自置灰 ——
              用 `canAdd || canCreatePayment` 作为是否渲染的依据，否则「有收款权没改单权」
              的人会连按钮都看不见。
            */}
            <button
              type="button"
              onClick={() => setPayOpen((value) => !value)}
              disabled={!canCreatePayment}
              title={canCreatePayment ? undefined : '发起收款需要 payment.create 权限'}
              className="btn btn-row"
            >
              {payOpen ? '收起收款码' : '+ 发起扫码收款'}
            </button>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              disabled={!canAdd}
              title={canAdd ? undefined : '追加收款需要 sales.update 权限'}
              className="btn btn-row"
            >
              {open ? '收起' : '+ 追加收款 / 退款'}
            </button>
          </div>
        )}
      </div>

      <div className="form-sec-b form-stack">
        {payOpen && canCreatePayment && status !== '已取消' && (
          <PaymentRequestPanel
            orderId={orderId}
            canCreate={canCreatePayment}
            canViewPrice={canViewPrice}
            onClose={() => setPayOpen(false)}
            onPaid={onRefresh}
            onError={onError}
          />
        )}

        {!canViewPrice && (
          <p className="detail-why text-warn">
            无「看价」权限：收款金额显示为 {MASKED_AMOUNT}，也不能追加收款——
            看不到金额就录钱账，会把余额改错（D27 / D79）。
          </p>
        )}
        {canViewPrice && !canAdd && (
          <p className="detail-why">追加收款需要 sales.update；当前身份只能查看收款台账。</p>
        )}
        {canViewPrice && canAdd && status === '已取消' && (
          <p className="detail-why">已取消的销售单不可追加收款或退款。</p>
        )}

        {receipts.length === 0 ? (
          <p className="detail-why">还没有收款记录。</p>
        ) : (
          <div className="ln">
            <table>
              <thead>
                <tr>
                  <th>方向</th>
                  <th className="num">金额</th>
                  <th>方式</th>
                  <th>发生时间</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td>
                      <span className={`st ${receipt.direction === '退款' ? 'warn' : 'ok'}`}>
                        {receipt.direction}
                      </span>
                    </td>
                    <td className="num">
                      {canViewPrice && receipt.amount !== null
                        ? formatMoney(receiptAmountText(receipt.direction, receipt.amount))
                        : MASKED_AMOUNT}
                    </td>
                    <td>{receipt.method}</td>
                    <td className="cell-muted">{formatDateTime(receipt.occurredAt)}</td>
                    <td className="cell-muted">{receipt.remark ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {open && canAdd && canViewPrice && status !== '已取消' && (
          <div className="form-sec">
            <form onSubmit={submit} className="form-sec-b form-stack">
              <div className="fm c4">
                <label>
                  <span>方向</span>
                  <select
                    value={direction}
                    onChange={(event) => {
                      const next = event.target.value as SalesReceiptDirection;
                      setDirection(next);
                      setMethod(next === '退款' ? '原路退款' : '线下转账');
                    }}
                  >
                    <option value="收款">收款</option>
                    <option value="退款">退款</option>
                  </select>
                </label>
                <label>
                  <span>金额（填正数）</span>
                  <input
                    required
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <label>
                  <span>方式</span>
                  <select
                    value={method}
                    onChange={(event) => setMethod(event.target.value as typeof method)}
                  >
                    {RECEIPT_METHODS.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>发生时间</span>
                  <input
                    required
                    type="datetime-local"
                    value={occurredAt}
                    onChange={(event) => setOccurredAt(event.target.value)}
                  />
                </label>
                <label className="w">
                  <span>备注（选填）</span>
                  <input
                    value={remark}
                    onChange={(event) => setRemark(event.target.value)}
                    maxLength={200}
                  />
                </label>
              </div>

              <div className="detail-acts">
                <button type="submit" disabled={create.isPending} className="btn btn-primary">
                  {create.isPending ? '提交中…' : direction === '退款' ? '追加退款行' : '追加收款行'}
                </button>
                <span className="detail-why">
                  退款只追加负数行，不改历史行（D34 / D40）；涉及钱账，AI 默认禁止（D52①）。
                </span>
                {localError && <span className="detail-why text-warn">{localError}</span>}
              </div>
            </form>
          </div>
        )}
      </div>
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
  readonly canShip: boolean;
  readonly canComplete: boolean;
  readonly canCancel: boolean;
  /** `payment.create`（#101 扫码收款），与 `canUpdate` 不是一回事。 */
  readonly canCreatePayment: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onShip: () => void;
  readonly onComplete: () => void;
  readonly onCancel: () => void;
  readonly onPrint: () => void;
  /** 扫码收款入账后重拉详情。 */
  readonly onRefresh: () => void;
  readonly onError: (message: string) => void;
}

export function DetailPanel({
  order,
  products,
  batches,
  canViewPrice,
  canUpdate,
  canShip,
  canComplete,
  canCancel,
  canCreatePayment,
  busy,
  onClose,
  onEdit,
  onShip,
  onComplete,
  onCancel,
  onPrint,
  onRefresh,
  onError,
}: DetailPanelProps) {
  const employeeLabel = useEmployeeLabel();
  const lineTotal = sumNullable(order.lines.map((line) => line.amount));
  const feeTotal = sumNullable(order.fees.map((fee) => fee.amount));
  const cancelReason = cancelDisabledReason(order.cancelable.reason);
  /**
   * 详情面板的「编辑」要和列表行同一把尺子（#261 同型缺陷）：
   * 列表行判了 `sales.update`，这里原先只判了看价与状态，于是「按钮点得动，保存才 403」。
   */
  const editBlocked = orderEditBlockedText({
    domain: 'sales',
    canUpdate,
    canViewPrice,
    status: order.status,
  });

  return (
    <section className="card detail">
      <DetailHead
        docLabel="销售单"
        orderNo={order.orderNo}
        pill={<StatusBadge status={order.status} />}
        meta={
          <>
            <span>{order.customerName}</span>
            <DetailMetaDot />
            <span>经手 {employeeLabel(order.handlerId)}</span>
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

      {/*
        明细列序把「引用批次」挪到商品后面：批次是这一行的来源（D22 一行可引多批次），
        贴着商品读才顺；也为了把 `LinesFooter` 的合计放到最后一列「金额」下面 ——
        合计落在「引用批次」列下会被读成批次的数量。
      */}
      <div className="ln">
        <table>
          <thead>
            <tr>
              <th>商品</th>
              <th>引用批次</th>
              <th className="num">数量</th>
              <th className="num">单价</th>
              <th className="num">金额</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line, index) => (
              <tr key={`${line.productId}-${index}`}>
                <td>{productLabel(products, line.productId)}</td>
                <td>
                  <div className="chip-row">
                    {line.batchIds.map((batchId) => (
                      <span key={batchId} className="chip chip-static">
                        <span className="mono">{batchLabel(batches, batchId)}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="num">{formatQty(line.qty)}</td>
                <td className="num">
                  {canViewPrice ? formatMoney(line.unitPrice) : MASKED_AMOUNT}
                </td>
                <td className="num">
                  {canViewPrice ? formatMoney(line.amount) : MASKED_AMOUNT}
                </td>
              </tr>
            ))}
          </tbody>
          <LinesFooter
            colSpan={4}
            note={`共 ${order.lines.length} 行 · 数量合计 ${formatQty(totalLineQty(order.lines))}（不同商品单位可能不同）`}
            sum={canViewPrice ? formatMoney(lineTotal) : MASKED_AMOUNT}
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
                  <td className="num">
                    {canViewPrice ? formatMoney(fee.unitPrice) : MASKED_AMOUNT}
                  </td>
                  <td className="cell-muted">{fee.remark ?? '—'}</td>
                  <td className="num">
                    {canViewPrice ? formatMoney(fee.amount) : MASKED_AMOUNT}
                  </td>
                </tr>
              ))}
            </tbody>
            <LinesFooter
              colSpan={4}
              note={`共 ${order.fees.length} 行费用 · 费用行金额必须 ≥ 0（D39）`}
              sum={canViewPrice ? formatMoney(feeTotal) : MASKED_AMOUNT}
            />
          </table>
        </div>
      )}

      <DocMeta
        columns={3}
        items={[
          { label: '客户', value: order.customerName },
          { label: '经手', value: employeeLabel(order.handlerId) },
          { label: '数量合计', mono: true, value: formatQty(totalLineQty(order.lines)) },
          {
            label: '商品合计',
            mono: true,
            value: canViewPrice ? formatMoney(lineTotal) : MASKED_AMOUNT,
          },
          {
            label: '费用合计',
            mono: true,
            value: canViewPrice ? formatMoney(feeTotal) : MASKED_AMOUNT,
          },
          {
            label: '单据合计',
            mono: true,
            tone: 'money',
            value: canViewPrice ? formatMoney(order.totalAmount) : MASKED_AMOUNT,
          },
          {
            label: '收款余额',
            mono: true,
            value: canViewPrice ? formatMoney(order.receiptBalance) : MASKED_AMOUNT,
          },
          { label: '开单时间', mono: true, value: formatDateTime(order.createdAt) },
          { label: '最近更新', mono: true, value: formatDateTime(order.updatedAt) },
        ]}
      />

      <ReceiptBlock
        orderId={order.id}
        receipts={order.receipts}
        balance={order.receiptBalance}
        canViewPrice={canViewPrice}
        canAdd={canUpdate}
        canCreatePayment={canCreatePayment}
        status={order.status}
        onError={onError}
        onRefresh={onRefresh}
      />

      {/*
        按钮常驻 + 禁用 + 说原因（D85：能改单不等于能出库，只有 sales.update 时「发货」
        仍在但置灰，并写明缺 sales.ship）—— 与 A / B 页「按状态分段画」不同，
        这里两个动作是同一批货的两步，并排才看得出「先发货再签收」。
        主色只给当前状态该做的那一个，避免出现两个同等重要的按钮。
      */}
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
        <button
          type="button"
          onClick={onShip}
          disabled={order.status !== '进行中' || !canShip || busy}
          title={
            !canShip
              ? '当前身份没有 sales.ship 权限'
              : order.status !== '进行中'
                ? '仅「进行中」状态的销售单可发货'
                : undefined
          }
          className={order.status === '进行中' && canShip ? 'btn btn-p' : 'btn'}
        >
          发货
        </button>
        {/*
          签收单独一个按钮（D94）：发货只让货走出去，签收才认收入、才生成结算草稿。
          两个动作的权限不同（sales.ship / sales.approve），合并会把「谁发的货」与
          「谁确认的收入」压成同一件事。
        */}
        <button
          type="button"
          onClick={onComplete}
          disabled={order.status !== '已发货' || !canComplete || busy}
          title={
            !canComplete
              ? '当前身份没有 sales.approve 权限'
              : order.status !== '已发货'
                ? '仅「已发货」状态的销售单可签收'
                : undefined
          }
          className={order.status === '已发货' && canComplete ? 'btn btn-p' : 'btn'}
        >
          客户签收
        </button>
        <button
          type="button"
          onClick={onPrint}
          title={canViewPrice ? undefined : '无看价权限：打印件上的金额是「—」（D79），不会印出具体金额'}
          className="btn"
        >
          打印客户联
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={!order.cancelable.allowed || !canCancel || busy}
          className="btn danger act-end"
        >
          取消销售单
        </button>

        {/* 禁用原因说出口（不能只挂 title）：与采购 / 加工同口径，跟在按钮同一行 */}
        {cancelReason && <span className="detail-why">{cancelReason}</span>}
        {editBlocked && <span className="detail-why">{editBlocked}</span>}
        {!canCancel && order.cancelable.allowed && (
          <span className="detail-why">当前身份无取消权限（sales.delete）</span>
        )}
        {!canShip && order.status === '进行中' && (
          <span className="detail-why">当前身份没有 sales.ship 权限</span>
        )}
        {!canComplete && order.status === '已发货' && (
          <span className="detail-why">
            签收需要 sales.approve（签收才认收入、才生成结算草稿）
          </span>
        )}
      </div>
      <p className="detail-why">
        完成会按 D72 扣减批次可用量并生成结算单 C 草稿（同事务）；已完成不可取消，错账走冲正（D21）。
      </p>
    </section>
  );
}

// ============================ 页面 ============================

export function SalesOrdersPage() {
  const companyLabel = useCompanyLabel();
  /** 列表「经手」列要姓名不要 id 前缀；与详情共用同一册姓名簿（5 分钟缓存，不额外拉）。 */
  const employeeLabel = useEmployeeLabel();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me });
  const meData = me.data;
  const can = (action: ScopeAction) => allows(meData?.scope, 'sales', action);
  const canViewPrice = can('view_price');
  const companyIds = meData?.companyIds ?? [];

  const [companyId, setCompanyId] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [status, setStatus] = useState<'' | SalesOrderStatus>('');
  /**
   * 看谁的（D106）。空串 = 不传参数，由服务端按权限定。
   *
   * 只在有 `sales.read_all` 时给这个开关 —— 没权限的人拿到一个切不动的下拉框
   * 比没有更糟：他会以为「全部」里应该有别人的单，只是自己点不动。
   */
  const [scopeFilter, setScopeFilter] = useState<'' | 'mine' | 'all'>('');
  const [keyword, setKeyword] = useState('');
  /**
   * 页码模式（D95）。原来是 `cursors: (string|null)[]` + `pageIndex` 的游标栈：
   * 游标模式下「上一页」得靠回退栈、页码只能显示「第 N 页」而不知道总页数。
   * 现在后端给 `total`，页码条能画 `1 / 12 页`，也能直接跳。
   */
  const [page, setPage] = useState(1);
  /**
   * 每页条数由用户在页脚选（v3.0 `.pager` 的 10/20/50）。改条数回第 1 页：
   * 原来停在第 5 页是因为 20 条/页，换 50 条后总页数可能只剩 2 页，直接超界。
   */
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort] = useState<SalesOrderSort>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SalesOrderDetail | null>(null);
  const [formCompanyId, setFormCompanyId] = useState('');
  const [formCustomerId, setFormCustomerId] = useState('');
  /**
   * 开单现场建档（D100）：`newCustomerOpen` 打开后客户不选下拉，改为填草档。
   *
   * 两个状态分开而不是「草档为空 = 没打开」：用户点了「+ 新建客户」但还没填名称时，
   * 提交要报「请填客户名称」；没打开时提交要报「请选择客户」。合成一个状态这两句就分不清。
   */
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [newCustomer, setNewCustomer] = useState<NewCustomerFields>({ ...EMPTY_NEW_CUSTOMER });
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
    queryFn: () => masterdataApi.listProducts({ limit: 200 }),
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
    setPage(1);
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
      page,
      pageSize,
      sort,
      order,
      scope: scopeFilter || undefined,
    }),
    [companyId, customerFilter, status, keyword, page, pageSize, sort, order, scopeFilter],
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
    setNewCustomerOpen(false);
    setNewCustomer({ ...EMPTY_NEW_CUSTOMER });
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
        /**
         * 二选一（D100）：开了「+ 新建客户」就只发草档，把 `customerId` 整个省掉。
         * 两个都发会被服务端 422（`details.field = customerId`），所以这里必须是二选一
         * 而不是「优先用草档」。
         */
        ...(newCustomerOpen
          ? { customerDraft: buildCustomerDraft(newCustomer) }
          : { customerId: formCustomerId }),
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
      if (!fresh) {
        // 非 stale 的红条由 `save.error` 渲染；stale 但读不到最新版本时那条被抑制，必须在这里兜底
        if (isStaleVersionError(error)) setActionError(staleUnrecoveredText());
        return;
      }
      setEditing({ ...editing, version: fresh.version });
      setStaleNotice(staleVersionRecoveredText(fresh.version));
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
    },
  });

  const shipOrder = useMutation({
    mutationFn: (order: SalesOrderDetail) => salesApi.ship(order.id, order.version),
    onSuccess: async (order) => {
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
      setNotice(
        `销售单 ${order.orderNo} 已发货：批次可用量已扣减，等待客户签收后再确认收入（D94）。`,
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

  /**
   * 客户签收（D94）：`已发货` → `已完成`，同事务生成结算单 C 草稿。
   *
   * 与发货是两个权限：仓管有 `sales.ship` 但通常没有 `sales.approve`。合并成一个按钮的话，
   * 「谁把货发出去了」与「谁认了这笔记收入」就再分不开。
   */
  const completeOrder = useMutation({
    mutationFn: (order: SalesOrderDetail) => salesApi.complete(order.id, order.version),
    onSuccess: async (order) => {
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
      setNotice(
        `销售单 ${order.orderNo} 已完成签收：已生成结算单 C 草稿，待财务确认（D72 / D94）。`,
      );
    },
    /** 撞版本冲突时不自动重提：完成会生成 C 草稿，不可逆，要让用户看清当前状态再点（D60）。 */
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, salesApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '签收失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '签收'));
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
    onSuccess: ({ blob, filename }) => {
      // 后端给的是原生 CSV（D96），blob 直接用；文件名来自 content-disposition。
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${filename}（敏感读，服务端已记审计）。`);
    },
    onError: (error) => setNotice(`导出失败：${errorText(error)}`),
  });

  /**
   * 切排序。点同一列就翻方向，点别的列换字段并回到 `desc`（列表默认看最新的）。
   * 换排序后必须回到第 1 页：第 5 页的「金额最大」在新排序下没意义，而且可能直接超界。
   */
  const handleSort = (field: SalesOrderSort) => {
    if (field === sort) {
      setOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setOrder('desc');
    }
    setPage(1);
  };

  const beginCreate = () => {
    setEditing(null);
    setFormCustomerId('');
    setNewCustomerOpen(false);
    setNewCustomer({ ...EMPTY_NEW_CUSTOMER });
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

  const askShip = (order: SalesOrderDetail) => {
    /** 列表行按钮只按「进行中」判断，但列表可能是旧的（别人刚取消 / 刚发货了）。别静默失败。 */
    if (!can('ship')) {
      setActionError('当前身份没有 sales.ship 权限');
      return;
    }
    if (order.status !== '进行中') {
      setActionError(`这张单当前是「${order.status}」，不能再发货；请刷新列表查看最新状态。`);
      return;
    }
    setActionError(null);
    const message = `确认发出销售单 ${order.orderNo} 吗？\n\n发货后会：\n· 按行内批次均分扣减库存可用量（D72）\n· 单据转为「已发货」，等客户签收\n\n这一步不可撤销，错发请走冲正。`;
    if (globalThis.confirm?.(message) === false) return;
    shipOrder.mutate(order);
  };

  /**
   * 客户签收（D94）：`已发货` → `已完成`，这一步才生成结算草稿。
   *
   * 与发货分开确认，因为后果不同：发货只是货走出去，签收才认收入、才引出对账与退款。
   * 而且两个动作权限不同（`sales.ship` 与 `sales.approve`），能发货的人往往不能确认收入。
   */
  const askComplete = (order: SalesOrderDetail) => {
    if (!can('approve')) {
      setActionError('当前身份没有 sales.approve 权限');
      return;
    }
    if (order.status !== '已发货') {
      setActionError(`这张单当前是「${order.status}」，不能签收；请刷新列表查看最新状态。`);
      return;
    }
    setActionError(null);
    const message = `确认客户已签收销售单 ${order.orderNo} 吗？\n\n签收后会：\n· 单据转为「已完成」\n· 同事务生成结算单 C 草稿，财务确认后才算结算（D19）\n\n完成后不可取消，错账请走冲正。`;
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
  /**
   * 页码模式（D95）：`total` 才是真的总条数。老游标模式返回 null，
   * 这时退化成「没有页码条」而不是显示 0 条——否则用户会以为库是空的。
   */
  const total = list.data?.total ?? null;
  const totalPages = total === null ? null : Math.max(1, Math.ceil(total / pageSize));
  /**
   * 页脚合计：后端只回条数，不回「全部筛选结果的金额汇总」，所以只在
   * 「一页装得下全部」（`rows.length >= total`）时给；翻页态只写条数。
   * 无 `sales.view_price` 时后端根本不回 `totalAmount`（D79），这里再按 `canViewPrice`
   * 兜一道：金额遮罩的页面里出现一个「合计 ¥…」比不显示更糟。
   */
  const amounts = rows.map((row) => row.totalAmount);
  const allAmountsVisible = amounts.every((value) => value !== null);
  const salesSum =
    canViewPrice && total !== null && rows.length >= total && allAmountsVisible
      ? sumDecimal(amounts.filter((value): value is string => value !== null))
      : null;
  /** 列表四态：由服务端状态决定，交给 CSS 的 `data-state` 驱动，不在 JSX 里三元分支。 */
  const listState: ListState = resolveListState({
    isPending: list.isPending,
    hasError: list.error !== null,
    isEmpty: rows.length === 0,
  });
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
    <section className="page-body">
      <div className="p-head">
        <div>
          <div className="eyebrow">销售单 E · 按批次出库</div>
          <h1>销售单 E</h1>
          <p className="sub">{PAGE_DESCRIPTION}</p>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={() => exportCsv.mutate()}
            disabled={!can('export') || exportCsv.isPending}
            title={!can('export') ? '当前身份没有 sales.export 权限' : undefined}
            className="btn"
          >
            {exportCsv.isPending ? '导出中…' : '导出 CSV'}
          </button>
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

      <p className="note">
        完成 = 货已发出：扣批次可用量 + 生成结算单 C 草稿（D72）；「已结算」由财务在 C 单确认，
        不在这张单上（D19）。收款记录内嵌详情，退款只追加负数行，不改历史行（D24 / D34 / D40）。
      </p>

      {meData && !canViewPrice && (
        <p className="alert alert-warn">
          当前身份无「看价」权限，金额显示为 <b>{MASKED_AMOUNT}</b>（D79）。
          此时不能编辑单据，也不能追加收款——看不到金额就改钱账，会把账面改错。
        </p>
      )}

      {meData && !can('create') && (
        <p className="detail-why">
          「新建」需要 sales.create；当前身份只能查看（权限判定在服务端，前端只是不画按钮）。
        </p>
      )}

      {meData && !can('export') && (
        <p className="detail-why">
          「导出 CSV」需要 sales.export：导出会把整批单据落成文件，服务端按敏感读记审计（D54②）。
        </p>
      )}

      {/*
        工具条（v0.13 `.toolbar`）：状态切换用 `.seg` 分段按钮而不是下拉框——
        销售单 90% 的操作是「只看进行中」，点一下比展开下拉再选快一步。
        其它两个筛选（公司、客户）仍是下拉，因为它们选项多、变化少。
      */}
      <div className="toolbar">
        <div className="seg" role="group" aria-label="按状态筛选">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value || 'all'}
              type="button"
              className={status === tab.value ? 'on' : undefined}
              aria-pressed={status === tab.value}
              onClick={() => setStatus(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {/*
          看谁的（D106）。只在有 `sales.read_all` 时才给这个下拉 ——
          没权限的人看到一个切不动的框，会以为「全部」里该有别人的单。
        */}
        {can('read_all') && (
          <select
            value={scopeFilter}
            onChange={(event) => {
              setScopeFilter(event.target.value as '' | 'mine' | 'all');
              setPage(1);
            }}
            aria-label="看谁的单据"
            className="sel"
          >
            <option value="">默认（按我的权限）</option>
            <option value="mine">只看我经手的</option>
            <option value="all">全部</option>
          </select>
        )}
        {companyIds.length > 1 && (
          <select
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            aria-label="按公司筛选"
            className="sel"
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
          aria-label="按客户筛选"
          className="sel"
        >
          <option value="">全部客户</option>
          {filterCustomers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索单号或客户名"
          aria-label="搜索单号或客户名"
          className="search"
        />
        <span className="toolbar-end">点表头可排序：单号 / 金额 / 日期</span>
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
          newCustomerOpen={newCustomerOpen}
          newCustomer={newCustomer}
          onNewCustomerToggle={(open) => {
            setNewCustomerOpen(open);
            // 双向切换时把另一条路清干净：否则「先选了客户、再改新建」会把旧 id 带着，
            // 服务端两个都给 → 422。
            if (open) setFormCustomerId('');
            else setNewCustomer({ ...EMPTY_NEW_CUSTOMER });
          }}
          onNewCustomerChange={(patch) => setNewCustomer((current) => ({ ...current, ...patch }))}
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
            const errors = validateDraft(
              formCustomerId,
              lines,
              fees,
              newCustomerOpen ? newCustomer : null,
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
        <div className="alert alert-bad">
          <p>{errorText(save.error)}</p>
          {priceFloorIssue && (
            <p className="detail-why">
              第 {priceFloorIssue.lineNo ?? '?'} 行售价低于加权平均批次成本（下限{' '}
              {priceFloorIssue.costFloor ?? '—'}）。本批没有审批端点（D20），
              需先完成 platform 审批再重试——这里不代做审批。
            </p>
          )}
        </div>
      )}
      {shipOrder.error && <p className="alert alert-bad">发货失败：{errorText(shipOrder.error)}</p>}
      {completeOrder.error && (
        <p className="alert alert-bad">签收失败：{errorText(completeOrder.error)}</p>
      )}
      {actionError && <p className="alert alert-bad">{actionError}</p>}
      {notice && <p className="alert alert-warn">{notice}</p>}

      {/*
        列表区（v0.13）。四态由容器与 tbody 上的 `data-state` 驱动，**不写 JSX 分支**：
        `app-v013.css` 的 `[data-state] > .st-block` 与 `tbody[data-state="…"] > tr.st-tr.st-*`
        负责显隐，这样状态切换时表头宽度不变、列不会塌。

        **数据行只带 `r-row`，不要带 `st-tr`**：`tbody > tr.st-tr` 是「默认隐藏、按状态显露」
        的规则，`st-tr` 又带 `td{padding:0;border-bottom:none}`。数据行一旦也标 `st-tr`，
        `filled` 状态下没有任何规则把它改回 `display:table-row`，整张表只剩表头（已修，见 #337）。
      */}
      <div className="card list-card" data-state={listState}>
        <div className="tw">
          <table className="w-full min-w-[1120px] text-left">
            <thead>
              <tr>
                <SortableHead field="orderNo" current={sort} order={order} onSort={handleSort}>
                  单号
                </SortableHead>
                <th>客户</th>
                <th>商品</th>
                <th className="num">数量</th>
                <SortableHead
                  field="totalAmount"
                  current={sort}
                  order={order}
                  onSort={handleSort}
                  className="num"
                >
                  金额
                </SortableHead>
                <th>状态</th>
                <th>经手人</th>
                <SortableHead field="createdAt" current={sort} order={order} onSort={handleSort}>
                  开单时间
                </SortableHead>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              {/* 三个状态行：同一 tbody 内，CSS 按 data-state 只显示其中一个 */}
              <tr className="st-tr st-loading">
                <td colSpan={9}>
                  <ListLoading label="正在加载销售单…" />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={9}>
                  <ListError
                    title="销售单加载失败"
                    error={list.error ?? null}
                    onRetry={() => void list.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={9}>
                  <ListEmpty title="暂无销售单。可调整筛选条件，或用右上角「+ 新建」开第一张。" />
                </td>
              </tr>
              {rows.map((order) => (
                <tr key={order.id} className="r-row">
                  <td className="whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setDetailId(order.id)}
                      className="doc-link"
                    >
                      {order.orderNo}
                    </button>
                  </td>
                  <td className="whitespace-nowrap">{order.customerName}</td>
                  <td className="cell-muted">{orderProductSummary(products, order.lines)}</td>
                  <td className="num whitespace-nowrap">{formatQty(totalLineQty(order.lines))}</td>
                  <td className="num whitespace-nowrap">
                    {canViewPrice ? formatMoney(order.totalAmount) : MASKED_AMOUNT}
                  </td>
                  <td className="whitespace-nowrap">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="whitespace-nowrap">
                    {/*
                      经手人列原先直接 `shortId(handlerId)` —— 界面上是一串 8 位十六进制，
                      对使用者没有意义（详情里同一个字段明明显示的是姓名）。走姓名簿，
                      `null`（无权查看负责人，Issue #227）才回破折号。
                    */}
                    {order.handlerId ? employeeLabel(order.handlerId) : '—'}
                  </td>
                  <td className="num whitespace-nowrap cell-muted">
                    {formatShortDateTime(order.createdAt)}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <div className="row-acts">
                      {/*
                        这一格原来还有「详情」——和点单号进的是同一个页面，纯冗余。
                        补「商品」列后 9 列装不下 1150px 的卡片，先去掉重复入口，
                        留下三个改状态的按钮。
                      */}
                      <button
                        type="button"
                        disabled={!can('update') || !canViewPrice || order.status !== '进行中'}
                        onClick={() => void withFreshDetail(order.id, beginEdit)}
                        className="btn btn-row"
                        title={
                          orderEditBlockedText({
                            domain: 'sales',
                            canUpdate: can('update'),
                            canViewPrice,
                            status: order.status,
                          }) ?? undefined
                        }
                      >
                        编辑
                      </button>
                      {/*
                        这一格原叫「完成」，但它调的是 `askShip`（出库，D94 之后「完成」专指
                        客户签收）—— 同一个页面上两个动作两种叫法，用户会以为点的是签收。
                      */}
                      <button
                        type="button"
                        disabled={!can('ship') || order.status !== '进行中' || shipOrder.isPending}
                        onClick={() => void withFreshDetail(order.id, askShip)}
                        title={
                          !can('ship')
                            ? '当前身份没有 sales.ship 权限'
                            : order.status !== '进行中'
                              ? '仅「进行中」状态的销售单可出库'
                              : undefined
                        }
                        className="btn btn-row"
                      >
                        发货
                      </button>
                      <button
                        type="button"
                        disabled={!can('delete') || order.status !== '进行中' || cancelOrder.isPending}
                        onClick={() => void withFreshDetail(order.id, askCancel)}
                        className="btn btn-row danger"
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
        {/*
          页脚条（v3.0 `.tf`）：左「共 N 张（· 合计）」，右首 / 上 / 页码 / 下 / 末 + 条数。
          `total` 为 null 说明后端还走游标模式（老端点），这时不画分页——画了也点不动。
        */}
        <div className="tf">
          <span>
            共 {total ?? rows.length} 张
            {salesSum !== null ? (
              <>
                {' '}
                · 合计 <b className="num">{formatMoney(salesSum)}</b>
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
              label="销售单分页"
            />
          )}
        </div>
      </div>

      {detailId !== null && (
        <>
          {detail.isPending && <p className="alert alert-info">正在加载销售单详情…</p>}
          {detail.error && <p className="alert alert-bad">{errorText(detail.error)}</p>}
          {detailOrder && (
            <DetailPanel
              order={detailOrder}
              products={products}
              batches={detailBatches}
              canViewPrice={canViewPrice}
              canUpdate={can('update')}
              canShip={can('ship')}
              canComplete={can('approve')}
              canCancel={can('delete')}
              canCreatePayment={allows(meData?.scope, 'payment', 'create')}
              busy={shipOrder.isPending || completeOrder.isPending || cancelOrder.isPending}
              onClose={() => setDetailId(null)}
              onEdit={() => beginEdit(detailOrder)}
              onShip={() => askShip(detailOrder)}
              onComplete={() => askComplete(detailOrder)}
              onCancel={() => askCancel(detailOrder)}
              onPrint={() => print.mutate(detailOrder.id)}
              onRefresh={() => void queryClient.invalidateQueries({ queryKey: ['sales-orders'] })}
              onError={setActionError}
            />
          )}
        </>
      )}
    </section>
  );
}
