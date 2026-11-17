import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { authKeys } from '../auth/auth-api';
import { DOMAIN_WORDS } from '../employees/domain-words';
import { PermissionsPage, PositionEditor } from './PermissionsPage';

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

/**
 * #255：矩阵格子按「契约里有没有该 (domain, action) 端点」标注。
 * 静态渲染打不开弹窗，这里直接渲染编辑器的矩阵本体。
 */
function renderEditor(): string {
  return renderToStaticMarkup(
    <PositionEditor
      editor={{ position: null, name: '新岗位', selection: {}, version: 0 }}
      saving={false}
      readOnly={false}
      onChange={() => {}}
      onSave={() => {}}
      onClose={() => {}}
    />,
  );
}

function cellTag(html: string, domain: string, action: string): string {
  const match = html.match(
    new RegExp(
      `<button(?=[^>]*data-domain="${domain}")(?=[^>]*data-action="${action}")[^>]*>`,
    ),
  );
  if (match === null) throw new Error(`${domain}.${action} 的格子应存在`);
  return match[0]!;
}

describe('权限矩阵的端点支撑标注（#255）', () => {
  it('有端点支撑的动作格显示正常态', () => {
    const html = renderEditor();
    const tag = cellTag(html, 'purchase', 'update');

    expect(tag).toContain('data-support="has-endpoint"');
    expect(tag).not.toContain('border-dashed');
    expect(html).toContain('A 采购单·编：后端已有该动作端点，勾选后立即生效。');
  });

  it('无端点支撑的动作格显示预授权态，但仍可勾选', () => {
    const html = renderEditor();
    const tag = cellTag(html, 'sales', 'approve');

    expect(tag).toContain('data-support="preauth-only"');
    expect(tag).toContain('border-dashed');
    expect(tag).not.toContain('disabled');
    expect(html).toContain('E 销售单·审：后端暂无该动作端点，勾选只是预授权，等功能上线才生效。');
  });

  it('7 个模板动作全部渲染，且不含看价', () => {
    const html = renderEditor();
    const cells =
      html.match(/data-action="(?:read|create|update|approve|ship|delete|export)"/g) ?? [];

    expect(cells).toHaveLength(DOMAIN_WORDS.length * 7);
    expect(html).not.toContain('data-action="view_price"');
    for (const label of ['查', '建', '编', '审', '出', '删', '导']) {
      expect(html).toContain(`>${label}</th>`);
    }
  });

  it('矩阵上方写明「勾了只是预授权」', () => {
    const html = renderEditor();

    expect(html).toContain('部分动作当前没有端点支撑，勾了只是预授权，等功能上线才生效');
  });
});
