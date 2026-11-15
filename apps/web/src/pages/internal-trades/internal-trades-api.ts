/**
 * 内部交易单 N 接口封装（22 页 IA 第 6 页；契约第二批 §1 / §3，D22 / D31 / D68）。
 *
 * 端点有 8 条：列表 / 开单 / 详情 / 改单 / 取消 / 到货确认 / 发货 / 撤销发货。
 * 进「在途」要按 D31 锁批次可用量（`dispatch`），撤销发货把「在途」退回「进行中」并释放占用
 * （`dispatch-revoke`）；两者的权限点都是 `internal_trade.ship`（出），**不是 `update`**——
 * 「能改单」与「能发货」是拆开的两个权限。到货确认在同一事务里改批次归属公司并解锁在途占用
 * （D31 / D68③，已接入）。
 *
 * 口径（别在这里发明）：
 * - **状态是 N 单独立四态**（D68②）：进行中 / 在途 / 已完成 / 已取消，
 *   **不复用** A/B/E 单的三态；`在途` 只存在于内部交易；
 * - **取消只认服务端** `cancelable.allowed`（D21）：四态先映射成三态再走 `canCancel`；
 * - **内部价由制单人手填，系统不自动算**（D68①），一期只记录、不做利润抵消（D45）；
 * - **明细必须引用发出公司的批次**（D22）：归属校验在服务端，前端只保证至少 1 个；
 * - 金额 / 数量一律 decimal 字符串（D54），运算走 `lib/decimal` 定点；
 * - 改单 / 取消必须带强 ETag `If-Match: "<version>"`（D60③）；
 * - 一期 N 单**没有看价开关**：契约里 `internalPrice` / `amount` 都不可为 null，
 *   所以页面不做 `—` 遮罩，这一点与其他单据不同。
 */

