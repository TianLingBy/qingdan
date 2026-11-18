import type { ScopeMatrix, TodoItem } from '@qingdan/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { workbenchEntries } from '../../lib/access';
import { isImplementedPage } from '../../router/implemented';
import { ROUTE_TABLE } from '../../router/routes';
import { EntryCards, TodoPanel, WorkbenchView, formatToday, greetingFor } from './WorkbenchPage';

const OWNER_SCOPE: ScopeMatrix = [
  { domain: 'purchase', actions: ['read', 'approve'] },
  { domain: 'processing', actions: ['read', 'approve'] },
  { domain: 'sales', actions: ['read', 'approve'] },
  { domain: 'settlement', actions: ['read', 'approve'] },
  { domain: 'customer_return', actions: ['read', 'approve'] },
  { domain: 'supplier_return', actions: ['read', 'approve'] },
  { domain: 'stocktake', actions: ['read', 'approve'] },
  { domain: 'internal_trade', actions: ['read'] },
];

/** 种子里的销售岗位：没有任何 approve，所以待办一定是空态。 */
const SALES_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'update', 'view_price'] },
  { domain: 'customer', actions: ['read', 'create', 'update'] },
  { domain: 'product', actions: ['read'] },
  { domain: 'inventory_qty', actions: ['read'] },
  { domain: 'settlement', actions: ['read'] },
];

/** 契约 `TodoItemSchema` 的形状：`{ kind, title, count, hint, routeId }`，**没有 id**。 */
const TODO_FIXTURES: readonly TodoItem[] = [
  { kind: 'purchase_pending', title: '采购单待审核', count: 3, hint: '等你确认', routeId: 'purchase-orders' },
  { kind: 'sales_pending', title: '销售单待审核', count: 1, hint: '等你确认', routeId: 'sales-orders' },
];

function view(scope: ScopeMatrix, todos: readonly TodoItem[] = []): string {
  return renderToStaticMarkup(
    <WorkbenchView
      displayName="张明"
      companyCount={1}
      entries={workbenchEntries(scope)}
      todos={todos}
      loading={false}
      onOpen={() => {}}
      now={new Date(2026, 10, 9, 15, 0, 0)}
    />,
  );
}

describe('问候与日期', () => {
  it('按时段给问候语', () => {
    const at = (hour: number) => greetingFor(new Date(2026, 10, 9, hour, 0, 0));
    expect(at(5)).toBe('夜深了');
    expect(at(8)).toBe('早上好');
    expect(at(10)).toBe('上午好');
    expect(at(13)).toBe('中午好');
    expect(at(15)).toBe('下午好');
    expect(at(20)).toBe('晚上好');
  });

  it('日期带星期，且不依赖系统语言包', () => {
    expect(formatToday(new Date(2026, 10, 9, 15, 0, 0))).toBe('2026年11月9日 周一');
  });
});

describe('工作台版式', () => {
  it('有待办：问候 + 身份摘要 + 待办列表 + 下一步', () => {
    const html = view(OWNER_SCOPE, TODO_FIXTURES);

    expect(html).toContain('下午好，张明');
    expect(html).toContain('2026年11月9日 周一');
    expect(html).toContain('可访问 1 家公司');
    expect(html).toContain('你的身份可进入');
    expect(html).toContain('待我处理');
    expect(html).toContain('采购单待审核');
    expect(html).toContain('销售单待审核');
    expect(html).toContain('下一步做什么');
  });

  it('待办笔数是各条 count 之和，不是条数', () => {
    // 3 + 1 = 4 笔、2 类。这两个数字混起来最容易让人误读「我今天有 2 件事」。
    const html = view(OWNER_SCOPE, TODO_FIXTURES);
    expect(html).toContain('4');
    expect(html).toContain('共 2 类');
  });

  it('没有待办 → 空状态，且看不到采购 / 加工入口', () => {
    const html = view(SALES_SCOPE);

    expect(html).toContain('当前没有待办');
    expect(html).toContain('当前身份没有待审批事项');
    expect(html).toContain('销售单 E');
    expect(html).not.toContain('采购单 A');
    expect(html).not.toContain('加工单 B');
    expect(html).not.toContain('采购单待审核');
  });

  it('加载中只出骨架，不出数字', () => {
    const html = renderToStaticMarkup(
      <WorkbenchView
        displayName="张明"
        companyCount={2}
        entries={workbenchEntries(SALES_SCOPE)}
        todos={[]}
        loading
        onOpen={() => {}}
        now={new Date(2026, 10, 9, 15, 0, 0)}
      />,
    );

    expect(html).toContain('aria-label="待办加载中"');
    expect(html).not.toContain('当前没有待办');
  });

  it('页面里没有「占位数据」字样 —— 待办接的是真接口', () => {
    // 这一条是回归锁：曾经整个页面标着「占位数据」、数据来自 workbench-mock.ts。
    // 换成 GET /api/v1/todos 之后再加回去就说明有人又塞了假数据。
    expect(view(OWNER_SCOPE, TODO_FIXTURES)).not.toContain('占位数据');
  });

  it('没有「我负责的进行中单据」这一块', () => {
    // 撤掉的理由在 WorkbenchPage.tsx 的注释里：需要 handlerId=me 过滤，后端还不支持（#354 第 3 条）。
    // 这条断言防止有人「顺手加回来」时又用假数据。
    expect(view(OWNER_SCOPE, TODO_FIXTURES)).not.toContain('我负责的进行中单据');
  });
});

describe('入口卡片', () => {
  it('按传入列表渲染，未实现的页面打「待实现」，已实现的没有', () => {
    // 从真源推导「已实现 / 未实现」各一个，避免每落地一页就要回来改这个用例。
    const done = ROUTE_TABLE.find((route) => isImplementedPage(route.id) && route.id !== 'workbench');
    const pending = ROUTE_TABLE.find((route) => !isImplementedPage(route.id));
    expect(done).toBeDefined();
    expect(pending).toBeDefined();

    const html = renderToStaticMarkup(
      <EntryCards entries={[done!, pending!]} onOpen={() => {}} />,
    );

    expect(html).toContain(`href="${done!.path}"`);
    expect(html).toContain(`href="${pending!.path}"`);
    // 只有未实现的那一个打标
    expect(html.match(/待实现/g)).toHaveLength(1);
  });

  it('一个入口都没有时给明确提示，不渲染空网格', () => {
    const html = renderToStaticMarkup(<EntryCards entries={[]} onOpen={() => {}} />);
    expect(html).toContain('当前身份没有可进入的业务页面');
    expect(html).not.toContain('<ul');
  });
});

describe('待办面板', () => {
  it('空状态与列表互斥', () => {
    const empty = renderToStaticMarkup(<TodoPanel todos={[]} loading={false} emptyHint="说明文案" />);
    expect(empty).toContain('当前没有待办');
    expect(empty).toContain('说明文案');

    const list = renderToStaticMarkup(
      <TodoPanel todos={TODO_FIXTURES} loading={false} emptyHint="说明文案" />,
    );
    expect(list).toContain('采购单待审核');
    expect(list).toContain('3 笔');
    expect(list).not.toContain('当前没有待办');
  });

  it('说明文案讲清「没看到不等于没有」', () => {
    // 后端按权限逐条过滤：没权限的类别直接不返回。用户看到空列表时最可能的误读是
    // 「公司真没活」，而实际可能是「这些活不归你」。
    const html = renderToStaticMarkup(<TodoPanel todos={[]} loading={false} emptyHint="x" />);
    expect(html).toContain('不归你');
  });
});
