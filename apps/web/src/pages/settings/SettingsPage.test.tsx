import type { SettingsOverview } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createQueryClient } from '../../api/query';
import { SettingsErrorBlock, SettingsPage } from './SettingsPage';

/**
 * 设置中心渲染测试（#343）。
 *
 * 模式与 `CompaniesPage.test.tsx` 同：SSR 静态渲染 + 预置 query 缓存。
 * 为什么不用 MSW 打桩：SSR 渲染不会等异步请求，起 MSW 只是把「永远 loading」
 * 包装得更像测试；预置缓存能直接测到四态里的三态，第四态（loading）就是不预置。
 *
 * 这里**不测按钮点击**：五个区块全部只读，唯一的按钮是「换号」且 `disabled`。
 * 要测的是「口径对不对」——403 不能被渲染成「没有公司」、`next: null` 不能
 * 被渲染成空白、手机号不能以完整形态出现。
 */

const OVERVIEW: SettingsOverview = {
  tenant: { id: 't1', name: '演示租户', status: '启用' },
  companies: [
    {
      id: 'c1',
      tenantId: 't1',
      code: '0002',
      name: '华南分公司',
      version: 1,
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
    },
    {
      id: 'c2',
      tenantId: 't1',
      code: '0003',
      name: '华东分公司',
      version: 1,
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
    },
  ],
  numbering: [
    { type: 'E', rule: '{公司码}-XS-{日期}-{流水}', next: '0002-XS-20261118-0042' },
    { type: 'A', rule: '{公司码}-CG-{日期}-{流水}', next: null },
    { type: 'B', rule: '{公司码}-JG-{日期}-{流水}', next: '0002-JG-20261118-0007' },
  ],
  me: {
    name: '张老板',
    phoneMasked: '138****1234',
    companies: [
      {
        id: 'c1',
        tenantId: 't1',
        code: '0002',
        name: '华南分公司',
        version: 1,
        createdAt: '2026-11-09T00:00:00.000Z',
        updatedAt: '2026-11-09T00:00:00.000Z',
      },
    ],
    positions: [{ id: 'p1', name: '老板', companyId: 'c1', companyName: '华南分公司' }],
  },
  permissions: [
    { domain: 'sales', action: 'read' },
    { domain: 'sales', action: 'create' },
    { domain: 'sales', action: 'ship' },
    { domain: 'purchase', action: 'read' },
    { domain: 'inventory_qty', action: 'read' },
  ],
};

function render(seed: (client: ReturnType<typeof createQueryClient>) => void) {
  const client = createQueryClient();
  seed(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe('设置中心（#343）', () => {
  it('403 说「没有权限」，不说「没有公司」', () => {
    // 直接渲染错误块：SSR 渲染整页时 query 会在渲染期触发 fetch，预置的 error 会被打回 pending
    const html = renderToStaticMarkup(
      <SettingsErrorBlock
        error={new ApiError({ code: 'FORBIDDEN', message: '无权限', status: 403 })}
      />,
    );
    // 必须出现权限提示
    expect(html).toContain('没有查看公司资料的权限');
    expect(html).toContain('company.read');
    // 且绝不能把 403 伪装成「你没有公司」——那会让人以为数据丢了
    expect(html).not.toContain('还没有加入');
    expect(html).not.toContain('暂无公司');
  });

  it('非 403 的错误给重试，不冒充权限问题', () => {
    const html = renderToStaticMarkup(
      <SettingsErrorBlock
        error={new ApiError({ code: 'INTERNAL', message: '服务器打盹了', status: 500 })}
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain('设置中心加载失败');
    expect(html).toContain('服务器打盹了');
    expect(html).toContain('重试');
    // 500 不该说成权限问题，否则用户会去找管理员要一个他本来就有的权限
    expect(html).not.toContain('没有查看公司资料的权限');
  });

  it('next 为 null 的行说「本月已用满」，并给跨月说明', () => {
    const html = render((client) =>
      client.setQueryData(['settings', 'overview'], OVERVIEW),
    );
    expect(html).toContain('本月已用满');
    expect(html).toContain('单号当月上限 9999');
    // 后面两个号正常显示，不能因为一行用满就把整表标红
    expect(html).toContain('0002-XS-20261118-0042');
    expect(html).toContain('0002-JG-20261118-0007');
  });

  it('权限按 domain 分组，动作显示中文名', () => {
    const html = render((client) =>
      client.setQueryData(['settings', 'overview'], OVERVIEW),
    );
    // 三个 domain 各一行；sales 有三个动作
    expect(html).toContain('销售');
    expect(html).toContain('采购');
    expect(html).toContain('库存数量');
    // 「查 / 建 / 出」来自 ACTIONS，不许在页面里自己写死一份中文
    expect(html).toContain('出');
    expect(html).toContain('这里只显示你当前生效的权限');
  });

  it('手机号只以脱敏形态出现', () => {
    const html = render((client) =>
      client.setQueryData(['settings', 'overview'], OVERVIEW),
    );
    expect(html).toContain('138****1234');
    // 完整 11 位号码一个都不能出现
    expect(html).not.toMatch(/1[3-9]\d{9}/);
  });

  it('loading 时渲染骨架而不是空白', () => {
    // 不预置数据 → isPending 为 true
    const html = render(() => undefined);
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('st-block st-loading');
    // 骨架是五条灰块，不是转圈
    expect((html.match(/animate-pulse/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('有数据时挂 filled，并把「换号」按钮置灰（后端还没有端点）', () => {
    const html = render((client) =>
      client.setQueryData(['settings', 'overview'], OVERVIEW),
    );
    expect(html).toContain('data-state="filled"');
    expect(html).toContain('张老板');
    expect(html).toContain('华南分公司');
    expect(html).toContain('老板');
    // 「换号」画了但必须是 disabled + 说明原因，不能是个能点却什么都不做的按钮
    expect(html).toContain('换号');
    expect(html).toContain('后端还没有换号端点');
    expect(html).toContain('disabled');
  });
});
