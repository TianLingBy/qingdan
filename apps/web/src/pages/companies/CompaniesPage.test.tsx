import type { AuditLog, Company, Position } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { ApiIntegrationPage } from '../api-integration/ApiIntegrationPage';
import { AuditLogsPage } from '../audit/AuditLogsPage';
import { CompaniesPage } from './CompaniesPage';
import { PermissionsPage } from '../permissions/PermissionsPage';

/**
 * #144 四页渲染测试（SSR 静态渲染 + 预置 query 数据，模式同 MasterdataPage.test.tsx）：
 * 真数据渲染、空态、关键口径文案。
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
  name: '纯仓管',
  presetKey: 'warehouse',
  actions: [
    { domain: 'inventory_qty', actions: ['read', 'create'] },
    { domain: 'inventory_flow', actions: ['read'] },
  ],
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

function render(page: React.ReactElement, seed: (client: ReturnType<typeof createQueryClient>) => void) {
  const client = createQueryClient();
  seed(client);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}

describe('公司管理页（#144）', () => {
  it('渲染公司码与名称，并声明公司码不可改（D16）', () => {
    const html = render(<CompaniesPage />, (client) => {
      client.setQueryData(['admin', 'companies'], { items: [COMPANY], nextCursor: null });
    });
    expect(html).toContain('公司管理');
    expect(html).toContain('0002');
    expect(html).toContain('华南分公司');
    expect(html).toContain('D16');
  });

  it('空列表提供明确空态', () => {
    const html = render(<CompaniesPage />, (client) => {
      client.setQueryData(['admin', 'companies'], { items: [], nextCursor: null });
    });
    expect(html).toContain('还没有公司');
  });
});

describe('权限设置页（#144）', () => {
  it('渲染岗位与权限摘要，声明看价不进模板（D4）', () => {
    const html = render(<PermissionsPage />, (client) => {
      client.setQueryData(['admin', 'positions'], { items: [POSITION], nextCursor: null });
    });
    expect(html).toContain('权限设置');
    expect(html).toContain('纯仓管');
    expect(html).toContain('预设 · 仓管');
    expect(html).toContain('D4');
    expect(html).toContain('新建岗位');
  });
});

describe('操作日志页（#144）', () => {
  it('渲染敏感读标识与日志行', () => {
    const html = render(<AuditLogsPage />, (client) => {
      client.setQueryData(['admin', 'audit-logs'], { items: [AUDIT_LOG], nextCursor: null });
    });
    expect(html).toContain('操作日志');
    expect(html).toContain('敏感读');
    expect(html).toContain('platform.company.create');
    expect(html).toContain('成功');
  });

  it('空列表提供明确空态', () => {
    const html = render(<AuditLogsPage />, (client) => {
      client.setQueryData(['admin', 'audit-logs'], { items: [], nextCursor: null });
    });
    expect(html).toContain('还没有操作记录');
  });
});

describe('API 与集成页（#144）', () => {
  it('渲染 Token 行与接口契约真源、一次性密钥口径', () => {
    const html = render(<ApiIntegrationPage />, (client) => {
      client.setQueryData(['admin', 'api-tokens'], {
        items: [
          {
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
          },
        ],
        nextCursor: null,
      });
      client.setQueryData(['me'], {
        employeeId: 'e1',
        tenantId: 't1',
        displayName: '测试',
        companyIds: [],
        scope: [{ domain: 'product', actions: ['read', 'create'] }],
      });
    });
    expect(html).toContain('API 与集成');
    expect(html).toContain('AI 助手');
    expect(html).toContain('接口契约真源');
    expect(html).toContain('/api/v1/openapi.json');
    expect(html).toContain('只存');
  });
});
