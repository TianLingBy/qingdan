import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { authKeys } from '../auth/auth-api';
import { PermissionsPage } from './PermissionsPage';

/**
 * #263：权限设置页写入口三态。
 * 只验「新建岗位」按 permission.create 显隐（验收第 4 条），
 * 编辑模板（permission.update）与停用（permission.delete）同款逻辑。
 */

interface TestMe {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly companyIds: readonly string[];
  readonly scope: readonly { domain: 'permission'; actions: readonly string[] }[];
}

function seedClient(permissionActions: readonly string[]): ReturnType<typeof createQueryClient> {
  const client = createQueryClient();
  client.setQueryData(authKeys.me, {
    employeeId: 'e1',
    tenantId: 't1',
    displayName: '张明',
    companyIds: ['c1'],
    scope: [{ domain: 'permission', actions: permissionActions }],
  } satisfies TestMe);
  client.setQueryData(['admin', 'positions'], { items: [], nextCursor: null });
  return client;
}

function renderPage(permissionActions: readonly string[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={seedClient(permissionActions)}>
      <PermissionsPage />
    </QueryClientProvider>,
  );
}

describe('权限设置页写入口三态（#263）', () => {
  it('无 permission.create 时「新建岗位」禁用且文案含 permission.create', () => {
    const html = renderPage(['read']);

    expect(html).toContain('新建岗位');
    expect(html).toContain('permission.create');
    expect(html).toContain('disabled');
  });

  it('有 permission.create 时不出现「新建岗位需要 permission.create」提示', () => {
    const html = renderPage(['read', 'create']);

    expect(html).toContain('新建岗位');
    expect(html).not.toContain('新建岗位需要 permission.create');
  });
});
