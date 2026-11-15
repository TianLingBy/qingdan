import { useQuery } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '../api/client';
import { platformAdminApi } from '../api/platform-admin';
import {
  buildCompanyNameMap,
  companyDirectoryQueryKey,
  labelOfCompany,
} from '../lib/company-directory';

/**
 * 公司切换（页面级筛选，**不是**会话级切换，见 #213 / #240）。
 *
 * 为什么只有「授权公司」而不用 `GET /companies` 的整册目录：
 * `me.companyIds`（`/auth/me`）才是当前主体被授权的公司集合；`GET /companies`
 * 需要 `company.read`（组织域，只有老板/经理有）且返回**租户内全部公司**。
 * 直接渲染目录会把未授权公司也放进下拉，等于让前端选择扩大授权范围——#213 明令禁止。
 * 所以这里：
 *   1. 下拉选项 = `me.companyIds`（授权集合），`GET /companies` 只用来换**名字**；
 *   2. 选中只写进一个轻量状态供页面做筛选，**不改变任何权限**（判定仍以后端为准）；
 *   3. `GET /companies` 失败分两种：403（无 company.read）按既有 `company-directory`
 *      口径静默退回短 id，下拉照常可用；网络/5xx 才算「请求失败」，禁用并提示。
 */

/** 会话内记忆所选公司的键；登出时清除（`clearActiveCompany`）。 */
const ACTIVE_COMPANY_STORAGE_KEY = 'qingdan.activeCompanyId';

interface ActiveCompanyValue {
  /** 当前选中的公司 id；`''` 表示「全部公司」（不筛选）。 */
  readonly companyId: string;
  readonly setCompanyId: (id: string) => void;
}

const ActiveCompanyContext = createContext<ActiveCompanyValue | null>(null);

function readStoredActiveCompany(): string {
  try {
    if (typeof sessionStorage === 'undefined') return '';
    return sessionStorage.getItem(ACTIVE_COMPANY_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * 提供「当前选中公司」上下文。状态用 sessionStorage 兜底，刷新后保留，
 * 登出时由 `clearActiveCompany()` 清掉，避免下一会话读到上一人的残留。
 */
export function ActiveCompanyProvider({ children }: { children: ReactNode }) {
  const [companyId, setCompanyIdState] = useState<string>(readStoredActiveCompany);

  const setCompanyId = useCallback((id: string) => {
    setCompanyIdState(id);
    try {
      if (typeof sessionStorage === 'undefined') return;
      if (id === '') {
        sessionStorage.removeItem(ACTIVE_COMPANY_STORAGE_KEY);
      } else {
        sessionStorage.setItem(ACTIVE_COMPANY_STORAGE_KEY, id);
      }
    } catch {
      // 隐私模式等写不进 sessionStorage：内存态仍然生效，只是刷新后不保留。
    }
  }, []);

  const value = useMemo(() => ({ companyId, setCompanyId }), [companyId, setCompanyId]);

  return <ActiveCompanyContext.Provider value={value}>{children}</ActiveCompanyContext.Provider>;
}

/** 页面用它读取/设置当前公司筛选；必须在 `ActiveCompanyProvider` 内使用。 */
export function useActiveCompany(): ActiveCompanyValue {
  const ctx = useContext(ActiveCompanyContext);
  if (!ctx) {
    throw new Error('useActiveCompany 必须在 ActiveCompanyProvider 内使用');
  }
  return ctx;
}

/** 登出时清掉会话内残留的公司选择。 */
export function clearActiveCompany(): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(ACTIVE_COMPANY_STORAGE_KEY);
    }
  } catch {
    // 忽略：清不掉也不影响安全（下次会话只会读到一个可能失效的筛选 id，页面侧按授权集兜底）。
  }
}

/* ------------------------------ 公司目录（仅取名） ------------------------------ */

/** 403 = 无 `company.read`（组织域权限），不是请求失败，按短 id 降级。 */
function isPermissionDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export interface CompanyDirectoryView {
  /** `id → 展示文案`（名称（码）；无权限/未命中退回短 id）。 */
  readonly label: (id: string) => string;
  /** true = 真正的请求失败（网络/5xx），下拉禁用并显示「公司列表读取失败」。 */
  readonly failed: boolean;
}

/** 拉公司目录做名称查表。复用 `platformAdminApi.listCompanies()`，不新建 api client。 */
export function useCompanyDirectory(): CompanyDirectoryView {
  const query = useQuery({
    queryKey: companyDirectoryQueryKey,
    queryFn: () => platformAdminApi.listCompanies(),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const label = useMemo(() => {
    const map = buildCompanyNameMap(query.data?.items ?? []);
    return (id: string) => labelOfCompany(map, id);
  }, [query.data]);

  return {
    label,
    failed: query.isError && !isPermissionDenied(query.error),
  };
}

/* ------------------------------ 下拉组件 ------------------------------ */

const SELECT_CLASS =
  'max-w-[9.5rem] rounded-lg border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-600';

export interface CompanySwitcherProps {
  /** 授权公司集合（来自 `/auth/me` 的 `companyIds`），不是整册公司目录。 */
  readonly companyIds: readonly string[];
  /** 名称查表与失败状态（`useCompanyDirectory()`）。 */
  readonly directory: CompanyDirectoryView;
  /** 「全部公司」选项文案（如 `全部公司（3 家）`）。 */
  readonly allCompaniesLabel: string;
}

/**
 * 顶栏公司下拉：选项 = 「全部公司」+ 每个授权公司，默认「全部公司」。
 * 选中只写 `useActiveCompany()`，不改任何权限；请求失败/无授权时禁用降级。
 */
export function CompanySwitcher({ companyIds, directory, allCompaniesLabel }: CompanySwitcherProps) {
  const { companyId, setCompanyId } = useActiveCompany();

  // 会话里可能残留上一个账号的选择：不在当前授权集合里就退回「全部公司」。
  const selectedId = companyIds.includes(companyId) ? companyId : '';

  if (directory.failed) {
    return (
      <select aria-label="公司切换" disabled title="公司列表读取失败" className={SELECT_CLASS}>
        <option>公司列表读取失败</option>
      </select>
    );
  }

  if (companyIds.length === 0) {
    return (
      <select aria-label="公司切换" disabled className={SELECT_CLASS}>
        <option>{allCompaniesLabel}</option>
      </select>
    );
  }

  return (
    <select
      aria-label="公司切换"
      value={selectedId}
      onChange={(event) => setCompanyId(event.target.value)}
      title="页面级筛选：仅展示授权公司，选择不会改变权限范围"
      className={SELECT_CLASS}
    >
      <option value="">{allCompaniesLabel}</option>
      {companyIds.map((id) => (
        <option key={id} value={id}>
          {directory.label(id)}
        </option>
      ))}
    </select>
  );
}
