import type { AuditLog, ProfitReport, ScopeMatrix, TodoItem } from '@qingdan/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatToday, greetingFor, lastMonths, moneyText, WorkbenchView } from './WorkbenchPage';

const OWNER_SCOPE: ScopeMatrix = [
  { domain: 'purchase', actions: ['read', 'approve'] },
  { domain: 'processing', actions: ['read', 'approve'] },
  { domain: 'sales', actions: ['read', 'approve'] },
  { domain: 'settlement', actions: ['read', 'approve'] },
  { domain: 'stocktake', actions: ['read', 'approve'] },
  { domain: 'internal_trade', actions: ['read'] },
  { domain: 'workbench', actions: ['read'] },
  { domain: 'audit', actions: ['read'] },
];

/** 种子里的销售岗位：没有 approve、有 view_price、没有 profit_report / audit。 */
const SALES_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'update', 'view_price'] },
  { domain: 'customer', actions: ['read', 'create', 'update'] },
  { domain: 'product', actions: ['read'] },
  { domain: 'inventory_qty', actions: ['read'] },
  { domain: 'workbench', actions: ['read'] },
];

/** 契约 `TodoItemSchema` 的形状：`{ kind, title, count, hint, routeId }`，**没有 id**。 */
const TODO_FIXTURES: readonly TodoItem[] = [
  { kind: 'purchase_pending', title: '采购单待审核', count: 3, hint: '等你确认', routeId: 'purchase-orders' },
  { kind: 'sales_pending', title: '销售单待审核', count: 1, hint: '等你确认', routeId: 'sales-orders' },
];

const PROFIT_FIXTURE: ProfitReport = {
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  grossProfit: '42600.000000',
  fullLossAmount: '0.000000',
  netProfit: '42600.000000',
  unattributedLoss: null,
  unattributedLossAvailable: false,
  settledOrderCount: 5,
};

const AUDIT_FIXTURE = {
  id: 'a1',
  time: '2026-11-24T07:20:00.000Z',
  tenantId: 't1',
  companyId: 'c1',
  actorType: 'employee',
  actorId: 'e1',
  credentialId: null,
  source: 'web',
  action: 'sales.approve',
  objectType: 'sales_order',
  objectId: 'E-2611-081',
  changeSummary: null,
  result: 'success',
  errorCode: null,
  requestId: 'req-1',
  ip: null,
  ua: null,
  reason: null,
  businessTxId: null,
  dryRun: false,
} as unknown as AuditLog;

function view(scope: ScopeMatrix, overrides: Partial<Parameters<typeof WorkbenchView>[0]> = {}): string {
  return renderToStaticMarkup(
    <WorkbenchView
      displayName="张明"
      companyCount={1}
      scope={scope}
      todos={[]}
      todosLoading={false}
      transitCount={2}
      profit={null}
      trends={[]}
      feed={[]}
      onOpen={() => {}}
      now={new Date(2026, 10, 9, 15, 0, 0)}
      {...overrides}
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

  it('近 6 个月按自然月首尾日切区间（报表必填 periodStart/End）', () => {
    const months = lastMonths(new Date(2026, 10, 9));
    expect(months).toHaveLength(6);
    expect(months[0]).toMatchObject({ periodStart: '2026-06-01', periodEnd: '2026-06-30' });
    expect(months[5]).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-30' });
  });

  it('金额不做前端运算：decimal 字符串原样展示', () => {
    expect(moneyText('42600.000000')).toBe('¥42600.000000');
    expect(moneyText('-1200.5')).toBe('−¥1200.5');
    expect(moneyText(null)).toBe('—');
  });
});

