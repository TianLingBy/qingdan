import type { Product, Supplier } from '@qingdan/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api/client';
import { createMasterdataApi, extractIssues, splitList } from './masterdata-api';

const PRODUCT: Product = {
  id: 'p1',
  tenantId: 't1',
  companyId: '00000000-0000-4000-8000-000000000001',
  productNo: 'P-1',
  name: '苹果',
  aliases: ['红富士'],
  specification: '箱',
  unit: '件',
  status: '启用',
  defaultSalePrice: '12.50',
  version: 1,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' },
  });
}

describe('masterdata API', () => {
  it('列表使用真实查询参数与统一 /api/v1 路径', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [PRODUCT], nextCursor: null }),
    );
    const api = createMasterdataApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        newRequestId: () => 'req-api-list',
      }),
    );

    const result = await api.listProducts({
      keyword: '苹果',
      status: '启用',
      limit: 20,
    });

    expect(result.items[0]?.name).toBe('苹果');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/v1/products?');
    expect(url).toContain('keyword=%E8%8B%B9%E6%9E%9C');
    expect(url).toContain('status=%E5%90%AF%E7%94%A8');
    expect(init.method).toBe('GET');
  });

  it('更新与停用使用 If-Match 强 ETag', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ ...PRODUCT, status: '停用', version: 2 });
      }
      return jsonResponse({ ...PRODUCT, name: '新苹果', version: 2 });
    });
    const api = createMasterdataApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        newRequestId: () => 'req-api-write',
      }),
    );

    await api.updateProduct('p1', { name: '新苹果' }, 1);
    const updateInit = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(updateInit.method).toBe('PATCH');
    expect(new Headers(updateInit.headers).get('If-Match')).toBe('"1"');

    await api.disableProduct('p1', 1);
    const deleteInit = (fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect(deleteInit.method).toBe('DELETE');
    expect(new Headers(deleteInit.headers).get('If-Match')).toBe('"1"');
  });

  it('供应商与加工厂走各自端点', async () => {
    const supplier: Supplier = {
      id: 's1',
      tenantId: 't1',
      companyId: PRODUCT.companyId,
      supplierNo: null,
      name: '纸箱厂',
      contactName: null,
      contactPhone: null,
      suppliedMaterials: ['纸箱'],
      status: '启用',
      version: 1,
      createdAt: PRODUCT.createdAt,
      updatedAt: PRODUCT.updatedAt,
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [supplier], nextCursor: null }),
    );
    const api = createMasterdataApi(
      new ApiClient({
        baseUrl: '/api/v1',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        newRequestId: () => 'req-api-entities',
      }),
    );

    await api.listSuppliers();
    await api.listProcessors();
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain('/api/v1/suppliers');
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toContain('/api/v1/processors');
  });

  it('表单辅助函数保留后端字段错误并拆分中文/英文逗号', () => {
    expect(splitList('红富士，苹果,礼盒')).toEqual(['红富士', '苹果', '礼盒']);
    expect(
      extractIssues({
        issues: [{ path: 'name', message: '名称不能为空' }],
      }),
    ).toEqual([{ path: 'name', message: '名称不能为空' }]);
  });
});
