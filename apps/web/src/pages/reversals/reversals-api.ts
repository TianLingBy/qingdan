/**
 * 冲正单据 R / S / I 接口封装（22 页 IA 第 8 页；D9 / D36 / D40 / D47 / D71）。
 *
 * 三条线共处一页，但属于三个不同模块、三套状态机，所以这一层只做「端点 + 口径」，
 * 不混业务判断：
 * - **R 客户退货**（sales 模块，`customer_return`）：必须挂原 E 单；两型
 *   `退货退款`（有实物流水、要明细）/ `仅退款`（无实物流水、要 `onlyRefundKind`）；
 * - **S 供应商退货**（purchase 模块，`supplier_return`）：F4c **只做退钱**，
 *   所以没有退货类型字段——前端也不要自己加一个「抵货款」下拉；
 * - **I 盘点盈亏**（inventory 模块，`stocktake`）：审批流三态，**不复用**单据三态；
 *   客户端只传账面量 / 实盘量，差异量由服务端算；盘盈走 `create`、盘亏走 `delete`
 *   （D71 把「仅删减」拆成独立权限）。
 *
 * 口径（别在这里发明）：
 * - 金额 / 数量一律 decimal 字符串（D54），运算走 `lib/decimal` 定点；
 * - R / S 都没有 update / delete / 取消端点（D47 冲正只追加），完成走各自的 complete 端点；
 * - 同一批数据里，**R 单与 S 单的金额受看价权限管**（D79）：无权限时前端显示 `—`；
 * - I 盘点的审批用强 ETag（D60③），且 `approvable` 只认服务端结论（D21 同款思路）。
 */

