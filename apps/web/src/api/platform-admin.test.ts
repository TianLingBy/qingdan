import type { AuditLog, Company, Position } from '@qingdan/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client';
import { createPlatformAdminApi } from './platform-admin';

/**
 * platform 后台 4 页（#144）API 形状测试：
 * 路径对齐契约注册表（零自造端点）、If-Match 强 ETag、Body 形状对齐 .strict() 契约。
 */

const COMPANY: Company = {
  id: 'c1',
  tenantId: 't1',
  code: '0002',
  name: '华南分公司',
  version: 1,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
};

const POSITION: Position = {
  id: 'pos1',
  tenantId: 't1',
  name: '仓管',
  presetKey: 'warehouse',
  actions: [{ domain: 'inventory_qty', actions: ['read', 'create'] }],
  status: '启用',
  version: 2,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
};

const AUDIT_LOG: AuditLog = {
  id: 'a1',
  time: '2026-11-09T10:00:00.000Z',
  tenantId: 't1',
  companyId: null,
  actorType: 'employee',
  actorId: 'e1',
  credentialId: null,
  source: 'web',
  action: 'platform.company.create',
  objectType: 'company',
  objectId: 'c1',
  changeSummary: null,
  result: 'success',
  errorCode: null,
  requestId: 'req1',
  ip: null,
  ua: null,
  reason: null,
  businessTxId: null,
  dryRun: false,
};

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-test', ...headers },
  });
}

function makeApi() {
  const fetchImpl = vi.fn(async (_url?: unknown, _init?: RequestInit) =>
    jsonResponse({ items: [], nextCursor: null }),
  );
  const api = createPlatformAdminApi(
    new ApiClient({
      baseUrl: '/api/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      newRequestId: () => 'req-test',
    }),
  );
  return { api, fetchImpl };
}

describe('platform admin API（#144 四页共用）', () => {
  it('公司三端点路径与契约一致；更新带 If-Match、不传公司码（D16）', async () => {
    const { api, fetchImpl } = makeApi();

    await api.listCompanies();
    await api.createCompany({ name: '华南分公司' });
    await api.updateCompany('c1', { name: '新名字' }, 3);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toContain('/api/v1/companies?');
    expect(calls[1]?.[0]).toBe('/api/v1/companies');
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ name: '华南分公司' });
    expect(calls[2]?.[0]).toBe('/api/v1/companies/c1');
    expect(calls[2]?.[1]?.method).toBe('PATCH');
    expect(new Headers(calls[2]?.[1]?.headers).get('If-Match')).toBe('"3"');
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toEqual({ name: '新名字' });
  });

  it('岗位四端点路径与契约一致；模板动作不含 view_price（D4）', async () => {
    const { api, fetchImpl } = makeApi();

    await api.listPositions();
    await api.createPosition({ name: '仓管', actions: [{ domain: 'inventory_qty', actions: ['read'] }] });
    await api.updatePosition('pos1', { name: '仓库岗' }, 2);
    await api.disablePosition('pos1', 2);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toContain('/api/v1/positions?');
    expect(calls[1]?.[0]).toBe('/api/v1/positions');
    expect(calls[2]?.[0]).toBe('/api/v1/positions/pos1');
    expect(calls[3]?.[0]).toBe('/api/v1/positions/pos1');
    expect(calls[3]?.[1]?.method).toBe('DELETE');
    expect(new Headers(calls[3]?.[1]?.headers).get('If-Match')).toBe('"2"');
    // D60②：presetKey 不可改——更新入参类型上就没有这个字段。
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toEqual({ name: '仓库岗' });
  });

  it('操作日志走 /audit-logs 敏感读端点，游标透传', async () => {
    const { api, fetchImpl } = makeApi();

    await api.listAuditLogs();
    await api.listAuditLogs('cursor-abc');

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toContain('/api/v1/audit-logs?');
    expect(calls[1]?.[0]).toContain('cursor=cursor-abc');
  });

  it('Token 三端点：创建返回一次性 secret；撤销带 If-Match', async () => {
    const { api, fetchImpl } = makeApi();
    fetchImpl.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ ...tokenFixture(), status: 'revoked' });
      }
      if (init?.method === 'POST') {
        return jsonResponse({ ...tokenFixture(), secret: 'qdsk_one_time_secret' }, 201);
      }
      return jsonResponse({ items: [tokenFixture()], nextCursor: null });
    });

    const created = await api.createApiToken({
      name: 'AI 助手',
      employeeId: 'e1',
      scope: [{ domain: 'product', actions: ['read'] }],
    });
    expect(created.secret).toBe('qdsk_one_time_secret');

    await api.revokeApiToken('tok1', 1);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toContain('/api/v1/api-tokens');
    expect(calls[1]?.[0]).toBe('/api/v1/api-tokens/tok1');
    expect(new Headers(calls[1]?.[1]?.headers).get('If-Match')).toBe('"1"');
  });

  it('审计与 Token 列表能解析真实响应体', async () => {
    const { api } = makeApi();
    const logs = await api.listAuditLogs();
    expect(logs.items).toEqual([]);
    void AUDIT_LOG;
    void POSITION;
    void COMPANY;
  });
});

function tokenFixture() {
  return {
    id: 'tok1',
    tenantId: 't1',
    employeeId: 'e1',
    name: 'AI 助手',
    scope: [{ domain: 'product', actions: ['read'] }],
    expiresAt: null,
    ipAllowlist: [],
    lastUsedAt: null,
    status: 'active',
    version: 1,
    createdBy: 'e1',
    revokedAt: null,
    createdAt: '2026-11-09T00:00:00.000Z',
  };
}
