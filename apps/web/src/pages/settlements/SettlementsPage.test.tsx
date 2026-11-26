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
    // 列表用紧凑写法：单号自带 E / N 前缀，不再重复「销售单 E ·」（详情面板才用完整写法）
    expect(html).toContain('E · 01a1bf69');
    expect(html).not.toContain('销售单 E · 01a1bf69');
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

  /** 四态（#337 v0.13）：三个状态行常驻，靠 `data-state` 让 CSS 决定谁显示。 */
  it('有数据时容器与 tbody 都是 filled，三个状态行仍常驻（交给 CSS 显隐）', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [ORDER] }));

    expect(html).toContain('data-state="filled"');
    expect(html).toContain('st-tr st-loading');
    expect(html).toContain('st-tr st-error');
    expect(html).toContain('st-tr st-empty');
    // 数据行只带 r-row：带上 st-tr 会被 `tbody > tr.st-tr{display:none}` 整行吃掉（只有表头可见）
    expect(html).toContain('class="r-row"');
    expect(html).not.toContain('st-tr r-row');
  });

  it('空列表时 data-state 切到 empty，状态行 colSpan 等于表头列数（10 列不塌）', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [] }));

    expect(html).toContain('data-state="empty"');
    expect(html).toContain('colSpan="10"');
  });

  it('列表有「日期」列：财务要看这张凭证哪天生成的（短格式，年份在详情）', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [ORDER] }));

    expect(html).toContain('>日期<');
    expect(html).toContain('11-08 10:00');
    expect(html).not.toContain('2026-11-08 10:00');
  });

  it('状态徽标走 v0.13 语义档：待确认=bad、已结算=ok，不再是各页自拼的 Tailwind 底色', () => {
    const pending = renderPage(seedClient({ me: FULL, orders: [ORDER] }));
    const settled = renderPage(
      seedClient({ me: FULL, orders: [{ ...ORDER, status: '已结算' }] }),
    );

    expect(pending).toContain('st bad');
    expect(settled).toContain('st ok');
  });

  it('游标分页只给「上一批 / 下一批」，不画页码（C 单 ListQuery 没有 page/sort）', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [ORDER] }));

    expect(html).not.toContain('下一批');
    expect(html).not.toContain('data-sort');
  });

  it('列表卡是 v3.0 的 card list-card + .tw/.tf，页脚写「共 N 条」', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [ORDER] }));

    expect(html).toContain('class="card list-card"');
    // `.tight`：C 单 10 列，常规内边距会把「操作」列顶出卡片（实测 1119 > 1135−padding）
    expect(html).toContain('class="tw tight"');
    expect(html).toContain('class="tf"');
    expect(html).toContain('共 1 条');
  });

  /**
   * 撤销结算（D88）的按钮在详情面板里，而详情面板只在 `detailId` 非空时渲染——
   * `renderToStaticMarkup` 的首屏里没有它，**这里测不到**。
   *
   * 所以本文件只留一条「文案别说反」的断言（结算后可撤销、但不能冲正），
   * 请求形状（`confirm: true` + `reason` + 强 `If-Match`）由
   * `settlements-api.test.ts` 的 `撤销结算（D88 / #288）` 覆盖。
   */
  it('底部说明写「可撤销但不能冲正」，不再说「不可取消」（D88 之后那半句过期了）', () => {
    const html = renderPage(seedClient({ me: FULL, orders: [ORDER] }));

    expect(html).toContain('可撤销');
    expect(html).toContain('不能冲正');
    expect(html).not.toContain('不可冲正、不可取消');
  });
});
