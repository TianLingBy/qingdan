/**
 * 销售单 E 接口封装（契约第一批 §3.3 / §5.1 / §5.2 / §6 / §10）。
 *
 * 端点：列表 / 详情 / 开单 / 改单 / 出库 / 取消（6 条，`sales-orders.ts`）
 *      + 打印客户联 / 列表导出（`prints.ts`）
 *      + 追加收款（`sales-receipts.ts`，内嵌 E 单详情，D24）。
 * 附属只读：客户列表（`/customers`）、批次列表（`/inventory/batches`，选批次出售，D22）。
 *
 * 口径（别在这里发明）：
 * - 数量 / 金额一律 **decimal 字符串**（D54 `numeric(18,6)`），运算走 `lib/decimal` 定点；
 * - 单号服务端按 D16 生成，前端不传；
 * - **商品行至少引用 1 个批次**（D22，只能本公司批次）：一行可引多批次，
 *   出库时按行内批次均分扣减（D72），除不尽的余量由最后一个批次承接；
 * - **E 单费用行金额必须 ≥ 0**（D39）：负数费用行会绕过破下限审批，前端先挡一道；
 * - **售价低于加权平均批次成本 → 服务端 422**（D20）：本批没有审批端点，
 *   前端只能把服务端的 `costFloor` 如实展示，**不自己编一个「提交审批」的假按钮**；
 * - 修改 / 出库 / 取消必须带强 ETag `If-Match: "<version>"`（D60③）；
 * - **无 `sales.view_price` 时金额为 null**（D79）：显示 `—`，不用 0 顶替；
 * - 收款记录**只追加不改历史行**（D34 / D40）：退款是同一台账里的负数行；
 *   块内余额 `receiptBalance` 由服务端算，客户端不传。
 */

import type {
  Customer,
  InventoryBatch,
  PrintDocument,
  SalesOrder,
  SalesOrderCreateInput,
  SalesOrderDetail,
  SalesOrderStatus,
  SalesOrderUpdateInput,
  SalesReceipt,
  SalesReceiptCreateInput,
  SalesReceiptDirection,
  SalesReceiptMethod,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';
import {
  compareDecimal,
  isPositiveDecimal,
  multiplyDecimal,
  sumDecimal,
} from '../../lib/decimal';
import type { PageResult } from '../masterdata/masterdata-api';

/**
 * 销售单列表的查询条件。
 *
 * 两套分页参数并存（D95）：`cursor`/`limit` 是老的游标模式，`page`/`pageSize` 是新的
 * 页码模式。**不能同时给**——后端会 422。页码模式下响应带 `total`，前端才画得出页码条。
 */
export interface SalesOrderListFilters {
  readonly companyId?: string;
  readonly customerId?: string;
  readonly status?: SalesOrderStatus;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
  /** 页码模式：第几页，从 1 起。 */
  readonly page?: number;
  /** 页码模式：每页条数。 */
  readonly pageSize?: number;
  /** 排序字段，只能是后端白名单里的三个（D95）。 */
  readonly sort?: SalesOrderSort;
  /** 排序方向，默认 desc。 */
  readonly order?: 'asc' | 'desc';
}

/** 后端 `SalesOrderListQuerySchema` 的排序白名单，多写一个会被 422 挡回来。 */
export type SalesOrderSort = 'orderNo' | 'totalAmount' | 'createdAt';

/** 页码模式的列表响应：比游标模式多 `total`/`page`/`pageSize`。 */
export interface PagedSalesOrders {
  readonly items: SalesOrder[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly nextCursor: string | null;
}

function listQuery(
  filters: SalesOrderListFilters,
): Record<string, string | number | undefined> {
  return {
    companyId: filters.companyId,
    customerId: filters.customerId,
    status: filters.status,
    keyword: filters.keyword,
    cursor: filters.cursor ?? undefined,
    limit: filters.limit,
    page: filters.page,
    pageSize: filters.pageSize,
    sort: filters.sort,
    order: filters.order,
  };
}

/**
 * 导出用的查询条件：**只保留筛选，丢掉全部分页与排序参数**。
 *
 * 导出一次取全量（后端 `EXPORT_MAX_ROWS` 兜底），带上 `pageSize` 之类会被后端
 * 明确 422（`assertNoPagingParams`）。更要紧的是别让它悄悄生效——那会把 CSV 截成
 * 只有一页的行数，而调用方看到的是「导出成功」。
 */
function exportQuery(
  filters: SalesOrderListFilters,
): Record<string, string | undefined> {
  return {
    companyId: filters.companyId,
    customerId: filters.customerId,
    status: filters.status,
    keyword: filters.keyword,
  };
}

function ifMatch(version: number): Record<string, string> {
  return { 'If-Match': `"${version}"` };
}

export interface CustomerListFilters {
  readonly companyId?: string;
  readonly keyword?: string;
  readonly status?: '启用' | '停用';
  readonly limit?: number;
}

export interface SalesBatchListFilters {
  readonly companyId?: string;
  readonly productId?: string;
  readonly keyword?: string;
  readonly limit?: number;
}

/**
 * 从 `content-disposition` 里取文件名。
 *
 * 服务端走 RFC 5987（`attachment; filename*=UTF-8''%E9%94%80...`），因为文件名是中文
 * 而 HTTP 头只能 ASCII。老 IE 那种 `filename="..."` 形式这里不处理——我们不支持它。
 * 解析失败返回 null，由调用方退回默认名，**不要因此让整次导出失败**。
 */
export function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const match = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return null;
  }
}

