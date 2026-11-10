import { apiClient } from './client';

/**
 * platform 域 API（员工页 / 权限覆盖面板用）。
 *
 * 端点对齐 `packages/contracts/src/employees.ts` / `domains.ts`（D44/D50/D52）：
 * - `GET /employees`：员工列表（手机号脱敏，D15/D50）；
 * - `GET /auth/me`：当前身份 + 生效权限矩阵（D52.1②，每请求现算）；
 * - `GET /positions`：岗位列表（权限模板，#121/#156 补齐；未上线时面板降级）；
 * - `PATCH /employees/{employeeId}/permissions`：个人级权限覆盖（D50），
 *   成功 204 + 响应头 `ETag: "<新版本>"`；If-Match 选填。
 */

/** 员工「公司 × 岗位」绑定（列表接口返回）。 */
export interface EmployeeCompanyRef {
  readonly companyId: string;
  readonly companyName: string;
  readonly positionId: string;
  readonly positionName: string;
}

/** 员工摘要（列表口径；手机号只回脱敏，完整号不出服务端）。 */
export interface EmployeeSummary {
  readonly id: string;
  readonly employeeNo: string;
  readonly name: string;
  readonly status: string;
  readonly isOwner: boolean;
  readonly phoneMasked: string;
  readonly companies: readonly EmployeeCompanyRef[];
}

/** 当前身份（D52.1②）：scope = 生效权限矩阵（每请求现算，前端只用于裁剪选项）。 */
export interface MeResult {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly companyIds: readonly string[];
  /** 生效权限矩阵：`{ domain, actions[] }` 数组（契约 ScopeMatrix）。 */
  readonly scope: readonly { domain: string; actions: readonly string[] }[];
}

/** 岗位（权限模板，契约 positions.ts；#156 上线前此端点 501，面板需降级）。 */
export interface PositionSummary {
  readonly id: string;
  readonly name: string;
  readonly presetKey: string | null;
  readonly status: string;
  readonly actions: readonly { domain: string; actions: readonly string[] }[];
}

/** 一次覆盖动作：domain × action × granted（granted=false 为减权）。 */
export interface PermissionOverrideEntry {
  readonly domain: string;
  readonly action: string;
  readonly granted: boolean;
}

export async function fetchMe(): Promise<MeResult> {
  return apiClient.get<MeResult>('/auth/me');
}

export async function fetchEmployees(): Promise<{ items: EmployeeSummary[]; nextCursor: string | null }> {
  return apiClient.get<{ items: EmployeeSummary[]; nextCursor: string | null }>('/employees', {
    query: { limit: 100 },
  });
}

export async function fetchPositions(): Promise<{ items: PositionSummary[]; nextCursor: string | null }> {
  return apiClient.get<{ items: PositionSummary[]; nextCursor: string | null }>('/positions', {
    query: { limit: 100 },
  });
}

/**
 * 提交个人权限覆盖（D50）。
 * - `etagVersion` 选填：员工列表接口暂不回 version，默认不传（跳过版本校验）；
 * - 成功 204 无响应体，通过 `onSuccess` 拿响应头里的 `ETag`（新版本）；
 * - 失败 403：`details.reason` ∈ TARGET_IS_OWNER / TARGET_IS_MANAGER / TARGET_IS_FINANCE /
 *   SELF_ESCALATION_DENIED，或 `details.denied` 列出超出调用者权限的项。
 */
export async function updatePermissionOverrides(
  employeeId: string,
  overrides: readonly PermissionOverrideEntry[],
  options: { dryRun?: boolean; etag?: string; onSuccess?: (etag: string | null) => void } = {},
): Promise<void> {
  await apiClient.request<void>(`/employees/${employeeId}/permissions`, {
    method: 'PATCH',
    body: { overrides },
    headers: options.etag ? { 'If-Match': options.etag } : undefined,
    query: options.dryRun ? { dryRun: true } : undefined,
    responseMeta: (meta) => {
      const etag = meta.headers.get('ETag');
      options.onSuccess?.(etag);
    },
  });
}
