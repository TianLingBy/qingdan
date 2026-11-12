import type { ProfitReport } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { canAccessPage } from '../../lib/access';
import { isImplementedPage } from '../../router/implemented';
import { authKeys } from '../auth/auth-api';
import { ProfitReportPage, ProfitReportSummary } from './ProfitReportPage';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';

const REPORT: ProfitReport = {
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  grossProfit: '-1200.5',
  fullLossAmount: '200.25',
  netProfit: '-1400.75',
  unattributedLoss: null,
  unattributedLossAvailable: false,
  settledOrderCount: 3,
};

describe('利润报表路由与权限', () => {
  it('页面已登记，持有 profit_report.read 才能进入', () => {
    expect(isImplementedPage('profit-report')).toBe(true);
    expect(
      canAccessPage([{ domain: 'profit_report', actions: ['read'] }], 'profit-report'),
    ).toBe(true);
    expect(canAccessPage([], 'profit-report')).toBe(false);
  });
});

describe('利润报表页', () => {
  it('初始不设置隐式期间，明确要求用户选择起止日期', () => {
    const client = createQueryClient();
    client.setQueryData(authKeys.me, {
      employeeId: 'employee-1',
      tenantId: 't1',
      displayName: '财务',
      companyIds: [COMPANY_ID],
      scope: [{ domain: 'profit_report', actions: ['read', 'view_price'] }],
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProfitReportPage />
      </QueryClientProvider>,
    );

    expect(html).toContain('开始日期');
    expect(html).toContain('结束日期');
    expect(html).toContain('不使用隐式默认期间');
    expect(html).not.toContain('期间：');
  });

  it('有看价权限时展示毛利、全损耗、净毛利与结算单数', () => {
    const html = renderToStaticMarkup(
      <ProfitReportSummary report={REPORT} canViewPrice />,
    );

    expect(html).toContain('-¥1,200.50');
    expect(html).toContain('¥200.25');
    expect(html).toContain('-¥1,400.75');
    expect(html).toContain('3 张');
    expect(html).not.toContain('金额显示占位');
  });

  it('无看价权限时金额全部占位，计数与期间仍可见', () => {
    const html = renderToStaticMarkup(
      <ProfitReportSummary report={REPORT} canViewPrice={false} />,
    );

    expect(html).toContain('2026-11-01 至 2026-11-30');
    expect(html).toContain('3 张');
    expect(html).toContain('当前身份无看价权限');
    expect(html).not.toContain('-¥1,200.50');
    expect(html).not.toContain('¥200.25');
    expect(html).not.toContain('-¥1,400.75');
  });

  it('一期未归属损失不可用，不渲染下钻入口占位', () => {
    const html = renderToStaticMarkup(
      <ProfitReportSummary report={REPORT} canViewPrice />,
    );
    expect(html).not.toContain('未归属损失下钻已开放');
  });
});