describe('工作台版式（v3.0）', () => {
  it('问候 + 日期 + 公司数 + 主业务链路', () => {
    const html = view(OWNER_SCOPE);
    expect(html).toContain('下午好，张明');
    expect(html).toContain('2026年11月9日 周一');
    expect(html).toContain('可访问 1 家公司');
    expect(html).toContain('主业务链路');
    expect(html).toContain('采购单');
    expect(html).toContain('销售单');
  });

  it('待办为空 → data-state="empty" + 暂无待办', () => {
    const html = view(OWNER_SCOPE);
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('暂无待办');
  });

  it('有待办 → data-state="filled"，笔数与「N 类」都在', () => {
    const html = view(OWNER_SCOPE, { todos: TODO_FIXTURES });
    expect(html).toContain('data-state="filled"');
    expect(html).toContain('采购单待审核');
    expect(html).toContain('3 笔');
    expect(html).toContain('共 2 类');
  });

  it('入口卡片区已删除，工作台不再有「我的入口」', () => {
    const html = view(OWNER_SCOPE, { todos: TODO_FIXTURES });
    expect(html).not.toContain('我的入口');
    expect(html).not.toContain('待实现');
  });

  it('页面里没有「占位数据」字样 —— 待办接的是真接口', () => {
    expect(view(OWNER_SCOPE, { todos: TODO_FIXTURES })).not.toContain('占位数据');
  });

  it('没有「我负责的进行中单据」这一块', () => {
    expect(view(OWNER_SCOPE, { todos: TODO_FIXTURES })).not.toContain('我负责的进行中单据');
  });
});

describe('KPI 按权限整块不渲染', () => {
  it('无 profit_report 权限 → 不出现本月毛利 / 已结算卡', () => {
    const html = view(OWNER_SCOPE, { profit: PROFIT_FIXTURE });
    expect(html).not.toContain('本月毛利');
    expect(html).not.toContain('本月已结算');
    expect(html).toContain('待签收');
  });

  it('有 profit_report.read + view_price → 出现本月毛利', () => {
    const scope: ScopeMatrix = [
      ...OWNER_SCOPE,
      { domain: 'profit_report', actions: ['read', 'view_price'] },
    ];
    const html = view(scope, { profit: PROFIT_FIXTURE });
    expect(html).toContain('本月已结算');
    expect(html).toContain('本月毛利');
    expect(html).toContain('¥42600.000000');
  });

  it('无 view_price → 毛利金额为 null，整张卡不渲染（不是显示「—」）', () => {
    const scope: ScopeMatrix = [
      ...OWNER_SCOPE,
      { domain: 'profit_report', actions: ['read'] },
    ];
    const html = view(scope, { profit: { ...PROFIT_FIXTURE, grossProfit: null } });
    expect(html).toContain('本月已结算');
    expect(html).not.toContain('本月毛利');
    expect(html).not.toContain('已脱敏');
  });

  it('无 sales.read → 不出现待签收卡', () => {
    const scope: ScopeMatrix = [
      { domain: 'workbench', actions: ['read'] },
    ];
    const html = view(scope, { transitCount: 2 });
    expect(html).not.toContain('待签收');
    expect(html).toContain('待我处理');
  });

  it('链路卡按域 read 过滤：销售岗看不到采购 / 加工', () => {
    const html = view(SALES_SCOPE);
    expect(html).toContain('销售单');
    expect(html).not.toContain('采购单');
    expect(html).not.toContain('加工单');
  });

  it('无 audit.read → 最近动态整块不渲染', () => {
    const html = view(SALES_SCOPE, { feed: [AUDIT_FIXTURE] });
    expect(html).not.toContain('最近动态');
    expect(html).not.toContain('sales.approve');
  });

  it('有 audit.read → 最近动态出现，取前 5 条', () => {
    const html = view(OWNER_SCOPE, { feed: [AUDIT_FIXTURE] });
    expect(html).toContain('最近动态');
    expect(html).toContain('sales.approve');
  });

  it('无 profit_report.read → 趋势块不渲染', () => {
    const html = view(SALES_SCOPE, { trends: [{ label: '11 月', grossProfit: '1.000000' }] });
    expect(html).not.toContain('近 6 个月毛利');
  });

  it('有 profit_report.read → 趋势块按月列出', () => {
    const scope: ScopeMatrix = [
      ...OWNER_SCOPE,
      { domain: 'profit_report', actions: ['read', 'view_price'] },
    ];
    const html = view(scope, {
      trends: [
        { label: '10 月', grossProfit: null },
        { label: '11 月', grossProfit: '42600.000000' },
      ],
    });
    expect(html).toContain('近 6 个月毛利');
    expect(html).toContain('10 月');
    expect(html).toContain('¥42600.000000');
    // 无数据的月份显示占位符而不是 0
    expect(html).toContain('—');
  });
});
