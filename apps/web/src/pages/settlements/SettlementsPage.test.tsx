import type { SettlementOrder } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { MASKED_AMOUNT } from '../../lib/decimal';
import { authKeys } from '../auth/auth-api';
import { SettlementsPage } from './SettlementsPage';
import { settlementQueryKeys } from './settlements-api';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const SOURCE_ID = '01a1bf69-545e-7265-b209-ff4f133e169e';

const ORDER: SettlementOrder = {
  id: 'c1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  orderNo: 'C-0001-20261108-0001',
  sourceDocType: 'E',
  sourceDocId: SOURCE_ID,
  status: '待确认',
  totalSaleAmount: '200',
  totalCostAmount: '100',
  grossProfit: '100',
  grossMarginRate: '0.5',
  relatedLossAmount: '0',
  netProfit: '100',
  commissionRateSnapshot: '0.05',
  commissionAmount: '10',
  commissionOwnerId: '01900000-0000-7000-8000-000000000021',
  version: 1,
  createdAt: '2026-11-08T02:00:00.000Z',
  updatedAt: '2026-11-08T02:00:00.000Z',
};

interface TestMe {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly companyIds: readonly string[];
  readonly scope: readonly (
    | {
        readonly domain: 'settlement';
        readonly actions: readonly ('read' | 'approve' | 'view_price')[];
      }
    | {
        readonly domain: 'commission';
        readonly actions: readonly ('read' | 'create' | 'delete')[];
      }
  )[];
}

const FULL: TestMe = {
  employeeId: 'e1',
  tenantId: 't1',
  displayName: '张明',
  companyIds: [COMPANY_ID],
  scope: [{ domain: 'settlement', actions: ['read', 'approve', 'view_price'] }],
};

function meWith(actions: readonly ('read' | 'approve' | 'view_price')[]): TestMe {
  return { ...FULL, scope: [{ domain: 'settlement', actions }] };
}

/** 提成域是独立 scope（commission.read/create/delete）；这里用来验入口显隐。 */
function meWithCommission(
  actions: readonly ('read' | 'create' | 'delete')[],
): TestMe {
  return {
    ...FULL,
    scope: [
      { domain: 'settlement', actions: ['read', 'approve', 'view_price'] },
      { domain: 'commission', actions },
    ],
  };
}

function seedClient(input: {
  readonly me: TestMe;
  readonly orders: readonly SettlementOrder[];
}): ReturnType<typeof createQueryClient> {
  const client = createQueryClient();
  client.setQueryData(authKeys.me, input.me);
  client.setQueryData(
    settlementQueryKeys.list({
      status: undefined,
      sourceDocType: undefined,
      keyword: undefined,
      cursor: null,
    }),
    { items: [...input.orders], nextCursor: null },
  );
  return client;
}

function renderPage(client: ReturnType<typeof createQueryClient>): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SettlementsPage />
    </QueryClientProvider>,
  );
}

describe('结算单 C 页面', () => {
  it('列表渲染单号、来源单、毛利、毛利率、净毛利、提成与状态', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [ORDER] }));

    expect(html).toContain('结算单 C');
    expect(html).toContain('C-0001-20261108-0001');
    expect(html).toContain('销售单 E · 01a1bf69');
    expect(html).toContain('¥200.00');
    expect(html).toContain('¥100.00');
    // 毛利率是比例 0.5 → 50.00%，不是 0.50%
    expect(html).toContain('50.00%');
    expect(html).toContain('待确认');
  });

  it('页面上没有「新建」按钮：C 单草稿由 E / N 完成时自动生成（D19 / D29）', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [ORDER] }));

    expect(html).not.toContain('新建结算单');
    expect(html).toContain('没有「新建」按钮');
    expect(html).toContain('自动生成');
  });

  it('无看价权限时金额与提成全部遮罩，且页面不出现已格式化金额（D78）', () => {
    const html = renderPage(seedClient({ me: meWith(['read']), orders: [ORDER] }));

    expect(html).toContain(MASKED_AMOUNT);
    expect(html).toContain('当前身份无「看价」权限');
    expect(html).not.toContain('¥');
    // 毛利率也不该露出 50.00%
    expect(html).not.toContain('50.00%');
  });

  it('无 approve 权限时说清确认结算要哪个 scope', () => {
    const html = renderPage(seedClient({ me: meWith(['read', 'view_price']), orders: [ORDER] }));

    expect(html).toContain('需要 settlement.approve');
    expect(html).toContain('disabled');
  });

  it('空列表说明「别手工开单」的下一步，而不是只给一句暂无', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [] }));

    expect(html).toContain('暂无结算单');
    expect(html).toContain('自动生成草稿');
  });

  it('写明结算后不可冲正、错账走 R 退货（D2③）', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [ORDER] }));

    expect(html).toContain('不可冲正');
    expect(html).toContain('D2③');
  });

  it('只持 settlement 权限时看不到提成比例配置入口（域不同，别拿结算权限冒充提成权限）', () => {
    const html = renderPage(seedClient({ me: meWith(['read', 'approve', 'view_price']), orders: [ORDER] }));

    expect(html).not.toContain('提成比例配置');
  });

  it('持 commission.read 时出现提成比例配置入口（入口默认收起，不抢结算单的位置）', () => {
    const html = renderPage(
      seedClient({ me: meWithCommission(['read']), orders: [ORDER] }),
    );

    expect(html).toContain('提成比例配置');
    // 收起态不该把面板内容渲染出来
    expect(html).not.toContain('一期只按人');
  });
});
