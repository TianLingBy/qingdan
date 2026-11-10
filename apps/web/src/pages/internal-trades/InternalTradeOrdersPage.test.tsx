import type { InternalTradeOrder, Product } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { authKeys } from '../auth/auth-api';
import { InternalTradeOrdersPage } from './InternalTradeOrdersPage';
import { internalTradeQueryKeys } from './internal-trades-api';

const FROM = '00000000-0000-4000-8000-000000000001';
const TO = '00000000-0000-4000-8000-000000000002';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000101';
const BATCH_ID = '00000000-0000-4000-8000-000000000401';

const PRODUCT: Product = {
  id: PRODUCT_ID,
  tenantId: 't1',
  companyId: FROM,
  productNo: 'P-1001',
  name: '不锈钢合页 4寸',
  aliases: [],
  specification: '50/箱',
  unit: '箱',
  status: '启用',
  defaultSalePrice: '15.5',
  version: 1,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
};

const ORDER: InternalTradeOrder = {
  id: 'n1',
  tenantId: 't1',
  fromCompanyId: FROM,
  fromCompanyName: '演示公司',
  toCompanyId: TO,
  toCompanyName: '二公司',
  orderNo: 'N-0001-20261108-0001',
  status: '在途',
  handlerId: '01900000-0000-7000-8000-000000000021',
  lines: [
    {
      productId: PRODUCT_ID,
      batchIds: [BATCH_ID],
      qty: '10',
      unitPrice: '12.5',
      amount: '125',
    },
  ],
  internalPrice: '125',
  inTransitQty: '10',
  version: 2,
  createdAt: '2026-11-08T02:00:00.000Z',
  updatedAt: '2026-11-08T03:00:00.000Z',
};

interface TestMe {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly companyIds: readonly string[];
  readonly scope: readonly {
    readonly domain: 'internal_trade';
    readonly actions: readonly ('read' | 'create' | 'update' | 'delete')[];
  }[];
}

const OWNER: TestMe = {
  employeeId: 'e1',
  tenantId: 't1',
  displayName: '张明',
  companyIds: [FROM, TO],
  scope: [{ domain: 'internal_trade', actions: ['read', 'create', 'update', 'delete'] }],
};

/** 造不同权限的身份，避免把 `readonly ['read']` 这种字面量元组塞进上面的窄类型。 */
function meWith(actions: readonly ('read' | 'create' | 'update' | 'delete')[]): TestMe {
  return { ...OWNER, scope: [{ domain: 'internal_trade', actions }] };
}

function seedClient(input: {
  readonly me: TestMe;
  readonly orders: readonly InternalTradeOrder[];
}): ReturnType<typeof createQueryClient> {
  const client = createQueryClient();
  client.setQueryData(authKeys.me, input.me);
  client.setQueryData(internalTradeQueryKeys.companies, {
    items: [
      { id: FROM, name: '演示公司', code: '0001' },
      { id: TO, name: '二公司', code: '0002' },
    ],
    nextCursor: null,
  });
  client.setQueryData(internalTradeQueryKeys.products, { items: [PRODUCT], nextCursor: null });
  client.setQueryData(internalTradeQueryKeys.batches(''), { items: [], nextCursor: null });
  client.setQueryData(
    internalTradeQueryKeys.list({
      fromCompanyId: undefined,
      toCompanyId: undefined,
      status: undefined,
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
      <InternalTradeOrdersPage />
    </QueryClientProvider>,
  );
}

describe('内部交易单 N 页面', () => {
  it('列表渲染单号、方向、内部价、在途量与四态状态', () => {
    const html = renderPage(seedClient({ me: OWNER, orders: [ORDER] }));

    expect(html).toContain('内部交易单 N');
    expect(html).toContain('N-0001-20261108-0001');
    expect(html).toContain('演示公司 → 二公司');
    expect(html).toContain('¥125.00');
    expect(html).toContain('在途');
    expect(html).toContain('新建内部交易单');
  });

  it('不画「发货 / 到货确认」按钮，而是写清为什么没有（D31 / D68③）', () => {
    const html = renderPage(seedClient({ me: OWNER, orders: [ORDER] }));

    // 说明文字里会提到「到货确认」，所以按按钮文案判，而不是全文搜关键词
    expect(html).not.toContain('>发货<');
    expect(html).not.toContain('>到货确认<');
    expect(html).toContain('本批没有发货与到货确认端点');
    expect(html).toContain('D68③');
  });

  it('「在途」单的编辑与取消都禁用：只有进行中能改（D68②）', () => {
    const html = renderPage(seedClient({ me: OWNER, orders: [ORDER] }));

    expect(html).toContain('disabled');
    // 状态筛选里必须有「在途」——有它才说明用的是四态而不是三态
    expect(html).toContain('在途');
  });

  it('无 create 权限时说清缺哪个 scope，空列表给下一步', () => {
    const html = renderPage(
      seedClient({
        me: meWith(['read']),
        orders: [],
      }),
    );

    expect(html).toContain('需要 internal_trade.create');
    expect(html).toContain('暂无内部交易单');
  });

  it('页面写明内部价是手填的，系统不自动算（D68①）', () => {
    const html = renderPage(seedClient({ me: OWNER, orders: [ORDER] }));

    expect(html).toContain('内部价手工填');
    expect(html).toContain('D68①');
  });

  it('状态筛选严格按四态给选项，不混入单据三态的「已完成 / 已取消」以外的值', () => {
    const html = renderPage(seedClient({ me: OWNER, orders: [ORDER] }));

    for (const state of ['进行中', '在途', '已完成', '已取消']) {
      expect(html).toContain(`>${state}<`);
    }
    // N 单没有「已结算」这种单据框架里不存在的状态
    expect(html).not.toContain('已结算<');
  });
});
