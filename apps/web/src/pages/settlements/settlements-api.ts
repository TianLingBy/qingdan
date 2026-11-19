/**
 * 结算单 C 接口封装（22 页 IA 第 7 页；D2③ / D5 / D19 / D29 / D33 / D36 / D78）。
 *
 * 四条端点：列表 / 详情 / 确认结算 / 撤销结算。
 * **没有创建端点**——C 单草稿由 E / N 单「已完成」时系统自动生成（D19 / D29）。
 * 撤销结算（`unsettle`，D88 / #288）把已结算整单退回「待确认」，必须填原因并二次确认。
 *
 * 口径（别在这里发明）：
 * - **状态是独立两态** `待确认 / 已结算`（D2③），不复用单据三态，也没有「已取消」；
 * - **一期一单一次结算**（D19）：不支持部分结算 / 多次结算，`confirmable` 只认服务端结论；
 * - **毛利公式是服务端的**（D5）：`grossProfit` / `grossMarginRate` / `netProfit` 都是计算值，
 *   前端只渲染，不重算；毛利率是**比例**（`0.5` = 50%），不是百分比数字；
 * - **无 `settlement.view_price` 时金额一律 `null`**（D78）：显示 `—`，不用 0 顶替；
 *   有看价权限的详情读取服务端会记一条 `amount.detail` 审计（D51①）；
 * - 确认结算属审批动作：`settlement.approve` + 强 ETag `If-Match: "<version>"`（D60③ / D52①）。
 */