export function createSalesApi(client: ApiClient = apiClient) {
  return {
    /** 列表：页码模式传 `page`/`pageSize` 才有 `total`；只传 `cursor`/`limit` 是老的游标模式。 */
    list: (filters: SalesOrderListFilters = {}) =>
      client.get<PagedSalesOrders>('/sales-orders', { query: listQuery(filters) }),
    detail: (id: string) => client.get<SalesOrderDetail>(`/sales-orders/${id}`),
    create: (input: SalesOrderCreateInput) =>
      client.post<SalesOrder>('/sales-orders', input),
    update: (id: string, input: SalesOrderUpdateInput, version: number) =>
      client.patch<SalesOrder>(`/sales-orders/${id}`, input, {
        headers: ifMatch(version),
      }),
    /**
     * 销售发货（D72 / D85 / D94）：`进行中` → `已发货`，扣批次可用量 + 生成 C 单草稿，同事务；AI 禁止。
     *
     * D85 曾把「出库」与「完成」合并成这一个端点（当时判断销售单没有「出货后再确认」这一步）；
     * D94 又把它们拆开了：货出门与客户签收之间有一段真实的时间差，签收还会引出退款与对账，
     * 不能和出库塞进同一次点击。现在 ship 与 complete 各自需要 `sales.ship` 与 `sales.approve`。
     */
    ship: (id: string, version: number) =>
      client.post<SalesOrder>(`/sales-orders/${id}/ship`, undefined, {
        headers: ifMatch(version),
      }),
    /**
     * 客户签收（D94）：`已发货` → `已完成`，同事务生成结算草稿。
     *
     * 与 ship 分开是为了权限能拆：能发货的人（仓管）不一定能确认收入（财务）。两个动作挂
     * 同一个 action 上，老板就再也分不开「谁把货发出去了」与「谁认了这笔记收入」。
     */
    complete: (id: string, version: number) =>
      client.post<SalesOrder>(`/sales-orders/${id}/complete`, undefined, {
        headers: ifMatch(version),
      }),
    cancel: (id: string, version: number) =>
      client.post<SalesOrder>(`/sales-orders/${id}/cancel`, undefined, {
        headers: ifMatch(version),
      }),
    /** 客户联（HTML 由服务端渲染，前端只打开 / 落盘）。 */
    print: (id: string) => client.get<PrintDocument>(`/sales-orders/${id}/print`),
    /**
     * 列表导出 CSV（敏感读，服务端记审计，D54 ②）。
     *
     * 返回**原生 CSV 流**（D96），不是 JSON 信封——所以显式要 `blob`，文件名从
     * `content-disposition` 拿。之前这里按 `PrintDocument` 解析，`doc.content` 在
     * 运行时是 `undefined`，下下来的是个空文件且文件名叫 `undefined`。
     */
    exportCsv: async (filters: SalesOrderListFilters = {}) => {
      let filename = 'sales-orders.csv';
      const blob = await client.get<Blob>('/sales-orders/export', {
        query: exportQuery(filters),
        responseType: 'blob',
        responseMeta: ({ headers }) => {
          const parsed = filenameFromDisposition(headers.get('content-disposition'));
          if (parsed) filename = parsed;
        },
      });
      return { blob, filename };
    },
    /** 追加收款 / 退款（退款传负数金额，D34）。 */
    createReceipt: (orderId: string, input: SalesReceiptCreateInput) =>
      client.post<SalesReceipt>(`/sales-orders/${orderId}/receipts`, input),
    /** 客户下拉：开单要选客户（D15 客户归属公司）。 */
    listCustomers: (filters: CustomerListFilters = {}) =>
      client.get<PageResult<Customer>>('/customers', {
        query: {
          companyId: filters.companyId,
          keyword: filters.keyword,
          status: filters.status,
          limit: filters.limit ?? 200,
        },
      }),
    /** 商品行要选批次：走 inventory 只读端点（D22 / D67）。 */
    listBatches: (filters: SalesBatchListFilters = {}) =>
      client.get<PageResult<InventoryBatch>>('/inventory/batches', {
        query: {
          companyId: filters.companyId,
          productId: filters.productId,
          keyword: filters.keyword,
          limit: filters.limit ?? 100,
        },
      }),
  };
}

