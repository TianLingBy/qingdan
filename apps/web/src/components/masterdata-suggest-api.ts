import { apiClient, type ApiClient } from '../api/client.js';

/**
 * 主数据「建档防重」联想接口（D99 / #302 块 B）。
 *
 * 四个域共用一条形状，只差路径与方法名 —— 各抄四份只会让「改一个字段」变成四次改动，
 * 所以这里用一张表 + 一个工厂。
 *
 * 为什么 `companyId` 必传（契约 `packages/contracts/src/suggest.ts:34`）：
 * principal 只有「可见公司集合」，集合顺序由授权查询决定、不是用户当前选中的公司。
 * 服务端若拿 `companyIds[0]` 兜底，用户在 A 公司开单页打字时可能看到 B 公司的客户名，
 * 既漏了别家又引导他真去建一条 B 公司的档案，而且全程不报错。
 */

/** 支持联想的四个主数据域。`product` 也走同一形状，只是匹配 `name` 与 `aliases`。 */
export type SuggestKind = 'customer' | 'supplier' | 'processor' | 'product';

/**
 * 契约实际只回这四个字段（`packages/contracts/src/suggest.ts:44-51`）。
 *
 * 设计稿 `docs/design-masterdata-autocreate.md:53` 写的是「id/名称/编号/电话/规格」，
 * 契约刻意砍成四个 —— suggest 会命中别的公司里的同名档案，带上电话地址就变成
 * 跨公司信息探测器。**按契约写，不按设计稿写。**
 */
export interface SuggestCandidate {
  readonly id: string;
  readonly name: string;
  /** 相似度 0~1，1 = 规范化后的名称完全相同。 */
  readonly score: number;
  /** 给人看的短句：`名称完全相同` / `名称高度相似` / `名称部分相似` / `名称相同但公司不同`。 */
  readonly reason: string;
}

export interface SuggestResult {
  readonly candidates: readonly SuggestCandidate[];
}

export interface SuggestQuery {
  readonly name: string;
  readonly companyId: string;
  readonly limit?: number;
}

/** 四个域的路径前缀。增域时只改这张表。 */
const SUGGEST_PATHS: Record<SuggestKind, string> = {
  customer: '/customers/suggest',
  supplier: '/suppliers/suggest',
  processor: '/processors/suggest',
  product: '/products/suggest',
};

export interface MasterdataSuggestApi {
  suggest(kind: SuggestKind, query: SuggestQuery): Promise<SuggestResult>;
}

export function createMasterdataSuggestApi(client: ApiClient = apiClient): MasterdataSuggestApi {
  return {
    suggest(kind, query) {
      const search = new URLSearchParams({
        name: query.name,
        companyId: query.companyId,
      });
      // limit 不传就是服务端的默认值（5）。这里不写死一个数字，
      // 免得契约改了上限而前端还在传旧值。
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      return client.get<SuggestResult>(`${SUGGEST_PATHS[kind]}?${search.toString()}`);
    },
  };
}

/** 页面直接用这个单例；测试里用 `createMasterdataSuggestApi(假 client)` 注入。 */
export const masterdataSuggestApi = createMasterdataSuggestApi();
