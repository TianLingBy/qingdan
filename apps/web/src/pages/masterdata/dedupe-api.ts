import type {
  DedupeDecisionResult,
  DedupeKind,
  DedupeListResult,
  DedupeMergeDirection,
  DedupeMergeResult,
  DedupeState,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';

/**
 * 主数据去重审核台接口（D102 / D103，契约 `packages/contracts/src/masterdata-dedupe.ts`）。
 *
 * 为什么单独一只 api 文件而不是塞进 `masterdata-api.ts`：
 * 审核台的四个 operationId 虽然都叫 `customer.dedupe.*`，但**鉴权按对子真实的 kind 走**
 * （`readableKinds` / `requireKindMerge`），它横跨 customer / supplier / processor / product
 * 四类档案，语义上和「商品/客户/供应商/加工厂四张表各管各的」不是一件事；
 * 混进 masterdata-api 会让后来人以为这页只跟客户有关。
 *
 * 前缀 `/masterdata/dedupe`：`ApiClient` 的 baseUrl 已经是 `/api/v1`，这里只写路径剩余部分。
 */

export interface DedupeListFilters {
  /** **必传**：principal 的可见公司是个集合，服务端拿 `companyIds[0]` 兜底会把 A 公司的待办显示成 B 公司的。 */
  readonly companyId: string;
  /** 不传 = 全部类型（服务端按 LIMIT 混合排队）。 */
  readonly kind?: DedupeKind;
  /** 不传 = 服务端按 `pending` 处理。 */
  readonly state?: DedupeState;
}

export function createDedupeApi(client: ApiClient = apiClient) {
  return {
    list: (filters: DedupeListFilters) =>
      client.get<DedupeListResult>('/masterdata/dedupe', {
        // undefined 会被 `appendQuery` 跳过，所以「全部类型 / 默认状态」就是不带这个参数，
        // 而不是传空串——空串会被服务端 zod 当成非法枚举值 422。
        query: {
          companyId: filters.companyId,
          kind: filters.kind,
          state: filters.state,
        },
      }),

    /** 判为不同：此后这对不再提示（`pending → kept`）。`reason` 必填 1–200 字。 */
    keepSeparate: (id: string, reason: string) =>
      client.post<DedupeDecisionResult>(`/masterdata/dedupe/${id}/keep-separate`, { reason }),

    /** 撤销判定：`kept → pending`，同样要原因（谁把这对放回来的，得留痕）。 */
    reopen: (id: string, reason: string) =>
      client.post<DedupeDecisionResult>(`/masterdata/dedupe/${id}/reopen`, { reason }),

    /**
     * 合并：body **只有 `direction`**。
     *
     * 服务端 `DedupeMergeInputSchema` 是 `.strict()`，多传一个 `sourceId` 之类就是 422；
     * id 一律来自路径（那是服务端自己读出来的队列行），这里不往 body 里塞任何别的东西。
     */
    merge: (id: string, direction: DedupeMergeDirection) =>
      client.post<DedupeMergeResult>(`/masterdata/dedupe/${id}/merge`, { direction }),
  };
}

export type DedupeApi = ReturnType<typeof createDedupeApi>;
export const dedupeApi = createDedupeApi();

/**
 * 查询键。
 *
 * 把三个筛选值都摊平进 key，而不是塞一个对象进去：对象的键序在调用方写错时会变，
 * 摊平后 `['masterdata','dedupe',companyId,kind,state]` 的语义一目了然；
 * `?? null` 是为了让「不筛类型」有稳定的序列化结果（`undefined` 在 key 里和缺键等价，
 * 但显式 `null` 能让测试预置缓存时一眼看出传的是「不筛」）。
 */
export const dedupeQueryKeys = {
  list: (filters: DedupeListFilters) =>
    [
      'masterdata',
      'dedupe',
      filters.companyId,
      filters.kind ?? null,
      filters.state ?? null,
    ] as const,
};