export type SalesApi = ReturnType<typeof createSalesApi>;
export const salesApi = createSalesApi();

export const salesQueryKeys = {
  /** 直接复用请求参数类型：两处各写一份会漏改（本页改分页时缓存键就漏过 page/sort）。 */
  list: (filters: SalesOrderListFilters) => ['sales-orders', 'list', filters] as const,
  detail: (id: string | null) => ['sales-orders', 'detail', id] as const,
  /** 主数据映射：与主数据页 / A / B 共用同一前缀，切页面不重复拉。 */
  products: ['masterdata', 'products', { limit: 200 }] as const,
  customers: (companyId: string, keyword: string) =>
    ['sales', 'customers', { companyId, keyword }] as const,
  /** 批次按「公司 + 商品」查：一行只能引用同商品批次（D22）。 */
  batches: (companyId: string, productId: string) =>
    ['inventory', 'batches', { companyId, productId }] as const,
};

// ============ 业务口径（页面与测试共用） ============

export const EMPTY_LINES_HINT = '销售单至少 1 行商品明细（§3.3）';

/** 收款方式封闭枚举（§6），下拉直接用。 */
export const RECEIPT_METHODS: readonly SalesReceiptMethod[] = [
  '线下转账',
  '在线支付回调',
  '原路退款',
  '冲抵应收',
];

export interface SalesLineDraft {
  productId: string;
  /** 一行可引多批次，至少 1 个（§5.1 / D22）。 */
  batchIds: string[];
  qty: string;
  unitPrice: string;
}

export interface SalesFeeDraft {
  feeName: string;
  qty: string;
  unitPrice: string;
  /** 留空按 数量 × 单价 自动算；E 单金额必须 ≥ 0（D39）。 */
  amount: string;
  remark: string;
}

/** 行金额：数量 × 单价，定点乘法（D54，不走浮点）。 */
export function lineAmountOf(line: SalesLineDraft): string {
  if (!isPositiveDecimal(line.qty) || !isPositiveDecimal(line.unitPrice)) return '0';
  return multiplyDecimal(line.qty, line.unitPrice);
}

export function feeAmountOf(fee: SalesFeeDraft): string {
  const manual = fee.amount.trim();
  if (manual.length > 0) return manual;
  if (isPositiveDecimal(fee.qty) && isPositiveDecimal(fee.unitPrice)) {
    return multiplyDecimal(fee.qty, fee.unitPrice);
  }
  return '0';
}

