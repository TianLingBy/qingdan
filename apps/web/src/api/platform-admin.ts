import type {
  ApiToken,
  AuditLog,
  Company,
  CompanyCreateInput,
  CompanyUpdateInput,
  Position,
  PositionCreateInput,
  PositionUpdateInput,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from './client';

/**
 * platform 后台 4 页（#144）共用的 API 薄封装。
 *
 * 端点全部来自契约注册表（packages/contracts/src/routes.ts），零自造：
 * - 公司管理：`GET/POST /companies`、`PATCH /companies/{id}`（If-Match，公司码不可改，D16）；
 * - 权限设置（岗位模板）：`GET/POST /positions`、`PATCH/DELETE /positions/{id}`
 *   （If-Match；停用=软删除、被占用拒绝，契约注释见 positions.ts）；
 * - 操作日志：`GET /audit-logs`（敏感读，服务端必记审计；契约查询参数只有分页，
 *   操作人/对象筛选在客户端做）；
 * - API Token：`GET/POST /api-tokens`、`DELETE /api-tokens/{id}`（If-Match；
 *   创建响应的 `secret` 只出现一次）。
 */

export interface PageResult<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

function ifMatch(version: number): Record<string, string> {
  return { 'If-Match': `"${version}"` };
}

export function createPlatformAdminApi(client: ApiClient = apiClient) {
  return {
    // —— 公司管理（domain: company）——
    listCompanies: () =>
      client.get<PageResult<Company>>('/companies', { query: { limit: 100 } }),
    createCompany: (input: CompanyCreateInput) => client.post<Company>('/companies', input),
    updateCompany: (id: string, input: CompanyUpdateInput, version: number) =>
      client.patch<Company>(`/companies/${id}`, input, { headers: ifMatch(version) }),

    // —— 岗位模板（domain: permission）——
    listPositions: () =>
      client.get<PageResult<Position>>('/positions', { query: { limit: 100 } }),
    createPosition: (input: PositionCreateInput) => client.post<Position>('/positions', input),
    updatePosition: (id: string, input: PositionUpdateInput, version: number) =>
      client.patch<Position>(`/positions/${id}`, input, { headers: ifMatch(version) }),
    disablePosition: (id: string, version: number) =>
      client.delete<Position>(`/positions/${id}`, { headers: ifMatch(version) }),

    // —— 操作日志（domain: audit，敏感读）——
    listAuditLogs: (cursor?: string | null) =>
      client.get<PageResult<AuditLog>>('/audit-logs', {
        query: { limit: 50, cursor: cursor ?? undefined },
      }),

    // —— API Token（domain: api_integration，列表敏感读）——
    listApiTokens: () =>
      client.get<PageResult<ApiToken>>('/api-tokens', { query: { limit: 100 } }),
    createApiToken: (input: {
      name: string;
      employeeId: string;
      scope: readonly { domain: string; actions: readonly string[] }[];
      expiresAt?: string | null;
    }) =>
      client.post<ApiToken & { secret: string }>('/api-tokens', {
        name: input.name,
        employeeId: input.employeeId,
        scope: input.scope,
        expiresAt: input.expiresAt ?? null,
      }),
    revokeApiToken: (id: string, version: number) =>
      client.delete<ApiToken>(`/api-tokens/${id}`, { headers: ifMatch(version) }),
  };
}

/** 应用默认实例。 */
export const platformAdminApi = createPlatformAdminApi();
