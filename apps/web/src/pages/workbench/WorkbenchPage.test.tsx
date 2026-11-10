import type { ScopeMatrix } from '@qingdan/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { workbenchEntries } from '../../lib/access';
import { ROUTE_TABLE } from '../../router/routes';
import {
  ActiveDocsPanel,
  EntryCards,
  TodoPanel,
  WorkbenchView,
  formatToday,
  greetingFor,
} from './WorkbenchPage';
import { buildOverview } from './workbench-mock';

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

function view(scope: ScopeMatrix): string {
  const overview = buildOverview(scope);
  return renderToStaticMarkup(
    <WorkbenchView
      displayName="张明"
      companyCount={1}
      entries={workbenchEntries(scope)}
      todos={overview.todos}
      docs={overview.docs}
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
  it('老板：问候 + 身份摘要 + 待办列表 + 我负责的单据', () => {
    const html = view(OWNER_SCOPE);

    expect(html).toContain('下午好，张明');
    expect(html).toContain('2026年11月9日 周一');
    expect(html).toContain('可访问 1 家公司');
    expect(html).toContain('你的身份可进入');
    expect(html).toContain('待我处理');
    expect(html).toContain('采购单待审核');
    expect(html).toContain('销售单待审核');
    // 我负责的进行中单据（假数据里有销售 / 采购 / 加工 / 内部交易四张）
    expect(html).toContain('E-0001-20261109-0002');
    expect(html).toContain('A-0001-20261109-0003');
    expect(html).toContain('下一步做什么');
  });

  it('销售：没有审批权限 → 待办空状态，且看不到采购 / 加工入口', () => {
    const html = view(SALES_SCOPE);

    expect(html).toContain('当前没有待办');
    expect(html).toContain('当前身份没有待审批事项');
    expect(html).toContain('销售单 E');
    expect(html).not.toContain('采购单 A');
    expect(html).not.toContain('加工单 B');
    expect(html).not.toContain('采购单待审核');
  });

  it('加载中只出骨架，不出数字与假数据', () => {
    const html = renderToStaticMarkup(
      <WorkbenchView
        displayName="张明"
        companyCount={2}
        entries={workbenchEntries(SALES_SCOPE)}
        todos={[]}
        docs={[]}
        loading
        onOpen={() => {}}
        now={new Date(2026, 10, 9, 15, 0, 0)}
      />,
    );

    expect(html).toContain('aria-label="待办加载中"');
    expect(html).toContain('aria-label="单据加载中"');
    expect(html).not.toContain('当前没有待办');
  });
});

describe('入口卡片', () => {
  it('按传入列表渲染，未实现的页面打「待实现」，已实现的没有', () => {
    const html = renderToStaticMarkup(
      <EntryCards
        entries={ROUTE_TABLE.filter((route) => route.id === 'purchase-orders' || route.id === 'flow')}
        onOpen={() => {}}
      />,
    );

    expect(html).toContain('采购单 A');
    expect(html).toContain('业务全流程图');
    expect(html).toContain('href="/purchase-orders"');
    expect(html).toContain('href="/flow"');
    // 只有 flow 未实现，所以「待实现」出现一次
    expect(html.match(/待实现/g)).toHaveLength(1);
  });

  it('一个入口都没有时给明确提示，不渲染空网格', () => {
    const html = renderToStaticMarkup(<EntryCards entries={[]} onOpen={() => {}} />);
    expect(html).toContain('当前身份没有可进入的业务页面');
    expect(html).not.toContain('<ul');
  });
});

describe('待办与进行中单据', () => {
  it('待办空状态与列表互斥', () => {
    const empty = renderToStaticMarkup(<TodoPanel todos={[]} loading={false} emptyHint="说明文案" />);
    expect(empty).toContain('当前没有待办');
    expect(empty).toContain('说明文案');

    const list = renderToStaticMarkup(
      <TodoPanel
        todos={[{ id: 't1', title: '采购单待审核', count: 3, hint: '等你确认', routeId: 'purchase-orders' }]}
        loading={false}
        emptyHint="说明文案"
      />,
    );
    expect(list).toContain('采购单待审核');
    expect(list).toContain('3 笔');
    expect(list).not.toContain('当前没有待办');
  });

  it('进行中单据表含单号 / 类型 / 状态', () => {
    const html = renderToStaticMarkup(
      <ActiveDocsPanel
        docs={[
          {
            id: 'd1',
            orderNo: 'E-0001-20261109-0002',
            kind: '销售单',
            partner: '王记五金',
            summary: '12 件',
            status: '进行中',
            routeId: 'sales-orders',
          },
        ]}
        loading={false}
      />,
    );
    expect(html).toContain('E-0001-20261109-0002');
    expect(html).toContain('销售单');
    expect(html).toContain('王记五金');
    expect(html).toContain('进行中');
  });
});

describe('占位数据按 scope 生成', () => {
  it('待办只出现在持 approve 的域上', () => {
    expect(buildOverview(OWNER_SCOPE).todos.map((todo) => todo.title)).toEqual([
      '采购单待审核',
      '加工单待确认',
      '销售单待审核',
      '结算单待确认',
      '客户退货待审批',
      '供应商退货待审批',
      '盘点盈亏待审批',
    ]);
    expect(buildOverview(SALES_SCOPE).todos).toHaveLength(0);
  });

  it('进行中单据只出现在有 read 的域上', () => {
    const ownerDocs = buildOverview(OWNER_SCOPE).docs.map((doc) => doc.kind);
    expect(ownerDocs).toContain('内部交易单');

    const salesDocs = buildOverview(SALES_SCOPE).docs.map((doc) => doc.kind);
    expect(salesDocs).toEqual(['销售单']);
  });
});
