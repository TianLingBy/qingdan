import type { AuditLog } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { authKeys } from '../auth/auth-api';
import { AuditLogsPage, filterAuditLogs } from './AuditLogsPage';

/**
 * #434 操作日志页 v3.0：四态 / 游标翻页 / 客户端筛选（关键字·结果·来源）/ 敏感读标识。
 * 模式同 CompaniesPage.test.tsx —— renderToStaticMarkup + 预置 query 数据。
 */

function log(over: Partial<AuditLog> = {}): AuditLog {
  return {
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
    ...over,
  };
}

function render(seed: (client: ReturnType<typeof createQueryClient>) => void): string {
  const client = createQueryClient();
  client.setQueryData(authKeys.me, {
    employeeId: 'e1',
    tenantId: 't1',
    displayName: '张明',
    companyIds: ['c1'],
    scope: [{ domain: 'audit', actions: ['read'] }],
  });
  seed(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AuditLogsPage />
    </QueryClientProvider>,
  );
}

function seedLogs(client: ReturnType<typeof createQueryClient>, items: AuditLog[], nextCursor: string | null) {
  client.setQueryData(['admin', 'audit-logs', null], { items, nextCursor });
}

describe('操作日志页（v3.0 四态 / 翻页，#434）', () => {
  it('首屏未取数：data-state=loading 且不含数据行', () => {
    const html = render(() => {});
    expect(html).toContain('data-state="loading"');
    expect(html).not.toContain('r-row');
  });

  it('空列表：data-state=empty 且给出空态文案', () => {
    const html = render((client) => seedLogs(client, [], null));
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('还没有操作记录');
  });

  it('有数据：data-state=filled，渲染动作 / 结果', () => {
    const html = render((client) => seedLogs(client, [log()], null));
    expect(html).toContain('data-state="filled"');
    expect(html).toContain('r-row');
    expect(html).toContain('platform.company.create');
    expect(html).toContain('成功');
  });

  it('保留「敏感读」标识（D54②：查询本身会被记录）', () => {
    const html = render((client) => seedLogs(client, [log()], null));
    expect(html).toContain('敏感读');
  });

  it('有 nextCursor 渲染「下一批」，否则不渲染（游标翻页入口）', () => {
    const withNext = render((client) => seedLogs(client, [log()], 'cursor-2'));
    expect(withNext).toContain('下一批');
    const withoutNext = render((client) => seedLogs(client, [log()], null));
    expect(withoutNext).not.toContain('下一批');
  });

  it('无 audit.read 时整块不渲染，显示无权限态', () => {
    const client = createQueryClient();
    client.setQueryData(authKeys.me, {
      employeeId: 'e1',
      tenantId: 't1',
      displayName: '张明',
      companyIds: ['c1'],
      scope: [],
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AuditLogsPage />
      </QueryClientProvider>,
    );
    expect(html).toContain('没有查看权限');
    expect(html).not.toContain('r-row');
  });
});

describe('filterAuditLogs 客户端筛选（纯函数）', () => {
  const logs: AuditLog[] = [
    log({ id: 'a1', actorType: 'employee', actorId: 'e1', objectType: 'company', objectId: 'c1', source: 'web', result: 'success' }),
    log({ id: 'a2', actorType: 'ai', actorId: 'ai1', objectType: 'sales_order', objectId: null, source: 'api', result: 'fail', action: 'sales.ship' }),
  ];

  it('关键字命中操作人 / 动作 / 对象', () => {
    expect(filterAuditLogs(logs, { keyword: 'ai', result: 'all', source: 'all' }).map((l) => l.id)).toEqual(['a2']);
    expect(filterAuditLogs(logs, { keyword: 'ship', result: 'all', source: 'all' }).map((l) => l.id)).toEqual(['a2']);
  });

  it('结果筛选命中 success / fail', () => {
    expect(filterAuditLogs(logs, { keyword: '', result: 'success', source: 'all' }).map((l) => l.id)).toEqual(['a1']);
    expect(filterAuditLogs(logs, { keyword: '', result: 'fail', source: 'all' }).map((l) => l.id)).toEqual(['a2']);
  });

  it('来源筛选命中 web / api', () => {
    expect(filterAuditLogs(logs, { keyword: '', result: 'all', source: 'web' }).map((l) => l.id)).toEqual(['a1']);
    expect(filterAuditLogs(logs, { keyword: '', result: 'all', source: 'api' }).map((l) => l.id)).toEqual(['a2']);
  });

  it('空关键字不过滤', () => {
    expect(filterAuditLogs(logs, { keyword: '', result: 'all', source: 'all' }).map((l) => l.id)).toEqual(['a1', 'a2']);
  });

  it('大小写不敏感', () => {
    expect(filterAuditLogs(logs, { keyword: 'AI', result: 'all', source: 'all' }).map((l) => l.id)).toEqual(['a2']);
  });
});