import type {
  InternalTradeOrder,
  InternalTradeOrderCreateInput,
  InternalTradeOrderDetail,
  InternalTradeOrderStatus,
  InternalTradeOrderUpdateInput,
  InventoryBatch,
  Product,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';
import {
  formatQty,
  isPositiveDecimal,
  isPositiveNonZeroDecimal,
  multiplyDecimal,
  sumDecimal,
} from '../../lib/decimal';
import type { PageResult } from '../masterdata/masterdata-api';

/* ------------------------------ 接口 ------------------------------ */

export interface InternalTradeListFilters {
  readonly fromCompanyId?: string;
  readonly toCompanyId?: string;
  readonly status?: InternalTradeOrderStatus;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

function listQuery(
  filters: InternalTradeListFilters,
): Record<string, string | number | undefined> {
  return {
    fromCompanyId: filters.fromCompanyId,
    toCompanyId: filters.toCompanyId,
    status: filters.status,
    keyword: filters.keyword,
    cursor: filters.cursor ?? undefined,
    limit: filters.limit ?? 50,
  };
}

function ifMatch(version: number): Record<string, string> {
  return { 'If-Match': `"${version}"` };
}

export function createInternalTradesApi(client: ApiClient = apiClient) {
  return {
    list: (filters: InternalTradeListFilters = {}) =>
      client.get<PageResult<InternalTradeOrder>>('/internal-trade-orders', {
        query: listQuery(filters),
      }),
    detail: (id: string) =>
      client.get<InternalTradeOrderDetail>(`/internal-trade-orders/${id}`),
    create: (input: InternalTradeOrderCreateInput) =>
      client.post<InternalTradeOrder>('/internal-trade-orders', input),
    update: (id: string, input: InternalTradeOrderUpdateInput, version: number) =>
      client.patch<InternalTradeOrder>(`/internal-trade-orders/${id}`, input, {
        headers: ifMatch(version),
      }),
    /** 取消（D68② / D21）：四态映射后按三态判可取消，不可取消时服务端直接拒。 */
    cancel: (id: string, version: number) =>
      client.post<InternalTradeOrder>(`/internal-trade-orders/${id}/cancel`, undefined, {
        headers: ifMatch(version),
      }),
    /**
     * 到货确认（D31 / D68③）：确认后批次在同一事务内转入接收公司、N 单置为已完成，不可撤销。
     * body 按契约是 `{ confirm: true }`（`z.literal(true)`），强 ETag `If-Match`。
     */
    receive: (id: string, version: number) =>
      client.post<InternalTradeOrder>(`/internal-trade-orders/${id}/receive`, { confirm: true }, {
        headers: ifMatch(version),
      }),
    /**
     * 发货（D22 / D31 / D68③）：把「进行中」推进「在途」，并锁住发出公司批次的可用量。
     * 权限是 `internal_trade.ship`（与 update 拆开：能改单不等于能发货）；body `{ confirm: true }`，强 ETag。
     */
    dispatch: (id: string, version: number) =>
      client.post<InternalTradeOrder>(
        `/internal-trade-orders/${id}/dispatch`,
        { confirm: true },
        { headers: ifMatch(version) },
      ),
    /**
     * 撤销发货（D68②）：把「在途」退回「进行中」，释放在途占用；不转司、不写库存流水。
     * 权限同为 `internal_trade.ship`；`reason` 必填（服务端 trim 后 1–200 字），原样落审计。
     */
    dispatchRevoke: (id: string, version: number, reason: string) =>
      client.post<InternalTradeOrder>(
        `/internal-trade-orders/${id}/dispatch-revoke`,
        { confirm: true, reason },
        { headers: ifMatch(version) },
      ),

    /* 关联下拉：公司 / 商品 / 批次（批次只会列出调用者可见公司的） */
    listCompanies: () =>
      client.get<PageResult<{ id: string; name: string; code: string }>>('/companies', {
        query: { limit: 200 },
      }),
    listProducts: () =>
      client.get<PageResult<Product>>('/products', { query: { limit: 200 } }),
    listBatches: (companyId?: string) =>
      client.get<PageResult<InventoryBatch>>('/inventory/batches', {
        query: { companyId, limit: 200 },
      }),
  };
}

export type InternalTradesApi = ReturnType<typeof createInternalTradesApi>;
export const internalTradesApi = createInternalTradesApi();

export const internalTradeQueryKeys = {
  list: (filters: InternalTradeListFilters) => ['internal-trades', 'list', filters] as const,
  detail: (id: string | null) => ['internal-trades', 'detail', id] as const,
  companies: ['internal-trades', 'refs', 'companies'] as const,
  products: ['masterdata', 'products', { limit: 200 }] as const,
  /** 批次按**发出公司**取：明细只能引发出公司批次（D22）。 */
  batches: (companyId: string) => ['internal-trades', 'refs', 'batches', companyId] as const,
};

/* ------------------------------ 状态口径 ------------------------------ */

/** 四态顺序即页面上「状态」筛选的选项顺序（D68②）。 */
export const INTERNAL_TRADE_STATES: readonly InternalTradeOrderStatus[] = [
  '进行中',
  '在途',
  '已完成',
  '已取消',
];

export const INTERNAL_TRADE_STATE_STYLE: Readonly<Record<InternalTradeOrderStatus, string>> = {
  进行中: 'bg-blue-50 text-blue-700',
  /** `在途` 只存在于内部交易（D68②），单独给一档颜色，避免和进行中混淆。 */
  在途: 'bg-amber-50 text-amber-800',
  已完成: 'bg-emerald-50 text-emerald-700',
  已取消: 'bg-slate-100 text-slate-500',
};

export const INTERNAL_TRADE_STATE_HINT: Readonly<Record<InternalTradeOrderStatus, string>> = {
  进行中: '开单后、发货前；只有这一步能改单',
  在途: '已发货、收货方未确认到货；批次仍归发出公司（D22 / D31）',
  已完成: '收货方已确认到货，批次归属已转移',
  已取消: '已作废；错账请另开一张，不物理删除（D47）',
};

/** 只有「进行中」能改单：`在途` 的货已经锁走，改了明细就对不上锁定（D68②）。 */
export function canEdit(state: InternalTradeOrderStatus): boolean {
  return state === '进行中';
}

/** 只有「在途」能到货确认；其余三态给原因。到货确认按 D31 转司并置已完成。 */
export function receiveDisabledReason(state: InternalTradeOrderStatus): string | null {
  switch (state) {
    case '在途':
      return null;
    case '进行中':
      return '还没发货，不能确认到货（到货确认仅在「在途」可用）';
    case '已完成':
      return '已到货确认，批次归属已转移（D31）';
    case '已取消':
      return '已作废，不能确认到货';
  }
}

/**
 * 发货 / 撤销发货在状态维度的原因：进行中可发货、在途可撤销，两个终态都没有可点的动作。
 * 权限维度（`internal_trade.ship`）不在这里判断——前端按钮按 scope 显隐，服务端再兜一次。
 */
export function dispatchDisabledReason(state: InternalTradeOrderStatus): string | null {
  switch (state) {
    case '进行中':
    case '在途':
      return null;
    case '已完成':
      return '已到货确认，批次归属已转移，不能再发货或撤销发货（D31）';
    case '已取消':
      return '已作废，不能发货或撤销发货';
  }
}

/* ------------------------------ 行与金额 ------------------------------ */

export interface InternalTradeLineDraft {
  productId: string;
  /** 一行可引多批次，至少 1 个（D22）。 */
  batchIds: string[];
  qty: string;
  unitPrice: string;
}

/** 行金额 = 数量 × 单价（定点，不走浮点）。 */
export function lineAmountOf(line: InternalTradeLineDraft): string {
  if (!isPositiveDecimal(line.qty) || !isPositiveDecimal(line.unitPrice)) return '0';
  return multiplyDecimal(line.qty, line.unitPrice);
}

/** 明细合计：只用于核对，**内部价以人工填写为准**（D68①）。 */
export function linesTotal(lines: readonly InternalTradeLineDraft[]): string {
  return sumDecimal(lines.map((line) => lineAmountOf(line)));
}

/** 明细总数量（列表里给一个「这张单搬了多少货」的量级）。 */
export function totalLineQty(
  lines: readonly { readonly qty: string }[],
): string {
  return sumDecimal(lines.map((line) => line.qty));
}

/**
 * 内部价与明细合计的差额说明。
 *
 * 内部价是制单人手填的（D68①），系统不按成本价 / 加成算，所以**允许不等于明细合计**
 * （比如含内部运费、或双方约定的打包价）。这里只把差额如实显示，不做任何「纠正」。
 */
export function internalPriceGap(internalPrice: string, lines: readonly InternalTradeLineDraft[]): string | null {
  if (!isPositiveDecimal(internalPrice) || lines.length === 0) return null;
  const total = linesTotal(lines);
  if (total === internalPrice) return null;
  return `内部价 ${internalPrice} 与明细合计 ${total} 不一致（D68① 允许手填，系统不自动改）`;
}

/* ------------------------------ 校验 ------------------------------ */

export function validateDraft(draft: {
  fromCompanyId: string;
  toCompanyId: string;
  handlerId: string;
  internalPrice: string;
  lines: readonly InternalTradeLineDraft[];
}): string[] {
  const errors: string[] = [];
  if (!draft.fromCompanyId) errors.push('请选择发出公司');
  if (!draft.toCompanyId) errors.push('请选择接收公司');
  if (draft.fromCompanyId && draft.toCompanyId && draft.fromCompanyId === draft.toCompanyId) {
    errors.push('发出公司与接收公司不能相同（自己和自己交易没有意义）');
  }
  if (!draft.handlerId) errors.push('缺少经手人');

  // 内部价是手填的（D68①）：允许 > 0，也允许 0（内部调拨不收钱），但不能空。
  if (draft.internalPrice.trim() === '') {
    errors.push('内部价必须手工填写（D68①：系统不按成本价 / 加成自动算）');
  } else if (!isPositiveDecimal(draft.internalPrice)) {
    errors.push('内部价必须是非负数字（最多 6 位小数）');
  }

  if (draft.lines.length === 0) errors.push('内部交易单至少 1 行商品明细');
  draft.lines.forEach((line, index) => {
    const label = `第 ${index + 1} 行商品`;
    if (!line.productId) errors.push(`${label}：请选择商品`);
    // 明细只能引发出公司批次（D22），所以先选公司再选批次。
    if (line.batchIds.length === 0) errors.push(`${label}：至少引用 1 个发出公司批次（D22）`);
    if (!isPositiveNonZeroDecimal(line.qty)) errors.push(`${label}：数量必须大于 0`);
    if (!isPositiveDecimal(line.unitPrice)) errors.push(`${label}：单价必须是非负数字`);
  });

  return errors;
}

/** 编辑时的入参：只允许改经手人 / 明细 / 内部价（发出接收公司不在本批修改范围）。 */
export function updateInputOf(
  lines: readonly InternalTradeLineDraft[],
  internalPrice: string,
  handlerId: string,
): InternalTradeOrderUpdateInput {
  return {
    handlerId,
    internalPrice: internalPrice.trim(),
    lines: lines.map((line) => ({
      productId: line.productId,
      batchIds: line.batchIds,
      qty: line.qty.trim(),
      unitPrice: line.unitPrice.trim(),
      amount: lineAmountOf(line),
    })),
  };
}

/* ------------------------------ 展示 ------------------------------ */

/** 批次下拉文案：批次号 + 可用量（可用量是唯一可引用数字，D38）。 */
export function batchOptionLabel(batch: InventoryBatch): string {
  return `${batch.batchNo}（可用 ${formatQty(batch.availableQty)}）`;
}

/** 商品名映射；明细只回 productId，取不到时退回 id 前 8 位。 */
export function productNameOf(products: readonly Product[], productId: string): string {
  return products.find((product) => product.id === productId)?.name ?? productId.slice(0, 8);
}

/** 批次号映射：明细只回 batchIds，取不到才退回 id 前缀。 */
export function batchLabelOf(batches: readonly InventoryBatch[], batchId: string): string {
  return batches.find((batch) => batch.id === batchId)?.batchNo ?? batchId.slice(0, 8);
}

/** 发出 → 接收（列表里一列讲清方向）。 */
export function tradeRouteText(order: {
  readonly fromCompanyName: string;
  readonly toCompanyName: string;
}): string {
  return `${order.fromCompanyName} → ${order.toCompanyName}`;
}
