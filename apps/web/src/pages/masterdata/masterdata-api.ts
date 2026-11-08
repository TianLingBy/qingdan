import type {
  Product,
  ProductCreateInput,
  ProductUpdateInput,
  Processor,
  ProcessorCreateInput,
  ProcessorQuote,
  ProcessorQuoteCreateInput,
  ProcessorUpdateInput,
  Supplier,
  SupplierCreateInput,
  SupplierUpdateInput,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';

export interface PageResult<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface MeResponse {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly companyIds: string[];
  readonly scope: readonly {
    readonly domain: string;
    readonly actions: readonly string[];
  }[];
}

export interface MasterdataListFilters {
  readonly companyId?: string;
  readonly status?: '启用' | '停用';
  readonly keyword?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

function listQuery(filters: MasterdataListFilters): Record<string, string | number | undefined> {
  return {
    companyId: filters.companyId,
    status: filters.status,
    keyword: filters.keyword,
    cursor: filters.cursor ?? undefined,
    limit: filters.limit ?? 50,
  };
}

function ifMatch(version: number): Record<string, string> {
  return { 'If-Match': `"${version}"` };
}

export function createMasterdataApi(client: ApiClient = apiClient) {
  return {
    me: () => client.get<MeResponse>('/auth/me'),

    listProducts: (filters: MasterdataListFilters = {}) =>
      client.get<PageResult<Product>>('/products', { query: listQuery(filters) }),
    createProduct: (input: ProductCreateInput) =>
      client.post<Product>('/products', input),
    updateProduct: (id: string, input: ProductUpdateInput, version: number) =>
      client.patch<Product>(`/products/${id}`, input, { headers: ifMatch(version) }),
    disableProduct: (id: string, version: number) =>
      client.delete<Product>(`/products/${id}`, { headers: ifMatch(version) }),

    listSuppliers: (filters: MasterdataListFilters = {}) =>
      client.get<PageResult<Supplier>>('/suppliers', { query: listQuery(filters) }),
    createSupplier: (input: SupplierCreateInput) =>
      client.post<Supplier>('/suppliers', input),
    updateSupplier: (id: string, input: SupplierUpdateInput, version: number) =>
      client.patch<Supplier>(`/suppliers/${id}`, input, { headers: ifMatch(version) }),
    disableSupplier: (id: string, version: number) =>
      client.delete<Supplier>(`/suppliers/${id}`, { headers: ifMatch(version) }),

    listProcessors: (filters: MasterdataListFilters = {}) =>
      client.get<PageResult<Processor>>('/processors', { query: listQuery(filters) }),
    createProcessor: (input: ProcessorCreateInput) =>
      client.post<Processor>('/processors', input),
    updateProcessor: (id: string, input: ProcessorUpdateInput, version: number) =>
      client.patch<Processor>(`/processors/${id}`, input, { headers: ifMatch(version) }),
    disableProcessor: (id: string, version: number) =>
      client.delete<Processor>(`/processors/${id}`, { headers: ifMatch(version) }),

    listProcessorQuotes: (processorId: string) =>
      client.get<PageResult<ProcessorQuote>>('/processor-quotes', {
        query: { processorId, limit: 50 },
      }),
    createProcessorQuote: (input: ProcessorQuoteCreateInput) =>
      client.post<ProcessorQuote>('/processor-quotes', input),
  };
}

export type MasterdataApi = ReturnType<typeof createMasterdataApi>;
export const masterdataApi = createMasterdataApi();

export const masterdataQueryKeys = {
  me: ['auth', 'me'] as const,
  list: (
    entity: 'products' | 'suppliers' | 'processors',
    filters: {
      keyword?: string;
      status?: '启用' | '停用';
      cursor?: string | null;
      companyId?: string;
    },
  ) => ['masterdata', entity, filters] as const,
  processorQuotes: (processorId: string | null) =>
    ['masterdata', 'processor-quotes', processorId] as const,
};

export interface ApiIssue {
  readonly path: string;
  readonly message: string;
}

/** 从统一错误体的 details.issues 中提取字段错误。 */
export function extractIssues(details: unknown): ApiIssue[] {
  if (typeof details !== 'object' || details === null || !('issues' in details)) return [];
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const entry = item as Record<string, unknown>;
    return typeof entry.message === 'string'
      ? [{ path: typeof entry.path === 'string' ? entry.path : '', message: entry.message }]
      : [];
  });
}

/** 空字符串表示“不填写”，避免把可选字段保存成空串。 */
export function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function splitList(value: string): string[] {
  return value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function formatPrice(value: string | null): string {
  return value === null ? '—（无看价权限或未设置）' : value;
}