import type {
  SettlementOrder,
  SettlementOrderDetail,
  SettlementSourceDocType,
  SettlementOrderStatus,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';
import { formatQty, multiplyDecimal } from '../../lib/decimal';
import { internalTradesApi } from '../internal-trades/internal-trades-api';
import type { PageResult } from '../masterdata/masterdata-api';
import { salesApi } from '../sales/sales-api';

/* ------------------------------ 接口 ------------------------------ */

export interface SettlementListFilters {
  readonly companyId?: string;
  readonly status?: SettlementOrderStatus;
  readonly sourceDocType?: SettlementSourceDocType;
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

function listQuery(
  filters: SettlementListFilters,
): Record<string, string | number | undefined> {
  return {
    companyId: filters.companyId,
    status: filters.status,
    sourceDocType: filters.sourceDocType,
    keyword: filters.keyword,
    cursor: filters.cursor ?? undefined,
    limit: filters.limit ?? 50,
  };
}

export function createSettlementsApi(client: ApiClient = apiClient) {
  return {
    list: (filters: SettlementListFilters = {}) =>
      client.get<PageResult<SettlementOrder>>('/settlement-orders', {
        query: listQuery(filters),
      }),
    detail: (id: string) =>
      client.get<SettlementOrderDetail>(`/settlement-orders/${id}`),
    /** 确认结算（D19 一期一单一次）：待确认 → 已结算，之后不可冲正（D2③）。 */
    confirm: (id: string, version: number) =>
      client.post<SettlementOrderDetail>(`/settlement-orders/${id}/confirm`, undefined, {
        headers: { 'If-Match': `"${version}"` },
      }),
    /**
     * 撤销结算（D88 / #288）：已结算 → 待确认，整单退回。
     *
     * 三件事都必须做对：
     * - `confirm: true` 是契约的误触护栏，少这个字段服务端直接 422；
     * - `reason` 必填（1–200 字），落审计——财务事后要能答「谁为什么把结算撤了」；
     * - 强 ETag：不带 `If-Match` 服务端回 428，带了旧 version 回 409。
     */
    unsettle: (id: string, version: number, reason: string) =>
      client.post<SettlementOrderDetail>(
        `/settlement-orders/${id}/unsettle`,
        { confirm: true, reason },
        { headers: { 'If-Match': `"${version}"` } },
      ),
  };
}

export type SettlementsApi = ReturnType<typeof createSettlementsApi>;
export const settlementsApi = createSettlementsApi();

export const settlementQueryKeys = {
  list: (filters: SettlementListFilters) => ['settlements', 'list', filters] as const,
  detail: (id: string | null) => ['settlements', 'detail', id] as const,
  sourceDoc: (type: SettlementSourceDocType | null, id: string | null) =>
    ['settlements', 'source-doc', type, id] as const,
  sourceDocMap: (type: SettlementSourceDocType) =>
    ['settlements', 'source-doc-map', type] as const,
};

/**
 * 来源单单号解析（契约缺口）：`SettlementOrder` 只回 `sourceDocId`，**没有 `sourceDocNo`**，
 * 所以「来源单」列本来只能显示 id 前 8 位。详情面板用一次来源单详情换真实单号。
 *
 * 两条边界：
 * - 调用者可能只有 `settlement.read`、没有 `sales.read` → 来源单详情 403，
 *   **吞掉错误回 `null`**，退回 id 前 8 位，不让详情面板整体报错；
 * - 只做详情，不做列表：列表改用下面的 `fetchSourceDocNoMap` 批量换。
 */
export async function fetchSourceDocNo(
  type: SettlementSourceDocType,
  id: string,
): Promise<string | null> {
  try {
    const doc = type === 'E' ? await salesApi.detail(id) : await internalTradesApi.detail(id);
    return doc.orderNo;
  } catch {
    return null;
  }
}

/**
 * 来源单单号**批量**映射：列表用。
 *
 * 逐行发详情请求不划算（一页 50 行就是 50 条），改成按类型拉一页来源单建成 `id → 单号`，
 * 一次最多 200 张（`MAX_PAGE_LIMIT`）覆盖整页。边界同 `fetchSourceDocNo`：403 或失败就回空表，
 * 列表退回 id 前 8 位；比 200 张更老的来源单也解不出来，同样退回。
 */
export async function fetchSourceDocNoMap(
  type: SettlementSourceDocType,
): Promise<ReadonlyMap<string, string>> {
  try {
    const page =
      type === 'E'
        ? await salesApi.list({ limit: 200 })
        : await internalTradesApi.list({ limit: 200 });
    return new Map(page.items.map((item) => [item.id, item.orderNo]));
  } catch {
    return new Map();
  }
}

/* ------------------------------ 状态与来源 ------------------------------ */

/** 两态顺序即筛选选项顺序（D2③）。 */
export const SETTLEMENT_STATES: readonly SettlementOrderStatus[] = ['待确认', '已结算'];

/**
 * 状态 → v0.13 `.st` 语义档（颜色规则在 `styles/app-v013.css` 的 `.st` 系列）。
 * `待确认` 给 `bad`：不是出错，是「钱还没落定、等财务动手」，红一点才有人管（照视觉稿 C 单）。
 */
export const SETTLEMENT_STATE_TONE: Readonly<
  Record<SettlementOrderStatus, 'bad' | 'ok'>
> = {
  待确认: 'bad',
  已结算: 'ok',
};

export const SETTLEMENT_STATE_HINT: Readonly<Record<SettlementOrderStatus, string>> = {
  待确认: '系统在 E / N 单完成时自动生成的草稿，等财务确认',
  已结算: '财务已确认；一期一单一次，结算后不可冲正（错账走 R 退货）',
};

/** 来源单类型（D29）：只可能是 E 销售单 / N 内部交易单。 */
export const SETTLEMENT_SOURCE_LABEL: Readonly<Record<SettlementSourceDocType, string>> = {
  E: '销售单 E',
  N: '内部交易单 N',
};

/** 不可确认的原因（一期只有「已结算」一种，D19）。 */
export const CONFIRM_BLOCK_TEXT: Readonly<Record<string, string>> = {
  already_settled: '已结算，一期一单只结算一次（D19）',
};

export function confirmBlockedText(reason: string | null): string | null {
  if (reason === null) return null;
  return CONFIRM_BLOCK_TEXT[reason] ?? '当前状态不可确认';
}

/* ------------------------------ 展示口径 ------------------------------ */

/**
 * 来源单文案：契约只回 id，列表用「类型 + id 前 8 位」；
 * 详情能拿到来源单单号时传入 `docNo`，显示真实单号（契约缺口，见 `fetchSourceDocNo`）。
 */
export function sourceDocText(
  type: SettlementSourceDocType,
  id: string,
  docNo?: string | null,
): string {
  return `${SETTLEMENT_SOURCE_LABEL[type]} · ${docNo ?? id.slice(0, 8)}`;
}

/**
 * 列表用的紧凑文案：C 单号 / E、N 单号都以类型字母开头（`E-…` / `N-…`），
 * 所以列表里不再重复「销售单 E ·」这五个字——省下来的 ~90px 正好让 10 列进 1150px 卡片。
 * 详情面板仍用 `sourceDocText` 的完整写法。
 */
export function sourceDocShort(
  type: SettlementSourceDocType,
  id: string,
  docNo?: string | null,
): string {
  return docNo ?? `${type} · ${id.slice(0, 8)}`;
}

/**
 * 毛利率展示：契约里是**比例**（`0.5` = 50%），不是百分比数字。
 * 用定点乘法换百分比，保留 2 位；负数（毛利为负）照原样带负号。
 */
export function formatRate(rate: string | null): string {
  if (rate === null) return '—';
  const percent = multiplyDecimal(rate, '100');
  const negative = percent.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? percent.slice(1) : percent).split('.');
  const decimals = fraction.padEnd(2, '0').slice(0, 2);
  return `${negative ? '-' : ''}${integer}.${decimals}%`;
}

/** 提成比例快照同样是比例（`0.05` = 5%）；它**不随看价权限遮罩**，但撤销结算后为 null（D88）。 */
export function formatCommissionRate(rate: string | null): string {
  return formatRate(rate);
}

/** 提成金额为 0 且比例也为 0 时，说明「本公司没配提成比例」（D77 ②），不是算错。 */
export function commissionNote(rate: string | null, amount: string | null): string | null {
  if (rate === null) return null;
  if (Number(rate) === 0 && (amount === null || Number(amount) === 0)) {
    return '提成比例为 0：确认结算时按「提成归属人 + 本公司」解析配置，没配就记 0（D77 ②）';
  }
  return null;
}

/** 净毛利 = 毛利 − 本单相关损失（D33）；只在两个数都可见时用于「差了多少」的说明。 */
export function lossNote(grossProfit: string | null, relatedLossAmount: string | null): string | null {
  if (grossProfit === null || relatedLossAmount === null) return null;
  if (Number(relatedLossAmount) === 0) return null;
  return `净毛利已扣掉本单相关损失 ${formatQty(relatedLossAmount)}（D33 / D35）`;
}
