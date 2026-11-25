/**
 * 加工单 B 页面（`/processing-orders`，22 页 IA 第 4 页）。
 *
 * 外观对齐 v0.13 视觉稿 `design/v0.13/加工单B.html`（#337 单据组第五批）：
 * 页头 `.p-head`、状态分段 `.seg`、列表 `.card[data-state]`、详情 `DetailHead` +
 * `DocMeta` + `LinesFooter`；金额受「看价」权限控制（D27 / D79）。
 *
 * 与视觉稿的两处**故意不照抄**：
 * - 分段里没有「草稿」：契约 `ProcessingOrderStatusSchema` 只有
 *   进行中 / 在途 / 已完成 / 已取消（`packages/contracts/src/processing-orders.ts`），
 *   画一个永远筛不出数据的按钮只会在测试里挂；
 * - 页头没有「导出」：没有对应的导出端点，不画假按钮（与采购单页同口径）。
 *
 * 与原型不同的地方，都是本批接口口径决定的：
 * - **「完成 / 验收」需要 `processing.approve`**：一次填入损耗量，完成时扣材料、
 *   生成产出批次并锁价；全损耗（可售量 = 0）必须二次确认（D5 / F3 / G2）；
 * - **投入量由材料行合计自动派生**（F2b：各行 `qty` 合计必须等于 `inputQty`），
 *   让人手填两个数字去对齐是故意制造 422；
 * - 材料投入要选批次，批次来自 inventory 只读端点；一个批次都没有时页面说清原因，
 *   不让人对着空气开单。
 */

import type {
  InventoryBatch,
  ProcessingOrderCompleteBody,
  ProcessingOrderDetail,
  ProcessingOrderStatus,
  Product,
  Processor,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { fetchEmployees } from '../../api/platform';
import { BatchPager } from '../../components/ListPager';
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
import { useCompanyLabel } from '../../lib/company-directory';
import { employeeDirectoryKey, useEmployeeLabel } from '../../lib/employee-directory';
import { resolveListState } from '../../lib/list-state';
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
  compareDecimal,
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
  EMPTY_NEW_PROCESSOR,
  buildProcessorDraft,
  isAttributionDoc,
  isFullLoss,
  processingApi,
  processingQueryKeys,
  sellableQtyText,
  type NewProcessorFields,
} from './processing-api';
import { ProcessingShipDialog } from './ShipDialog';
import {
  buildShipInput,
  emptyShipDraft,
  receiveBlockedText,
  revokeReasonError,
  revokeShipBlockedText,
  shipBlockedText,
  validateShipDraft,
  type ShipDraft,
} from './ship-flow';

/**
 * 状态色档（v0.13 `.st` 系列，见 `components/OrderDetailUI.tsx` 的选档规则）：
 * 进行中还要人干活 → `now`；货在路上 → `transit`；已完成 → `ok`；已取消 → `cancel`。
 *
 * 以前这里用 Tailwind `bg-blue-50` 一类自拼色，结果「在途」在采购单是琥珀、在加工单
 * 是蓝色、在冲正页又是第三种黄 —— 同一个状态在不同页变三种颜色的代价比换色板大得多。
 */