import type {
  CustomerReturn,
  CustomerReturnCreateInput,
  CustomerReturnStatus,
  CustomerReturnType,
  InventoryBatch,
  OnlyRefundKind,
  Product,
  PurchaseOrder,
  RefundMode,
  SalesOrder,
  Stocktake,
  StocktakeCreateInput,
  StocktakeDetail,
  StocktakeRejectInput,
  StocktakeStatus,
  SupplierReturn,
  SupplierReturnCreateInput,
  SupplierReturnStatus,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';
import {
  compareDecimal,
  formatQty,
  isPositiveDecimal,
  isPositiveNonZeroDecimal,
  multiplyDecimal,
  subtractDecimal,
  sumDecimal,
} from '../../lib/decimal';
import type { PageResult } from '../masterdata/masterdata-api';

/* ------------------------------ 接口 ------------------------------ */

export interface CustomerReturnListFilters {
  readonly companyId?: string;
  readonly originalSalesOrderId?: string;
  readonly status?: CustomerReturnStatus;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface SupplierReturnListFilters {
  readonly companyId?: string;
  readonly originalPurchaseOrderId?: string;
  readonly status?: SupplierReturnStatus;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface StocktakeListFilters {
  readonly companyId?: string;
  readonly status?: StocktakeStatus;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

function ifMatch(version: number): Record<string, string> {
  return { 'If-Match': `"${version}"` };
}

export function createReversalsApi(client: ApiClient = apiClient) {
  return {
    /* R 客户退货（4 条） */
    listCustomerReturns: (filters: CustomerReturnListFilters = {}) =>
      client.get<PageResult<CustomerReturn>>('/customer-returns', {
        query: {
          companyId: filters.companyId,
          originalSalesOrderId: filters.originalSalesOrderId,
          status: filters.status,
          keyword: filters.keyword,
          cursor: filters.cursor ?? undefined,
          limit: filters.limit ?? 50,
        },
      }),
    customerReturnDetail: (id: string) =>
      client.get<CustomerReturn>(`/customer-returns/${id}`),
    createCustomerReturn: (input: CustomerReturnCreateInput) =>
      client.post<CustomerReturn>('/customer-returns', input),
    customerReturnComplete: (id: string, version: number) =>
      client.post<CustomerReturn>(
        `/customer-returns/${id}/complete`,
        undefined,
        {
          headers: ifMatch(version),
        },
      ),

    /* S 供应商退货（5 条） */
    listSupplierReturns: (filters: SupplierReturnListFilters = {}) =>
      client.get<PageResult<SupplierReturn>>('/supplier-returns', {
        query: {
          companyId: filters.companyId,
          originalPurchaseOrderId: filters.originalPurchaseOrderId,
          status: filters.status,
          keyword: filters.keyword,
          cursor: filters.cursor ?? undefined,
          limit: filters.limit ?? 50,
        },
      }),
    supplierReturnDetail: (id: string) =>
      client.get<SupplierReturn>(`/supplier-returns/${id}`),
    createSupplierReturn: (input: SupplierReturnCreateInput) =>
      client.post<SupplierReturn>('/supplier-returns', input),
    supplierReturnComplete: (id: string, version: number) =>
      client.post<SupplierReturn>(
        `/supplier-returns/${id}/complete`,
        undefined,
        {
          headers: ifMatch(version),
        },
      ),
    /**
     * 取消进行中的 S 单（`supplier_return.cancel`，权限点 `supplier_return.delete`）。
     *
     * 服务端 `assertHumanCreation(principal, request.auditReason)` 要求带原因，
     * 所以 `reason` 必填——它走 `X-Reason` 头（中文由 client 的 `headerSafeValue` 编码）。
     * 取消会释放待执行库存占用，且不可撤销。
     */
    supplierReturnCancel: (id: string, version: number, reason: string) =>
      client.post<SupplierReturn>(`/supplier-returns/${id}/cancel`, undefined, {
        headers: ifMatch(version),
        reason,
      }),

    /* I 盘点（5 条；D71 盘盈 / 盘亏拆成两条创建端点） */
    listStocktakes: (filters: StocktakeListFilters = {}) =>
      client.get<PageResult<Stocktake>>('/stocktakes', {
        query: {
          companyId: filters.companyId,
          status: filters.status,
          keyword: filters.keyword,
          cursor: filters.cursor ?? undefined,
          limit: filters.limit ?? 50,
        },
      }),
    stocktakeDetail: (id: string) =>
      client.get<StocktakeDetail>(`/stocktakes/${id}`),
    createStocktake: (
      direction: 'increase' | 'decrease',
      input: StocktakeCreateInput,
    ) =>
      client.post<Stocktake>(
        direction === 'increase'
          ? '/stocktakes/increases'
          : '/stocktakes/decreases',
        input,
      ),
    approveStocktake: (id: string, version: number) =>
      client.post<StocktakeDetail>(`/stocktakes/${id}/approve`, undefined, {
        headers: ifMatch(version),
      }),
    rejectStocktake: (
      id: string,
      version: number,
      input: StocktakeRejectInput,
    ) =>
      client.post<Stocktake>(`/stocktakes/${id}/reject`, input, {
        headers: ifMatch(version),
      }),

    /* 关联下拉：都要「原单」，不能手填 id */
    listSalesOrders: (companyId?: string) =>
      client.get<PageResult<SalesOrder>>('/sales-orders', {
        query: { companyId, limit: 200 },
      }),
    listPurchaseOrders: (companyId?: string) =>
      client.get<PageResult<PurchaseOrder>>('/purchase-orders', {
        query: { companyId, limit: 200 },
      }),
    listBatches: (companyId?: string) =>
      client.get<PageResult<InventoryBatch>>('/inventory/batches', {
        query: { companyId, limit: 200 },
      }),
    listProducts: () =>
      client.get<PageResult<Product>>('/products', { query: { limit: 200 } }),
  };
}

export type ReversalsApi = ReturnType<typeof createReversalsApi>;
export const reversalsApi = createReversalsApi();

export const reversalsQueryKeys = {
  customerReturns: (filters: CustomerReturnListFilters) =>
    ['reversals', 'customer', 'list', filters] as const,
  supplierReturns: (filters: SupplierReturnListFilters) =>
    ['reversals', 'supplier', 'list', filters] as const,
  stocktakes: (filters: StocktakeListFilters) =>
    ['reversals', 'stocktake', 'list', filters] as const,
  customerReturn: (id: string | null) =>
    ['reversals', 'customer', 'detail', id] as const,
  supplierReturn: (id: string | null) =>
    ['reversals', 'supplier', 'detail', id] as const,
  stocktake: (id: string | null) =>
    ['reversals', 'stocktake', 'detail', id] as const,
  /** 关联数据：三个分栏共用，切 tab 不重复拉。 */
  salesOrders: (companyId: string) =>
    ['reversals', 'refs', 'sales-orders', companyId] as const,
  purchaseOrders: (companyId: string) =>
    ['reversals', 'refs', 'purchase-orders', companyId] as const,
  batches: (companyId: string) =>
    ['reversals', 'refs', 'batches', companyId] as const,
  products: ['masterdata', 'products', { limit: 200 }] as const,
};

/* ------------------------------ 枚举 ------------------------------ */

export const RETURN_TYPES: readonly CustomerReturnType[] = [
  '退货退款',
  '仅退款',
];
export const ONLY_REFUND_KINDS: readonly OnlyRefundKind[] = [
  '纠收款',
  '减成交额',
];
export const REFUND_MODES: readonly RefundMode[] = ['原路退款', '冲抵应收'];

export const RETURN_TYPE_HINT: Readonly<Record<CustomerReturnType, string>> = {
  退货退款: '货退回库，必须填商品明细；有入库流水（D40）',
  仅退款: '不退货、只退钱；没有实物流水，不需要商品明细',
};

export const ONLY_REFUND_KIND_HINT: Readonly<Record<OnlyRefundKind, string>> = {
  纠收款: '只退钱，不重算毛利与提成',
  减成交额: '成交额减少，原 C 单按结算时快照比例重算毛利提成并留痕',
};

export const REFUND_MODE_HINT: Readonly<Record<RefundMode, string>> = {
  原路退款: '退回原收款账户',
  冲抵应收: '挂账，抵该客户下一次货款',
};

/** `退货退款` 才需要商品明细（§5.1）；`仅退款` 提交空数组。 */
export function needsLines(returnType: CustomerReturnType): boolean {
  return returnType === '退货退款';
}

/* ------------------------------ 行与金额 ------------------------------ */

export interface ReturnLineDraft {
  productId: string;
  /** 一行可引多批次，至少 1 个（D22）。 */
  batchIds: string[];
  qty: string;
  unitPrice: string;
}

/** 行金额 = 数量 × 单价（定点，不走浮点）。 */
export function returnLineAmount(line: ReturnLineDraft): string {
  if (!isPositiveDecimal(line.qty) || !isPositiveDecimal(line.unitPrice))
    return '0';
  return multiplyDecimal(line.qty, line.unitPrice);
}

/** 明细合计（只用于「跟应退金额对一下」，应退金额以人工填写为准）。 */
export function returnLinesTotal(lines: readonly ReturnLineDraft[]): string {
  return sumDecimal(lines.map((line) => returnLineAmount(line)));
}

/* ------------------------------ 校验 ------------------------------ */

/**
 * R 单提交前校验。只挡「明显错」，服务端的岗位校验（D47：仅老板/经理/财务可录）
 * 与 422 仍以服务端为准——不在这里假装知道你是谁。
 */
export function validateCustomerReturnDraft(draft: {
  companyId: string;
  originalSalesOrderId: string;
  returnType: CustomerReturnType;
  onlyRefundKind: OnlyRefundKind | '';
  refundAmount: string;
  lines: readonly ReturnLineDraft[];
}): string[] {
  const errors: string[] = [];
  if (!draft.companyId) errors.push('请选择公司');
  if (!draft.originalSalesOrderId)
    errors.push('请选择原销售单（R 单必须挂原 E 单）');

  if (draft.returnType === '仅退款' && draft.onlyRefundKind === '') {
    errors.push('「仅退款」必须选类型：纠收款 / 减成交额');
  }

  if (!isPositiveNonZeroDecimal(draft.refundAmount)) {
    errors.push('应退金额必须是大于 0 的数字（最多 6 位小数）');
  }

  if (needsLines(draft.returnType)) {
    if (draft.lines.length === 0) {
      errors.push('「退货退款」必须有至少 1 行商品明细');
    }
    draft.lines.forEach((line, index) => {
      const label = `第 ${index + 1} 行商品`;
      if (!line.productId) errors.push(`${label}：请选择商品`);
      if (line.batchIds.length === 0)
        errors.push(`${label}：至少引用 1 个批次（D22）`);
      if (!isPositiveNonZeroDecimal(line.qty))
        errors.push(`${label}：数量必须大于 0`);
      if (!isPositiveDecimal(line.unitPrice))
        errors.push(`${label}：单价必须是非负数字`);
    });
  }

  return errors;
}

/** S 单提交前校验（F4c 只有退钱一种，所以没有类型字段要校验）。 */
export function validateSupplierReturnDraft(draft: {
  companyId: string;
  originalPurchaseOrderId: string;
  refundAmount: string;
  lines: readonly ReturnLineDraft[];
}): string[] {
  const errors: string[] = [];
  if (!draft.companyId) errors.push('请选择公司');
  if (!draft.originalPurchaseOrderId)
    errors.push('请选择原采购单（S 单必须挂原 A 单）');
  if (!isPositiveNonZeroDecimal(draft.refundAmount)) {
    errors.push('应退金额必须是大于 0 的数字（最多 6 位小数）');
  }
  if (draft.lines.length === 0) errors.push('供应商退货至少 1 行商品明细');
  draft.lines.forEach((line, index) => {
    const label = `第 ${index + 1} 行商品`;
    if (!line.productId) errors.push(`${label}：请选择商品`);
    if (line.batchIds.length === 0)
      errors.push(`${label}：至少引用 1 个批次（D22）`);
    if (!isPositiveNonZeroDecimal(line.qty))
      errors.push(`${label}：数量必须大于 0`);
    if (!isPositiveDecimal(line.unitPrice))
      errors.push(`${label}：单价必须是非负数字`);
  });
  return errors;
}

/* ------------------------------ 盘点 ------------------------------ */

export type StocktakeDirection = 'increase' | 'decrease' | 'none';

/**
 * 差异方向：实盘 > 账面 = 盘盈（走 increases 端点），实盘 < 账面 = 盘亏（走 decreases）。
 * 相等时返回 `none`——契约明确「无差异不需要盘点单」，前端先挡一道，别等服务端 422。
 */
export function stocktakeDirection(
  bookQty: string,
  actualQty: string,
): StocktakeDirection {
  if (!isPositiveDecimal(bookQty) || !isPositiveDecimal(actualQty))
    return 'none';
  const result = compareDecimal(actualQty, bookQty);
  if (result === 0) return 'none';
  return result > 0 ? 'increase' : 'decrease';
}

/** 差异量展示：盘盈带 `+`、盘亏带 `−`（服务端算，这里只用于本地预览）。 */
export function stocktakeDiffText(bookQty: string, actualQty: string): string {
  if (!isPositiveDecimal(bookQty) || !isPositiveDecimal(actualQty)) return '—';
  const diff = subtractDecimal(actualQty, bookQty);
  if (diff === '0') return '0';
  return diff.startsWith('-') ? diff : `+${diff}`;
}

export function validateStocktakeDraft(draft: {
  companyId: string;
  batchId: string;
  bookQty: string;
  actualQty: string;
}): string[] {
  const errors: string[] = [];
  if (!draft.companyId) errors.push('请选择公司');
  if (!draft.batchId) errors.push('请选择盘点批次');
  if (!isPositiveDecimal(draft.bookQty)) errors.push('账面量必须是非负数字');
  if (!isPositiveDecimal(draft.actualQty)) errors.push('实盘量必须是非负数字');
  if (
    isPositiveDecimal(draft.bookQty) &&
    isPositiveDecimal(draft.actualQty) &&
    stocktakeDirection(draft.bookQty, draft.actualQty) === 'none'
  ) {
    errors.push('实盘量和账面量一样，无差异不需要盘点单（D47）');
  }
  return errors;
}

/** 驳回原因前端只挡空值与长度；状态和并发仍由服务端判定。 */
export function validateStocktakeRejectReason(reason: string): string[] {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return ['必须填写驳回原因。'];
  if (trimmed.length > 200) return ['驳回原因不能超过 200 字。'];
  return [];
}

/* ------------------------------ 展示口径 ------------------------------ */

/**
 * R / S 单三态 → v0.13 `.st` 语义档（对应 `.st` 的 now / ok / warn / bad / cancel）。
 *
 * 为什么「进行中」用 `warn`（黄）而不是 N 单的 `now`（苔绿）：
 * `design/v0.13/冲正单据.html` 的 R / S 行就是这么画的（`<span class="st warn">进行中</span>`），
 * 而且语义上说得通——一张进行中的退货单意味着**钱或货还悬着**，等审批人动手，
 * 和 N 单那种「单据在正常流转」的进行中不是一回事。照稿，不按好看的挑。
 */
export const RETURN_STATUS_TONE: Readonly<
  Record<string, 'warn' | 'ok' | 'cancel'>
> = {
  进行中: 'warn',
  已完成: 'ok',
  已取消: 'cancel',
};

/**
 * 盘点三态 → `.st` 语义档。
 *
 * `待审批` 用 `bad`（红）也是照稿：它不是出错，是「等财务批」，红一点才有人管；
 * `已驳回` 稿子给的是 `warn`（黄）而不是 `cancel`（灰），因为驳回后还要人改单重报，
 * 不是废单。两者都不是终态灰，别按「失败就该灰」的习惯改。
 */
export const STOCKTAKE_STATUS_TONE: Readonly<
  Record<StocktakeStatus, 'bad' | 'ok' | 'warn'>
> = {
  待审批: 'bad',
  已批准: 'ok',
  已驳回: 'warn',
};

/** 盘点可审批原因的文案；`null` 表示可批。只渲染服务端结论，前端不重算（D21 同款）。 */
export const APPROVE_BLOCK_TEXT: Readonly<Record<string, string>> = {
  already_approved: '已批准，一期不支持重新审批（D71）',
  already_rejected: '已驳回，一期不支持重新审批（D71）',
};

export function approveBlockedText(reason: string | null): string | null {
  if (reason === null) return null;
  return APPROVE_BLOCK_TEXT[reason] ?? '当前状态不可审批';
}

/** 关联单号：契约里 R/S 只回 id，列表用 `原单号` 需要前端自己映射。 */
export function idLabel(id: string | null | undefined): string {
  if (!id) return '—';
  return id.slice(0, 8);
}

/** 盘点差异的方向文案。 */
export function stocktakeDirectionText(diffQty: string): string {
  if (diffQty === '0') return '无差异';
  return diffQty.startsWith('-') ? '盘亏' : '盘盈';
}

/** 批次下拉文案：批次号 + 可用量（可用量是唯一可引用数字，D38）。 */
export function batchOptionLabel(batch: InventoryBatch): string {
  return `${batch.batchNo}（可用 ${formatQty(batch.availableQty)}）`;
}

/** 商品名映射；明细只回 productId，列表里用 id 前 8 位兜底。 */
export function productNameOf(
  products: readonly Product[],
  productId: string,
): string {
  return (
    products.find((product) => product.id === productId)?.name ??
    idLabel(productId)
  );
}

/**
 * 批次号映射：R / S 明细只回 `batchIds`，而 id 前 8 位对人没有意义，
 * 所以详情里用批次号；批次还没拉到（或不是本公司批次）时才退回 id 前缀。
 */
export function batchLabelOf(
  batches: readonly InventoryBatch[],
  batchId: string,
): string {
  return (
    batches.find((batch) => batch.id === batchId)?.batchNo ?? idLabel(batchId)
  );
}
