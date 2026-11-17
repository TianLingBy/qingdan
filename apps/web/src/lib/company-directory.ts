import { useQuery } from '@tanstack/react-query';
import { platformAdminApi } from '../api/platform-admin';

/**
 * 公司名簿：`id → 展示文案`（单据 A/B/E/N 与筛选器共用）。
 *
 * 为什么需要：`/auth/me` 只回 `companyIds`，单据契约只回 `companyId`，所以「所属公司」
 * 下拉原先直接渲染 UUID——业务用户面对 `01900000-0000-7000-8000-000000000002` 无从判断。
 *
 * 三条规矩（与 `employee-directory` 同口径）：
 *   1. 整册拉一次缓存 5 分钟，不按 id 分片；
 *   2. **失败静默降级**：读公司要 `company.read`（组织域），销售/仓管通常没有 →
 *      403 时吞错回空表，退回**短 id**（至少比整串 UUID 好认），页面不因此报错；
 *   3. 只做展示，不参与任何权限判定（D4/D15/D27）。
 */
export const companyDirectoryQueryKey = ['company-directory'] as const;

export interface CompanyOption {
  readonly id: string;
  /** 公司名 */
  readonly name: string;
  /** 公司码（4 位，D16 服务端发放）；可能为空串 */
  readonly code: string;
}

/** 纯函数：把公司列表转成 id → 文案的表（便于单测，不依赖 React）。 */
export function buildCompanyNameMap(
  companies: readonly { readonly id: string; readonly name: string; readonly code?: string | null }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const company of companies) {
    const code = company.code ?? '';
    map.set(company.id, code === '' ? company.name : `${company.name}（${code}）`);
  }
  return map;
}

/**
 * 降级用的短 id。
 *
 * 取**尾部**而不是前 8 位：公司 id 是 UUIDv7，前缀带时间戳，同一批建出来的公司前 8 位完全一样
 * （`01900000-…`），取头会得到两个一模一样、选不出区别的选项。尾部才分得清。
 */
export function shortIdLabel(id: string): string {
  return id.length > 6 ? `…${id.slice(-6)}` : id;
}

export function labelOfCompany(map: ReadonlyMap<string, string>, id: string | null): string {
  if (id === null || id === '') return '—';
  return map.get(id) ?? shortIdLabel(id);
}

/** 组件里用：返回一个 `id → 文案` 的查表函数（无权限 / 加载中都会退化成短 id）。 */
export function useCompanyLabel(): (id: string | null) => string {
  const query = useQuery({
    queryKey: companyDirectoryQueryKey,
    queryFn: () => platformAdminApi.listCompanies(),
    staleTime: 5 * 60_000,
    retry: false,
    // 读公司要组织域权限；拿不到就当空表降级，不弹错
    throwOnError: false,
  });
  const map = buildCompanyNameMap(query.data?.items ?? []);
  return (id) => labelOfCompany(map, id);
}