const STATUS_TONE: Readonly<Record<ProcessingOrderStatus, DocPillTone>> = {
  进行中: 'now',
  // D94：料或成品在途，等收货方确认。
  在途: 'transit',
  已完成: 'ok',
  已取消: 'cancel',
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

/** 完成 / 验收前校验：损耗量由服务端再做一次同口径校验（F3 / G2）。 */
export function validateCompletionDraft(
  inputQty: string,
  lossQty: string,
  confirmFullLoss: boolean,
): string[] {
  const errors: string[] = [];
  const loss = lossQty.trim();
  if (!isPositiveDecimal(loss)) {
    return ['损耗量必须是非负数字（最多 6 位小数）。'];
  }
  if (compareDecimal(loss, inputQty) > 0) {
    errors.push('损耗量不能大于投入量。');
  } else if (isFullLoss(inputQty, loss) && !confirmFullLoss) {
    errors.push('可售量为 0 属于全损耗，请勾选二次确认。');
  }
  return errors;
}

/** 提交前的本地校验：只挡「明显错」，字段级口径仍以服务端 422 为准。 */
export function validateDraft(
  processorId: string,
  outputProductId: string,
  materials: readonly MaterialDraft[],
  fees: readonly FeeDraft[],
  auxMaterials: string,
  attributionDoc: string,
  /**
   * 开单现场建档（D100）：传了它就**不再要求** `processorId`，改为要求加工厂名称。
   * 与 A / E 两单同一口径。
   */
  newProcessor?: { readonly name: string } | null,
): string[] {
  const errors: string[] = [];
  if (newProcessor) {
    const name = newProcessor.name.trim();
    if (name === '') errors.push('新建加工厂：请填写加工厂名称');
    else if (name.length > 64) errors.push('新建加工厂：名称最多 64 字');
  } else if (!processorId) {
    errors.push('请选择加工厂');
  }
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
  return <DocPill label={status} tone={STATUS_TONE[status] ?? 'cancel'} />;
}

/**
 * 开单现场建档的内联小表单（D100「静默建档」）。
 *
 * 只有名称与联系人两个输入：`processor` 表没有电话列（迁移 0006），契约
 * `ProcessorDraftSchema` 也不收 —— 多画一个电话框只会让人填了却存不下。
 */
export function NewProcessorInlineForm({
  fields,
  onChange,
}: {
  readonly fields: NewProcessorFields;
  readonly onChange: (patch: Partial<NewProcessorFields>) => void;
}) {
  return (
    <div className="form-sec">
      <div className="form-sec-b fm">
        <label>
          <span>加工厂名称（必填）</span>
          <input
            aria-label="新建加工厂名称"
            value={fields.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <label>
          <span>联系人（选填）</span>
          <input
            aria-label="新建加工厂联系人"
            value={fields.contactName}
            onChange={(event) => onChange({ contactName: event.target.value })}
          />
        </label>
        {/* `.fm > .w` 横跨整行 */}
        <p className="detail-why w">
          保存单据时一起建档，不必先去主数据页。建档对你是透明的 —— 保存成功后只提示单据保存，
          不额外提示建档结果，也不需要建加工厂权限（有开单权即可）。
        </p>
      </div>
    </div>
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
  /** 开单现场建档（D100）：打开后加工厂走草档，下拉被替换。 */
  readonly newProcessorOpen: boolean;
  readonly newProcessor: NewProcessorFields;
  readonly onNewProcessorToggle: (open: boolean) => void;
  readonly onNewProcessorChange: (patch: Partial<NewProcessorFields>) => void;
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
  newProcessorOpen,
  newProcessor,
  onNewProcessorToggle,
  onNewProcessorChange,
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
  const companyLabel = useCompanyLabel();
  const inputQty = materialTotal(materials);
  const feeTotal = sumDecimal(fees.map((fee) => feeAmountOf(fee)));

  return (
    <form onSubmit={onSubmit} className="form-card">
      <div className="form-head">
        <h2>{editing ? `编辑加工单 ${editing.orderNo}` : '新建加工单'}</h2>
        <span className="detail-why">
          单号由服务端生成（D16）；损耗量在「完成 / 验收」时一次填入（F3）。
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
          <span>加工厂</span>
          {newProcessorOpen ? (
            <p className="fm-readonly">
              开单时新建：
              <b className="cell-clip">
                {newProcessor.name.trim() === '' ? '在下方填名称' : newProcessor.name.trim()}
              </b>
            </p>
          ) : (
            <select
              required
              value={processorId}
              onChange={(event) => onProcessorChange(event.target.value)}
            >
              <option value="">请选择加工厂</option>
              {processors.map((processor) => (
                <option key={processor.id} value={processor.id}>
                  {processor.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          <span>成品商品</span>
          <select
            required
            value={outputProductId}
            onChange={(event) => onOutputProductChange(event.target.value)}
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
        {/* 经手人 = 当前登录人，改不了；用只读块而不是输入框 */}
        <label>
          <span>经手人</span>
          <p className="fm-readonly">{handlerName}</p>
        </label>
      </div>

      {/**
       * 开单现场建档（D100）：只能开单时用。改单顺带建新加工厂会让「这张单原来给谁做」
       * 无从追溯。
       */}
      {editing === null && (
        <div className="form-stack">
          <button
            type="button"
            onClick={() => onNewProcessorToggle(!newProcessorOpen)}
            className="btn btn-s form-add"
          >
            {newProcessorOpen ? '取消新建，改从已有加工厂里选' : '+ 新建加工厂'}
          </button>
          {newProcessorOpen && (
            <NewProcessorInlineForm fields={newProcessor} onChange={onNewProcessorChange} />
          )}
        </div>
      )}

      {(processors.length === 0 || products.length === 0 || batches.length === 0) && (
        <div className="alert alert-warn alert-sm">
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

      <div className="form-stack">
        <div className="form-head">
          <h3 className="form-title">材料投入</h3>
          <span className="detail-why">
            投入量合计 <b className="mono">{formatQty(inputQty)}</b>
            （由各行自动汇总，F2b 要求与投入量一致）
          </span>
        </div>

        <div className="ln">
          <table>
            <thead>
              <tr>
                <th>批次</th>
                <th className="num">投入数量</th>
                <th className="num">可用量</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {materials.map((row, index) => {
                const batch = batches.find((item) => item.id === row.batchId);
                return (
                  <tr key={index}>
                    <td>
                      {batches.length > 0 ? (
                        <select
                          required
                          value={row.batchId}
                          onChange={(event) => onMaterialChange(index, { batchId: event.target.value })}
                          className="ipt"
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
                          className="ipt mono"
                        />
                      )}
                    </td>
                    <td>
                      <input
                        required
                        inputMode="decimal"
                        value={row.qty}
                        onChange={(event) => onMaterialChange(index, { qty: event.target.value })}
                        placeholder="0"
                        className="ipt"
                      />
                    </td>
                    <td className="num cell-muted">
                      {batch ? formatQty(batch.availableQty) : '—'}
                    </td>
                    <td className="row-acts">
                      <button
                        type="button"
                        onClick={() => onRemoveMaterial(index)}
                        disabled={materials.length <= 1}
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

        <button type="button" onClick={onAddMaterial} className="btn form-add">
          + 加一行材料
        </button>

        <div className="fm">
          <label className="w">
            <span>辅料（选填，默认我方采购，进成本）</span>
            <input
              value={auxMaterials}
              onChange={(event) => onAuxMaterialsChange(event.target.value)}
              placeholder="如：包装膜 20 卷、胶水 5 桶"
            />
          </label>
        </div>
      </div>

      <div className="form-stack">
        <div className="form-head">
          <h3 className="form-title">费用明细</h3>
          <span className="detail-why">
            加工费 / 运杂费，金额必须 ≥ 0（D39）；合计{' '}
            <b className="mono">{formatMoney(feeTotal)}</b>
          </span>
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
                        onChange={(event) => onFeeChange(index, { feeName: event.target.value })}
                        placeholder="加工费 / 运费"
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
                        onChange={(event) => onFeeChange(index, { unitPrice: event.target.value })}
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

      <div className="fm">
        <label>
          <span>归属单（选填，全损耗时用于损失归属，D18 / D35）</span>
          <input
            value={attributionDoc}
            onChange={(event) => onAttributionDocChange(event.target.value)}
            placeholder="E-0001-20261105-0001 或 N-0001-20261105-0001"
            className="ipt mono"
          />
        </label>
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

export interface CompletionPanelProps {
  readonly order: ProcessingOrderDetail;
  readonly lossQty: string;
  readonly confirmFullLoss: boolean;
  readonly errors: readonly string[];
  readonly busy: boolean;
  readonly onLossQtyChange: (value: string) => void;
  readonly onConfirmFullLossChange: (value: boolean) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onCancel: () => void;
}

export function CompletionPanel({
  order,
  lossQty,
  confirmFullLoss,
  errors,
  busy,
  onLossQtyChange,
  onConfirmFullLossChange,
  onSubmit,
  onCancel,
}: CompletionPanelProps) {
  const normalizedLoss = lossQty.trim();
  const sellable =
    isPositiveDecimal(normalizedLoss) && compareDecimal(normalizedLoss, order.inputQty) <= 0
      ? sellableQtyText(order.inputQty, normalizedLoss)
      : null;
  const fullLoss = isFullLossForCompletion(order.inputQty, normalizedLoss);

  return (
    <form onSubmit={onSubmit} className="form-card">
      <div className="form-head">
        <h2>完成 / 验收 {order.orderNo}</h2>
        <span className="detail-why">
          损耗量只填一次；确认后扣减材料、生成产出批次并按 D5 锁价，不可回退。
        </span>
      </div>

      <div className="fm c3">
        <label>
          <span>投入量</span>
          <p className="fm-readonly">{formatQty(order.inputQty)}</p>
        </label>
        <label>
          <span>损耗量</span>
          <input
            required
            inputMode="decimal"
            value={lossQty}
            onChange={(event) => onLossQtyChange(event.target.value)}
            placeholder="0"
          />
        </label>
        <label>
          <span>可售量</span>
          <p className="fm-readonly">
            {sellable === null ? '待填入损耗量' : formatQty(sellable)}
          </p>
        </label>
      </div>

      {fullLoss ? (
        /* 全损耗要二次确认：淡底实字的警示块（`.alert-warn`），勾选框放在块内。
           外层用 div 而不是 label —— `.alert` 靠 `padding` 撑盒子，label 是 inline，
           直接挂上去上下内边距会压到相邻元素。 */
        <div className="alert alert-warn alert-sm">
          <label>
            <input
              type="checkbox"
              checked={confirmFullLoss}
              onChange={(event) => onConfirmFullLossChange(event.target.checked)}
            />{' '}
            可售量为 0，属于全损耗：确认后会扣减全部材料、不生成产出批次，材料与加工费全额记损失。
          </label>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <ul className="alert alert-bad alert-sm">
          {errors.map((message) => (
            <li key={message}>· {message}</li>
          ))}
        </ul>
      ) : null}

      <div className="detail-acts">
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? '完成中…' : fullLoss ? '确认全损耗并完成' : '确认完成'}
        </button>
        <button type="button" onClick={onCancel} className="btn">
          取消
        </button>
        <span className="detail-why">
          提交会带当前单据版本；若被他人改过，页面会提示并同步最新状态。
        </span>
      </div>
    </form>
  );
}

function isFullLossForCompletion(inputQty: string, lossQty: string): boolean {
  return (
    isPositiveDecimal(lossQty) &&
    compareDecimal(lossQty, inputQty) <= 0 &&
    isFullLoss(inputQty, lossQty)
  );
}

interface DetailPanelProps {
  readonly order: ProcessingOrderDetail;
  readonly products: readonly Product[];
  readonly batches: readonly InventoryBatch[];
  /**
   * 经手人展示文案。契约里只有 `handlerId`，并且**无权查看负责人时服务端回 `null`**
   * （Issue #227），所以这段文案由页面统一算好传进来，面板不自己查姓名簿。
   */
  readonly handlerLabel: string;
  readonly canViewPrice: boolean;
  readonly canUpdate: boolean;
  readonly canPrint: boolean;
  readonly canCancel: boolean;
  readonly canComplete: boolean;
  /** 发货 / 撤销发货：`processing.ship`（D94 ② 的运输两步）。 */
  readonly canShip: boolean;
  /** 到货确认：`processing.approve`（验收动作，与发货是两拨人）。 */
  readonly canReceive: boolean;
  readonly canceling: boolean;
  readonly completing: boolean;
  readonly shipping: boolean;
  readonly revoking: boolean;
  readonly receiving: boolean;
  /** 撤销原因：非受控在页面，面板只渲染与回传。 */
  readonly revokeReason: string;
  readonly revokeError: string | null;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onComplete: () => void;
  readonly onPrint: () => void;
  readonly onShip: () => void;
  readonly onRevokeReasonChange: (value: string) => void;
  readonly onRevoke: () => void;
  readonly onReceive: () => void;
}

/**
 * 详情面板「编辑」的禁用原因，三态口径（#261 / P0-08）。
 *
 * 顺序是**先权限后状态**：没有权限的人改不了单，先告诉他缺哪个权限点；
 * 有权限但状态不允许，再说状态——两句话同时给会让用户不知道该找谁。
 */
export function editBlockedText(input: {
  readonly canUpdate: boolean;
  readonly canViewPrice: boolean;
  readonly status: ProcessingOrderDetail['status'];
}): string | null {
  if (!input.canUpdate) return '当前身份没有 processing.update 权限';
  if (!input.canViewPrice) return '无看价权限：看不到加工费就没法改单（processing.view_price）';
  if (input.status !== '进行中') {
    return `只有「进行中」的加工单能编辑，当前是「${input.status}」`;
  }
  return null;
}

/**
 * 「打印发厂联」的禁用原因。
 *
 * 打印本质是读取后输出，不新增权限点，用 `processing.read`（#261 要求 2）。
 */
export function printBlockedText(canPrint: boolean): string | null {
  return canPrint ? null : '当前身份没有 processing.read 权限';
}

/**
 * 导出给静态渲染测试用（#261 要求 4）：页面本体要靠交互才能打开详情面板，
 * 纯 `renderToStaticMarkup` 到不了，只能单独渲染面板验证按钮三态。
 */
export function DetailPanel({
  order,
  products,
  batches,
  handlerLabel,
  canViewPrice,
  canUpdate,
  canPrint,
  canCancel,
  canComplete,
  canShip,
  canReceive,
  canceling,
  completing,
  shipping,
  revoking,
  receiving,
  revokeReason,
  revokeError,
  onClose,
  onEdit,
  onCancel,
  onComplete,
  onPrint,
  onShip,
  onRevokeReasonChange,
  onRevoke,
  onReceive,
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
  const editBlocked = editBlockedText({ canUpdate, canViewPrice, status: order.status });
  const printBlocked = printBlockedText(canPrint);
  /** D94 ②：三个运输动作的禁用原因，口径全在 `ship-flow`（先权限后状态，只出一句）。 */
  const shipBlocked = shipBlockedText({ canShip, status: order.status });
  const revokeBlocked = revokeShipBlockedText({ canShip, status: order.status });
  const receiveBlocked = receiveBlockedText({ canApprove: canReceive, status: order.status });

  /**
   * 「完成 / 验收」的禁用原因。顺序仍是先权限后状态，但「在途」要单独说 ——
   * D94 ② 之后在途的正确出口是「到货确认」，直接点完成会拿到 422，不如先把路指出来。
   */
  const completeBlocked = !canComplete
    ? '当前身份没有 processing.approve 权限（完成会扣材料、建产出批次，属于审批动作）'
    : order.status === '在途'
      ? '这张单在途，请点「到货确认」入库；要退回可点「撤销发货」。'
      : order.status === '进行中'
        ? null
        : `只有「进行中」的加工单能完成，当前是「${order.status}」`;

  return (
    <section className="card detail">
      <DetailHead
        docLabel="加工单"
        orderNo={order.orderNo}
        pill={<StatusBadge status={order.status} />}
        meta={
          <>
            <span>{order.processorName}</span>
            <DetailMetaDot />
            <span>成品：{productLabel(products, order.outputProductId)}</span>
            <DetailMetaDot />
            <span>开单 {formatDateTime(order.createdAt)}</span>
            <DetailMetaDot />
            <span>最近更新 {formatDateTime(order.updatedAt)}</span>
            <DetailMetaDot />
            <span>版本 {order.version}</span>
            {order.status === '在途' && order.transitStage ? (
              <>
                <DetailMetaDot />
                <span>
                  在途：{order.transitStage === 'materials' ? '料段' : '成品段'} ·{' '}
                  {order.transitTo === 'customer' ? '直发客户' : '回仓'}
                </span>
              </>
            ) : null}
          </>
        }
        onClose={onClose}
        closeLabel="收起"
      />

      {/*
        材料明细加一列「商品」：批次号本身看不出投的是什么料，而契约里一行只有
        `batchId`，商品名要靠批次 → 商品映射回填。三列撑满 1100px 也会显得空。
      */}
      <div className="ln">
        <table>
          <thead>
            <tr>
              <th>投入批次</th>
              <th>商品</th>
              <th className="num">投入数量</th>
              <th className="num">批次可用量</th>
            </tr>
          </thead>
          <tbody>
            {order.materialBatchIds.map((row, index) => {
              const batch = batches.find((item) => item.id === row.batchId);
              return (
                <tr key={`${row.batchId}-${index}`}>
                  <td className="mono">{batchLabel(batches, row.batchId)}</td>
                  <td className="cell-muted">
                    {batch ? productLabel(products, batch.productId) : '—'}
                  </td>
                  <td className="num">{formatQty(row.qty)}</td>
                  <td className="num cell-muted">
                    {batch ? formatQty(batch.availableQty) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <LinesFooter
            colSpan={3}
            note={`共 ${order.materialBatchIds.length} 行批次 · 投入量由各行合计派生（F2b）`}
            sum={formatQty(order.inputQty)}
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
                <th className="num">金额</th>
                <th>备注</th>
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
                  <td className="num">
                    {canViewPrice ? formatMoney(fee.amount) : MASKED_AMOUNT}
                  </td>
                  <td className="cell-muted">{fee.remark ?? '—'}</td>
                </tr>
              ))}
            </tbody>
            <LinesFooter
              colSpan={4}
              note={`共 ${order.fees.length} 行费用 · 完成时按投入量摊入产出批次成本（D5 / D83）`}
              sum={canViewPrice ? formatMoney(feeTotal) : MASKED_AMOUNT}
            />
          </table>
        </div>
      )}

      {/*
        「单据信息」用统一的三列网格（`单据详情.html`）：损耗 / 可售量还没验收时用 `dim`
        弱化而不是写 0 —— 写 0 等于假装「零损耗」，会把批次成本算低（D5 / F3）。
      */}
      <DocMeta
        columns={3}
        items={[
          { label: '加工厂', value: order.processorName },
          { label: '成品', value: productLabel(products, order.outputProductId) },
          { label: '经手', value: handlerLabel },
          { label: '投入量', mono: true, value: formatQty(order.inputQty) },
          {
            label: '损耗量',
            mono: true,
            tone: order.lossQty === null ? 'dim' : undefined,
            value: lossText,
          },
          {
            label: '可售量',
            mono: true,
            tone: order.sellableQty === null ? 'dim' : undefined,
            value: sellableText,
          },
          {
            label: '费用合计',
            mono: true,
            tone: 'money',
            value: canViewPrice ? formatMoney(feeTotal) : MASKED_AMOUNT,
          },
          {
            label: '产出批次',
            mono: true,
            tone: order.outputBatchId === null ? 'dim' : undefined,
            /*
              契约只回 `outputBatchId`，没有 `outputBatchNo` —— 直接渲染就是一条裸 UUID，
              对使用者没有意义。用同一份批次映射换回批次号（材料表也是这张表）。
            */
            value:
              order.outputBatchId === null
                ? '完成时生成'
                : batchLabel(batches, order.outputBatchId),
          },
          {
            label: '归属单',
            mono: true,
            tone: order.attributionDoc === null ? 'dim' : undefined,
            value: order.attributionDoc ?? '—（仅全损耗需要）',
          },
          {
            label: '辅料',
            tone: order.auxMaterials === null ? 'dim' : undefined,
            value: order.auxMaterials ?? '—',
          },
          {
            label: '损失记录',
            tone: order.lossRecord === null ? 'dim' : undefined,
            value: order.lossRecord
              ? `${formatQty(order.lossRecord.lossQty)} / ${
                  canViewPrice ? formatMoney(order.lossRecord.amount) : MASKED_AMOUNT
                } / ${formatDateTime(order.lossRecord.recordedAt)}`
              : '—',
          },
          { label: '开单时间', mono: true, value: formatDateTime(order.createdAt) },
        ]}
      />

      {/*
        动作区按状态分段出现（与采购单页同口径）：只在当前状态说得通的动作才画，
        否则一排六个按钮里有四个是灰的，用户得逐个悬停才知道哪个能用。
        「完成 / 验收」是 D94 ② 之前的一次性老路径，在途时明确指向「到货确认」。

        禁用原因改成跟动作同一行（`detail-why`）：原来另起一行 `flex gap-x-4 gap-y-1`，
        七条原因挤成两三行、又和按钮挨不上；放同一行后「哪个按钮为什么点不动」是挨着说的。
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
              onClick={onRevoke}
              disabled={revokeBlocked !== null || revoking}
              title={revokeBlocked ?? undefined}
              className="btn"
            >
              {revoking ? '撤销中…' : '撤销发货'}
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
          {completing ? '完成中…' : '完成 / 验收'}
        </button>
        <button
          type="button"
          onClick={onPrint}
          disabled={printBlocked !== null}
          title={printBlocked ?? undefined}
          className="btn"
        >
          打印发厂联
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={!order.cancelable.allowed || !canCancel || canceling}
          className="btn danger act-end"
        >
          {canceling ? '取消中…' : '取消加工单'}
        </button>

        {/*
          禁用原因都要说出口，不能只挂在 `title` 上 —— 鼠标不在按钮上时用户只看到「点不动」。
          状态不对的不重复喊（按钮已经灰了），只把「缺哪个权限点」和「在途该走哪条路」写出来。
        */}
        {cancelReason && <span className="detail-why">{cancelReason}</span>}
        {editBlocked && <span className="detail-why">{editBlocked}</span>}
        {printBlocked && <span className="detail-why">{printBlocked}</span>}
        {completeBlocked && <span className="detail-why">{completeBlocked}</span>}
        {!canCancel && order.cancelable.allowed && (
          <span className="detail-why">当前身份无取消权限（processing.delete）</span>
        )}
        {shipBlocked && order.status === '进行中' && (
          <span className="detail-why">{shipBlocked}</span>
        )}
        {order.status === '在途' && receiveBlocked && (
          <span className="detail-why">{receiveBlocked}</span>
        )}
      </div>

      {/**
       * 撤销原因只在「在途 + 有 processing.ship」时出现：撤销会是这里唯一能回退的路，
       * 而回退会把单据打回「进行中」、清空在途分段，事后没人知道为什么，所以必须写原因
       * （契约路由标了 `ai.reasonRequired`，原因走 `X-Reason` 头进审计）。
       * 填完原因点上面动作区的「撤销发货」提交 —— 这里只放输入，不重复放按钮。
       */}
      {revokeBlocked === null && (
        <div className="alert alert-bad">
          <h4>撤销发货</h4>
          <p>
            撤销会把单据退回「进行中」，清掉这一单的在途分段与去向（不动库存流水），之后可重新发货。
          </p>
          <label className="reason-field">
            <span>撤销原因（必填，会记审计）</span>
            <input
              value={revokeReason}
              onChange={(event) => onRevokeReasonChange(event.target.value)}
              maxLength={200}
              aria-label="撤销原因"
              placeholder="例如：加工厂说料没收到，重新安排发货"
              className="ipt"
            />
          </label>
          {revokeError && <p className="detail-why">{revokeError}</p>}
        </div>
      )}
    </section>
  );
}

export function ProcessingOrdersPage() {
  const companyLabel = useCompanyLabel();
  const employeeLabel = useEmployeeLabel();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me });
  const meData = me.data;
  const can = (action: ScopeAction) => allows(meData?.scope, 'processing', action);
  const canViewPrice = can('view_price');
  const companyIds = meData?.companyIds ?? [];

  const [companyId, setCompanyId] = useState('');
  const [processorFilter, setProcessorFilter] = useState('');
  const [status, setStatus] = useState<'' | ProcessingOrderStatus>('');
  /**
   * 看谁的（D106）。空串 = 不传参数，由服务端按权限定。
   *
   * 只在有 `processing.read_all` 时给这个开关 —— 没权限的人拿到一个切不动的下拉框
   * 比没有更糟：他会以为「全部」里应该有别人的单，只是自己点不动。
   */
  const [scopeFilter, setScopeFilter] = useState<'' | 'mine' | 'all'>('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProcessingOrderDetail | null>(null);
  const [formCompanyId, setFormCompanyId] = useState('');
  const [formProcessorId, setFormProcessorId] = useState('');
  /**
   * 开单现场建档（D100）：打开后加工厂不选下拉，改为填草档随单据一起提交。
   * 与 `formProcessorId` 分开是因为「打开了但没填名称」与「没打开」报的错不同。
   */
  const [newProcessorOpen, setNewProcessorOpen] = useState(false);
  const [newProcessor, setNewProcessor] = useState<NewProcessorFields>({ ...EMPTY_NEW_PROCESSOR });
  const [formOutputProductId, setFormOutputProductId] = useState('');
  const [materials, setMaterials] = useState<MaterialDraft[]>([{ ...EMPTY_MATERIAL }]);
  const [fees, setFees] = useState<FeeDraft[]>([{ ...EMPTY_FEE }]);
  const [auxMaterials, setAuxMaterials] = useState('');
  const [attributionDoc, setAttributionDoc] = useState('');
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 版本冲突后已把最新 version 接上时的提示（与红色报错互斥）。 */
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [completingOrder, setCompletingOrder] = useState<ProcessingOrderDetail | null>(null);
  const [completionLossQty, setCompletionLossQty] = useState('');
  const [completionConfirmFullLoss, setCompletionConfirmFullLoss] = useState(false);
  const [completionErrors, setCompletionErrors] = useState<string[]>([]);
  /** D94 ②：发货弹层的目标单 + 草稿 + 校验错误（弹层字段多，不用 `confirm`）。 */
  const [shippingOrder, setShippingOrder] = useState<ProcessingOrderDetail | null>(null);
  const [shipDraft, setShipDraft] = useState<ShipDraft>(emptyShipDraft());
  const [shipErrors, setShipErrors] = useState<string[]>([]);
  /** 撤销原因：详情面板渲染、页面持有——面板里没有理由自己记住输入。 */
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const printUrlRef = useRef<string | null>(null);

  const processorsQuery = useQuery({
    queryKey: processingQueryKeys.processors,
    queryFn: () => masterdataApi.listProcessors({ limit: 200 }),
    staleTime: 5 * 60_000,
  });
  const productsQuery = useQuery({
    queryKey: processingQueryKeys.products,
    queryFn: () => masterdataApi.listProducts({ limit: 200 }),
    staleTime: 5 * 60_000,
  });
  const processors = processorsQuery.data?.items ?? [];
  const products = productsQuery.data?.items ?? [];

  /**
   * 损失保管人下拉的数据源：发货弹层打开时才拉（`enabled`），拉不到就静默降级。
   * 读员工要组织域权限，仓管通常没有 → 403；保管人只是选填，不该因为查不到就发不了货。
   */
  const custodiansQuery = useQuery({
    queryKey: employeeDirectoryKey,
    queryFn: async () => (await fetchEmployees()).items,
    staleTime: 5 * 60_000,
    retry: false,
    enabled: shippingOrder !== null,
  });
  const custodians = useMemo(
    () => (custodiansQuery.data ?? []).map((employee) => ({ id: employee.id, name: employee.name })),
    [custodiansQuery.data],
  );
  const custodiansError = custodiansQuery.isError
    ? '读不到员工名单（可能没有组织域权限）：损失保管人只能先不指定。'
    : null;

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
      scope: scopeFilter || undefined,
    }),
    [companyId, processorFilter, status, keyword, cursors, pageIndex, scopeFilter],
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
    setNewProcessorOpen(false);
    setNewProcessor({ ...EMPTY_NEW_PROCESSOR });
    setFormOutputProductId('');
    setMaterials([{ ...EMPTY_MATERIAL }]);
    setFees([{ ...EMPTY_FEE }]);
    setAuxMaterials('');
    setAttributionDoc('');
    setClientErrors([]);
    save.reset();
    setStaleNotice(null);
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
        /** 二选一（D100）：两个都给会被服务端 422（`details.field = processorId`）。 */
        ...(newProcessorOpen
          ? { processorDraft: buildProcessorDraft(newProcessor) }
          : { processorId: formProcessorId }),
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
    /**
     * 版本冲突（别人先改过）：把最新 version 接回表单，用户点一次「保存修改」就能过。
     * 不自动重提——那等于拿旧内容覆盖别人的改动，得让用户先核对（D60）。
     */
    onError: async (error) => {
      if (!editing) return;
      const fresh = await recoverFromStaleVersion(error, editing.id, processingApi.detail);
      if (!fresh) {
        // 非 stale 的红条由 `save.error` 渲染；stale 但读不到最新版本时那条被抑制，必须在这里兜底
        if (isStaleVersionError(error)) setActionError(staleUnrecoveredText());
        return;
      }
      setEditing({ ...editing, version: fresh.version });
      setStaleNotice(staleVersionRecoveredText(fresh.version));
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
    },
  });

  const cancelOrder = useMutation({
    mutationFn: (order: ProcessingOrderDetail) =>
      processingApi.cancel(order.id, order.version),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
    },
    /**
     * 取消撞版本冲突（别人刚改过 / 刚取消了这张单）：同步最新版本并说明，
     * 不自动重提——取消不可逆，让用户看清当前状态再点（D60）。
     */
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, processingApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '取消失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(staleActionRetryText(fresh.version, '取消'));
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
    },
  });

  const completeOrder = useMutation({
    mutationFn: (input: {
      readonly order: ProcessingOrderDetail;
      readonly body: ProcessingOrderCompleteBody;
    }) => processingApi.complete(input.order.id, input.body, input.order.version),
    onSuccess: async (result) => {
      const parts = [`完成成功：${result.outputBatch ? '已生成产出批次' : '全损耗，未生成产出批次'}`];
      if (result.outputBatch) {
        parts.push(`批次 ${result.outputBatch.batchNo}`);
        parts.push(`数量 ${formatQty(result.outputBatch.qty)}`);
        if (canViewPrice) parts.push(`锁价 ${formatMoney(result.outputBatch.lockedUnitCost)}`);
      }
      if (result.lossRecord) {
        parts.push(`损耗 ${formatQty(result.lossRecord.lossQty)}`);
      }
      setNotice(parts.join('；'));
      setCompletingOrder(null);
      setCompletionLossQty('');
      setCompletionConfirmFullLoss(false);
      setCompletionErrors([]);
      setActionError(null);
      setStaleNotice(null);
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'batches'] });
    },
    onError: async (error, input) => {
      const fresh = await recoverFromStaleVersion(error, input.order.id, processingApi.detail);
      if (!fresh) {
        setCompletionErrors([describeWriteError(error, '完成加工单失败，请稍后重试')]);
        return;
      }
      setCompletionErrors([]);
      if (fresh.status === '进行中') {
        setStaleNotice(staleActionRetryText(fresh.version, '完成 / 验收'));
        setCompletingOrder(fresh);
      } else {
        setStaleNotice(
          `这张单刚被别人更新为「${fresh.status}」（v${fresh.version}），不能再完成。`,
        );
        setCompletingOrder(null);
      }
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
    },
  });

  /**
   * 发货（D94 ②）：`进行中 → 在途`。
   *
   * 入参由 `buildShipInput` 按段裁字段——料段绝不带 `lossQty`（契约 `superRefine` 对
   * 「料段带损耗」是报错，不是忽略）。撞版本冲突时把最新单接回弹层，让人看清再提交。
   */
  const shipOrder = useMutation({
    mutationFn: (input: { readonly order: ProcessingOrderDetail; readonly draft: ShipDraft }) =>
      processingApi.ship(input.order.id, buildShipInput(input.draft), input.order.version),
    onSuccess: async (order) => {
      setNotice(
        `已发货：${order.orderNo} 转「在途」（${
          order.transitStage === 'materials' ? '料段' : '成品段'
        } · ${order.transitTo === 'customer' ? '直发客户' : '回仓'}）。到货确认后才算完成。`,
      );
      setShippingOrder(null);
      setShipDraft(emptyShipDraft());
      setShipErrors([]);
      setActionError(null);
      setStaleNotice(null);
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'batches'] });
    },
    onError: async (error, input) => {
      const fresh = await recoverFromStaleVersion(error, input.order.id, processingApi.detail);
      if (!fresh) {
        setShipErrors([describeWriteError(error, '发货失败，请稍后重试')]);
        return;
      }
      setShipErrors([]);
      if (fresh.status === '进行中') {
        setStaleNotice(staleActionRetryText(fresh.version, '发货'));
        setShippingOrder(fresh);
      } else {
        setStaleNotice(`这张单刚被别人更新为「${fresh.status}」（v${fresh.version}），不能再发货。`);
        setShippingOrder(null);
      }
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
    },
  });

  /**
   * 撤销发货：`在途 → 进行中`，原因走 `X-Reason` 头（契约没有 body schema）。
   *
   * 为什么原因必填：撤销会把在途分段与去向清空、单据打回「进行中」，属于把已发生的
   * 物流动作作废；不给原因，审计里就只剩一条"谁撤的"，不知道为什么撤。
   */
  const revokeShip = useMutation({
    mutationFn: (input: { readonly order: ProcessingOrderDetail; readonly reason: string }) =>
      processingApi.shipRevoke(input.order.id, input.reason, input.order.version),
    onSuccess: async (order) => {
      setNotice(`已撤销发货：${order.orderNo} 回到「进行中」，在途分段已清空，可重新发货。`);
      setRevokeReason('');
      setRevokeError(null);
      setActionError(null);
      setStaleNotice(null);
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'batches'] });
    },
    onError: async (error, input) => {
      const fresh = await recoverFromStaleVersion(error, input.order.id, processingApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '撤销发货失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(
        fresh.status === '在途'
          ? staleActionRetryText(fresh.version, '撤销发货')
          : `这张单刚被别人更新为「${fresh.status}」（v${fresh.version}），已无货可撤。`,
      );
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
    },
  });

  /**
   * 到货确认：`在途 → 已完成`。权限是 `processing.approve`——验收要认损耗、落产出批次，
   * 与「把货交出去」不是同一件事，所以和 `processing.ship` 拆成两个权限点。
   */
  const receiveOrder = useMutation({
    mutationFn: (order: ProcessingOrderDetail) => processingApi.receive(order.id, order.version),
    onSuccess: async (order) => {
      setNotice(`已到货确认：${order.orderNo} 转为「已完成」。`);
      setActionError(null);
      setStaleNotice(null);
      await queryClient.invalidateQueries({ queryKey: ['processing-orders'] });
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'batches'] });
    },
    onError: async (error, order) => {
      const fresh = await recoverFromStaleVersion(error, order.id, processingApi.detail);
      if (!fresh) {
        setActionError(describeWriteError(error, '到货确认失败，请稍后重试'));
        return;
      }
      setActionError(null);
      setStaleNotice(
        fresh.status === '在途'
          ? staleActionRetryText(fresh.version, '到货确认')
          : `这张单刚被别人更新为「${fresh.status}」（v${fresh.version}），没有可确认的到货。`,
      );
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
    setNewProcessorOpen(false);
    setNewProcessor({ ...EMPTY_NEW_PROCESSOR });
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

  const beginComplete = (order: ProcessingOrderDetail) => {
    setCompletingOrder(order);
    setCompletionLossQty(order.lossQty ?? '');
    setCompletionConfirmFullLoss(false);
    setCompletionErrors([]);
    setActionError(null);
    setStaleNotice(null);
    setFormOpen(false);
  };

  const resetCompletion = () => {
    setCompletingOrder(null);
    setCompletionLossQty('');
    setCompletionConfirmFullLoss(false);
    setCompletionErrors([]);
    completeOrder.reset();
  };

  /** 打开「发货」弹层。入口统一走 `withFreshDetail`，拿到的必须是别人刚改过也不怕的最新单。 */
  const beginShip = (order: ProcessingOrderDetail) => {
    setShippingOrder(order);
    setShipDraft(emptyShipDraft());
    setShipErrors([]);
    setRevokeError(null);
    setActionError(null);
    setStaleNotice(null);
    setFormOpen(false);
    shipOrder.reset();
  };

  const resetShip = () => {
    setShippingOrder(null);
    setShipDraft(emptyShipDraft());
    setShipErrors([]);
    shipOrder.reset();
  };

  /**
   * 点击时才重新校验（不只依赖按钮 `disabled`）：列表与详情可能是旧的，别人刚发过货 /
   * 撤销过，用户手上这份状态已经不成立。这里再用最新单对象算一次，不成立就说明原因。
   */
  const shipBlockedNow = (order: ProcessingOrderDetail): string | null =>
    shipBlockedText({ canShip: can('ship'), status: order.status });

  const submitShip = () => {
    if (!shippingOrder) return;
    const blocked = shipBlockedNow(shippingOrder);
    if (blocked) {
      setShipErrors([blocked]);
      return;
    }
    const errors = validateShipDraft(shipDraft, shippingOrder);
    setShipErrors(errors);
    if (errors.length > 0) return;
    shipOrder.mutate({ order: shippingOrder, draft: shipDraft });
  };

  /** 撤销发货：状态、权限、原因三道都在点击时重算一次。 */
  const askRevoke = (order: ProcessingOrderDetail) => {
    const blocked = revokeShipBlockedText({ canShip: can('ship'), status: order.status });
    if (blocked) {
      setActionError(blocked);
      return;
    }
    const error = revokeReasonError(revokeReason);
    if (error) {
      setRevokeError(error);
      return;
    }
    setRevokeError(null);
    setActionError(null);
    revokeShip.mutate({ order, reason: revokeReason.trim() });
  };

  /** 到货确认：不可逆（直接转「已完成」），所以过一道 `confirm`。 */
  const askReceive = (order: ProcessingOrderDetail) => {
    const blocked = receiveBlockedText({ canApprove: can('approve'), status: order.status });
    if (blocked) {
      setActionError(blocked);
      return;
    }
    if (
      globalThis.confirm?.(`确认「${order.orderNo}」的货已到？确认后转为「已完成」，不可撤销。`) ===
      false
    ) {
      return;
    }
    setActionError(null);
    receiveOrder.mutate(order);
  };

  const beginEdit = (order: ProcessingOrderDetail) => {    setEditing(order);
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
    /**
     * 列表行按钮只看「进行中」，服务端还可能因「已完成 / 已被别人取消 / 有下游单据」拒绝。
     * 以前直接 return，用户点了没反应；现在把原因摆到页面上。
     */
    if (!order.cancelable.allowed) {
      setActionError(cancelDisabledReason(order.cancelable.reason) ?? '当前状态不能取消这张单');
      return;
    }
    setActionError(null);
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
  const listState = resolveListState({
    isPending: list.isPending,
    hasError: list.isError,
    isEmpty: rows.length === 0,
  });

  return (
    <section className="page-body">
      <div className="p-head">
        <div>
          <div className="eyebrow">加工单 B · 投料与损耗</div>
          <h1>加工单 B</h1>
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
        <div className="alert alert-warn">
          <p>
            当前身份无「看价」权限，金额显示为 <b>{MASKED_AMOUNT}</b>（D79）。
          </p>
          <p>
            注意：processing 端点目前<b>没有服务端金额脱敏</b>（与采购单不同），
            页面这里只是不渲染；已在 PR 里报给主线在 API 侧补 view_price 口径。
          </p>
        </div>
      )}

      {meData && !can('create') && (
        <p className="detail-why">
          「新建」需要 processing.create；当前身份只能查看（权限判定在服务端，前端只是不画按钮）。
        </p>
      )}

      {/*
        工具条：状态用 `.seg` 分段（视觉稿 `加工单B.html` 就是分段，不是下拉）。
        分段里只有契约认的四个状态 —— 视觉稿那段「草稿」是模板残留，契约
        `PROCESSING_ORDER_STATES` 里没有草稿态，画出来就是个永远筛不出数据的按钮。
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
        {/*
          看谁的（D106）。只在有 `processing.read_all` 时才给这个下拉 ——
          没权限的人看到一个切不动的框，会以为「全部」里该有别人的单。
        */}
        {can('read_all') && (
          <select
            value={scopeFilter}
            onChange={(event) => {
              setScopeFilter(event.target.value as '' | 'mine' | 'all');
              // 换「看谁的」等于换了一组数据，旧游标指向的位置在新集合里没有意义。
              setCursors([null]);
              setPageIndex(0);
            }}
            aria-label="看谁的单据"
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
          value={processorFilter}
          onChange={(event) => setProcessorFilter(event.target.value)}
          className="sel"
        >
          <option value="">全部加工厂</option>
          {processors.map((processor) => (
            <option key={processor.id} value={processor.id}>
              {processor.name}
            </option>
          ))}
        </select>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索单号、加工厂名"
          aria-label="搜索单号或加工厂名"
          className="search"
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
          newProcessorOpen={newProcessorOpen}
          newProcessor={newProcessor}
          onNewProcessorToggle={(open) => {
            setNewProcessorOpen(open);
            // 双向清空另一条路：服务端对「processorId 与 processorDraft 都给」是 422。
            if (open) setFormProcessorId('');
            else setNewProcessor({ ...EMPTY_NEW_PROCESSOR });
          }}
          onNewProcessorChange={(patch) => setNewProcessor((current) => ({ ...current, ...patch }))}
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
              newProcessorOpen ? newProcessor : null,
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
      {notice && <p className="alert alert-warn">{notice}</p>}

      {/*
        列表（v3.0 `list-card`）：容器与 tbody 挂同一个 data-state，数据行 `r-row`、
        三行状态行常驻且带 `st-tr st-*`，显隐交给 `app-v013.css`；
        `.tf` 页脚在非 filled 态自动收起翻页（`app-v30.css`）。
        分页只能按游标写「上一批 / 下一批」：加工单的列表契约是 `PageQuerySchema`，
        没有 `total`，画页码只能靠猜（D95 的页码模式还没铺到这个模块）。
      */}
      <div className="card list-card" data-state={listState}>
        <div className="tw">
          {/* 8 列在 1040px 以下会挤到换行，交给 `.tw` 横向滚（与采购 / 内贸同口径） */}
          <table className="w-full min-w-[1040px] text-left">
            <thead>
              <tr>
                <th>单号</th>
                <th>加工厂</th>
                <th>成品</th>
                <th className="num">投入 → 可售</th>
                <th className="num">损耗</th>
                <th className="num">费用</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody data-state={listState}>
              <tr className="st-tr st-loading">
                <td colSpan={8}>
                  <ListLoading label="正在加载加工单…" />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={8}>
                  <ListError
                    title="加工单加载失败"
                    error={list.error}
                    onRetry={() => void list.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={8}>
                  <ListEmpty title="暂无加工单。可调整筛选条件，或用右上角「+ 新建」开第一张。" />
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
                  <td className="whitespace-nowrap">{order.processorName}</td>
                  <td className="cell-muted">
                    {productLabel(products, order.outputProductId)}
                  </td>
                  <td className="num whitespace-nowrap">
                    {formatQty(order.inputQty)} →{' '}
                    {order.sellableQty === null ? '待验收' : formatQty(order.sellableQty)}
                  </td>
                  <td className="num whitespace-nowrap">
                    {order.lossQty === null ? (
                      <span className="cell-muted">待验收</span>
                    ) : (
                      formatQty(order.lossQty)
                    )}
                  </td>
                  <td className="num whitespace-nowrap">
                    {canViewPrice
                      ? formatMoney(sumDecimal(order.fees.map((fee) => fee.amount)))
                      : MASKED_AMOUNT}
                  </td>
                  <td className="whitespace-nowrap">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <div className="row-acts">
                      <button
                        type="button"
                        onClick={() => setDetailId(order.id)}
                        className="btn btn-row"
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        disabled={!can('update') || !canViewPrice || order.status !== '进行中'}
                        onClick={() => void withFreshDetail(order.id, beginEdit)}
                        className="btn btn-row"
                        title={!canViewPrice ? '无看价权限：看不到加工费就没法改单' : undefined}
                      >
                        编辑
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

        <div className="tf">
          {/* 批次号由 BatchPager 显示，这里只写条数，别把「第 1 批」写两遍 */}
          <span>共 {rows.length} 条</span>
          <BatchPager
            batch={pageIndex + 1}
            hasPrev={pageIndex > 0}
            hasNext={nextCursor !== null}
            onPrev={() => setPageIndex((index) => Math.max(0, index - 1))}
            onNext={() => {
              if (!nextCursor) return;
              setCursors((items) => [...items.slice(0, pageIndex + 1), nextCursor]);
              setPageIndex((index) => index + 1);
            }}
            label="加工单分批翻页"
          />
        </div>
      </div>

      <p className="note">
        「完成 / 验收」是一次性走完的老路径（同样要{' '}
        <code className="mono">processing.approve</code>）：损耗量只填一次、事后不改，
        可售量为 0 时必须二次确认全损耗。提交带强 <code className="mono">If-Match</code>，
        版本冲突会提示并同步最新状态。「草稿」不在状态机里，所以分段里没有它。
      </p>

      {detailId !== null && (
        <>
          {detail.isPending && <p className="alert alert-info">正在加载加工单详情…</p>}
          {detail.error && <p className="alert alert-bad">{errorText(detail.error)}</p>}
          {detailOrder && (
            <DetailPanel
              order={detailOrder}
              products={products}
              batches={detailBatches}
              /*
                负责人无权可见时服务端回 null（Issue #227）——直接说「无权查看」，
                不要退回 `—`：破折号会被误读成「这张单没填经手人」。
              */
              handlerLabel={
                detailOrder.handlerId === null
                  ? '—（无权查看负责人）'
                  : detailOrder.handlerId === meData?.employeeId
                    ? (meData?.displayName ?? '本人')
                    : employeeLabel(detailOrder.handlerId)
              }
              canViewPrice={canViewPrice}
              canUpdate={can('update')}
              canPrint={can('read')}
              canCancel={can('delete')}
              canComplete={can('approve')}
              canShip={can('ship')}
              canReceive={can('approve')}
              canceling={cancelOrder.isPending}
              completing={completeOrder.isPending}
              shipping={shipOrder.isPending}
              revoking={revokeShip.isPending}
              receiving={receiveOrder.isPending}
              revokeReason={revokeReason}
              revokeError={revokeError}
              onClose={() => {
                setDetailId(null);
                setCompletingOrder(null);
                setRevokeReason('');
                setRevokeError(null);
              }}
              onEdit={() => beginEdit(detailOrder)}
              onCancel={() => askCancel(detailOrder)}
              onComplete={() => void withFreshDetail(detailOrder.id, beginComplete)}
              onPrint={() => print.mutate(detailOrder.id)}
              onShip={() => void withFreshDetail(detailOrder.id, beginShip)}
              onRevokeReasonChange={(value) => {
                setRevokeReason(value);
                setRevokeError(null);
              }}
              onRevoke={() => void withFreshDetail(detailOrder.id, askRevoke)}
              onReceive={() => void withFreshDetail(detailOrder.id, askReceive)}
            />
          )}
        </>
      )}

      {completingOrder && (
        <CompletionPanel
          order={completingOrder}
          lossQty={completionLossQty}
          confirmFullLoss={completionConfirmFullLoss}
          errors={completionErrors}
          busy={completeOrder.isPending}
          onLossQtyChange={(value) => {
            setCompletionLossQty(value);
            setCompletionErrors([]);
            if (
              !isPositiveDecimal(value.trim()) ||
              !isFullLoss(completingOrder.inputQty, value.trim())
            ) {
              setCompletionConfirmFullLoss(false);
            }
          }}
          onConfirmFullLossChange={setCompletionConfirmFullLoss}
          onSubmit={(event) => {
            event.preventDefault();
            const errors = validateCompletionDraft(
              completingOrder.inputQty,
              completionLossQty,
              completionConfirmFullLoss,
            );
            setCompletionErrors(errors);
            if (errors.length > 0) return;
            const fullLoss = isFullLoss(completingOrder.inputQty, completionLossQty.trim());
            completeOrder.mutate({
              order: completingOrder,
              body: {
                lossQty: completionLossQty.trim(),
                confirmFullLoss: fullLoss || undefined,
              },
            });
          }}
          onCancel={resetCompletion}
        />
      )}

      {shippingOrder && (
        <ProcessingShipDialog
          orderNo={shippingOrder.orderNo}
          inputQty={shippingOrder.inputQty}
          processorName={shippingOrder.processorName}
          draft={shipDraft}
          errors={shipErrors}
          custodians={custodians}
          custodiansError={custodiansError}
          busy={shipOrder.isPending}
          onChange={(patch) => {
            setShipDraft((draft) => ({ ...draft, ...patch }));
            setShipErrors([]);
          }}
          onClose={resetShip}
          onSubmit={submitShip}
        />
      )}
    </section>
  );
}