/** 单据合计 = 商品行金额合计 + 费用行金额合计（服务端同样以 SQL 计算总额）。 */
export function orderTotalOf(
  lines: readonly SalesLineDraft[],
  fees: readonly SalesFeeDraft[],
): string {
  return sumDecimal([
    ...lines.map((line) => lineAmountOf(line)),
    ...fees.map((fee) => feeAmountOf(fee)),
  ]);
}

/**
 * 未脱敏实体合计：金额字段可能为 null（无看价，D79），null 不参与求和。
 * 全部为 null 时返回 null，页面显示 `—` 而不是 `¥0.00`。
 */
export function sumNullable(values: readonly (string | null)[]): string | null {
  const known = values.filter((value): value is string => value !== null);
  if (known.length === 0) return null;
  return sumDecimal(known);
}

/** 提交前的本地校验：只挡「明显错」，字段级口径仍以服务端 422 为准。 */
export function validateDraft(
  customerId: string,
  lines: readonly SalesLineDraft[],
  fees: readonly SalesFeeDraft[],
): string[] {
  const errors: string[] = [];
  if (!customerId) errors.push('请选择客户');

  if (lines.length === 0) errors.push(EMPTY_LINES_HINT);
  lines.forEach((line, index) => {
    const label = `第 ${index + 1} 行商品`;
    if (!line.productId) errors.push(`${label}：请选择商品`);
    if (line.batchIds.length === 0) {
      errors.push(`${label}：至少引用 1 个批次（D22 只能引用本公司批次）`);
    }
    if (!isPositiveDecimal(line.qty)) {
      errors.push(`${label}：数量必须是非负数字（最多 6 位小数）`);
    } else if (compareDecimal(line.qty, '0') <= 0) {
      errors.push(`${label}：数量必须大于 0`);
    }
    if (!isPositiveDecimal(line.unitPrice)) {
      errors.push(`${label}：单价必须是非负数字（最多 6 位小数）`);
    }
  });

  fees.forEach((fee, index) => {
    const label = `第 ${index + 1} 行费用`;
    if (fee.feeName.trim().length === 0) errors.push(`${label}：请填写费用名称`);
    if (!isPositiveDecimal(fee.qty)) errors.push(`${label}：数量必须是非负数字`);
    if (!isPositiveDecimal(fee.unitPrice)) errors.push(`${label}：单价必须是非负数字`);
    const amount = fee.amount.trim();
    if (amount.length > 0 && !/^\d{1,12}(\.\d{1,6})?$/.test(amount)) {
      errors.push(`${label}：金额必须是非负数字（D39：E 单费用行不可为负）`);
    }
    if (fee.remark.trim().length > 255) errors.push(`${label}：备注最多 255 字`);
  });

  return errors;
}

/**
 * 收款金额符号（§6 / D34）：收款行 > 0、退款行 < 0。
 * 输入框里让人填正数，退款在这里转负——**不改历史行，只追加新行**。
 */
export function signedReceiptAmount(direction: SalesReceiptDirection, amount: string): string {
  const text = amount.trim();
  const positive = text.startsWith('-') ? text.slice(1) : text;
  return direction === '退款' ? `-${positive}` : positive;
}

/** 收款记录金额展示：退款行带负号（`-¥1,200.00`），金额为 null 时 `—`。 */
export function receiptAmountText(direction: SalesReceiptDirection, amount: string | null): string {
  if (amount === null) return '—';
  // 服务端已按方向落负号；这里兜底方向与符号不一致的历史数据（不静默改值）。
  if (direction === '退款' && !amount.startsWith('-')) return `-${amount}`;
  return amount;
}

/** 本地时间输入（datetime-local）→ 服务端要求的 ISO datetime。 */
export function toIsoDateTime(local: string): string {
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

/** `datetime-local` 的默认值（当前时间，按本地时区切成 `YYYY-MM-DDTHH:mm`）。 */
export function nowLocalInput(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;
}

/** 批次下拉文案：批次号 + 可用量（可用量是唯一可引用数字，D38）。 */
export function batchOptionLabel(batch: InventoryBatch): string {
  return `${batch.batchNo}（可用 ${batch.availableQty}）`;
}
