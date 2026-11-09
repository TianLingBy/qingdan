import type { Product, SalesOrder } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { MASKED_AMOUNT } from '../../lib/decimal';
import { authKeys } from '../auth/auth-api';
import { SalesOrdersPage } from './SalesOrdersPage';
import { salesQueryKeys } from './sales-api';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000201';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000101';
const BATCH_ID = '00000000-0000-4000-8000-000000000401';

const PRODUCT: Product = {
  id: PRODUCT_ID,
  tenantId: 't1',
  companyId: COMPANY_ID,
  productNo: 'P-1001',
  name: '不锈钢合页 4寸',
  aliases: [],
  specification: '50/箱',
  unit: '箱',
  status: '启用',
  defaultSalePrice: '12.5',
  version: 1,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
};

const ORDER: SalesOrder = {
  id: 'o1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  orderNo: 'E-0001-20261108-0001',
  customerId: CUSTOMER_ID,
  customerName: '王记五金',
  status: '进行中',
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
  fees: [{ feeName: '运费', qty: '1', unitPrice: '100', amount: '100', remark: null }],
  totalAmount: '225',
  version: 2,
  createdAt: '2026-11-08T02:00:00.000Z',
  updatedAt: '2026-11-08T03:00:00.000Z',
};

const ME_WITH_PRICE = {
  employeeId: 'e1',
  tenantId: 't1',
  displayName: '张明',
  companyIds: [COMPANY_ID],
  scope: [
    { domain: 'sales', actions: ['read', 'create', 'update', 'delete', 'export', 'view_price'] },
  ],
};

function seedClient(input: {
  readonly me: typeof ME_WITH_PRICE;
  readonly orders: readonly SalesOrder[];
}): ReturnType<typeof createQueryClient> {
  const client = createQueryClient();
  client.setQueryData(authKeys.me, input.me);
  client.setQueryData(salesQueryKeys.products, { items: [PRODUCT], nextCursor: null });
  client.setQueryData(salesQueryKeys.customers('', ''), { items: [], nextCursor: null });
  client.setQueryData(
    salesQueryKeys.list({
      companyId: undefined,
      customerId: undefined,
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
      <SalesOrdersPage />
    </QueryClientProvider>,
  );
}

describe('销售单 E 页面', () => {
  it('列表渲染单号、客户、数量、成交额、状态与开单时间', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('销售单 E');
    expect(html).toContain('E-0001-20261108-0001');
    expect(html).toContain('王记五金');
    expect(html).toContain('¥225.00');
    expect(html).toContain('进行中');
    expect(html).toContain('新建销售单');
    // 数量合计来自明细行，不是单头字段
    expect(html).toContain('>10<');
  });

  it('无看价权限时成交额遮罩，页面不出现任何已格式化金额（D79）', () => {
    const html = renderPage(
      seedClient({
        me: { ...ME_WITH_PRICE, scope: [{ domain: 'sales', actions: ['read'] }] },
        orders: [ORDER],
      }),
    );

    expect(html).toContain(MASKED_AMOUNT);
    expect(html).toContain('当前身份无「看价」权限');
    expect(html).not.toContain('¥');
  });

  it('无 create 权限时直说缺哪个 scope，空列表给出下一步', () => {
    const html = renderPage(
      seedClient({
        me: { ...ME_WITH_PRICE, scope: [{ domain: 'sales', actions: ['read'] }] },
        orders: [],
      }),
    );

    expect(html).toContain('需要 sales.create');
    expect(html).toContain('暂无销售单');
  });

  it('页面写清「完成 = 扣库存 + 生成 C 草稿」，不把完成说成已结算（D19 / D72）', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('扣批次可用量');
    expect(html).toContain('结算单 C 草稿');
    expect(html).toContain('不等于已结算');
  });

  it('列表行给出完成 / 取消入口，但无 update 权限时完成按钮禁用', () => {
    const html = renderPage(
      seedClient({
        me: { ...ME_WITH_PRICE, scope: [{ domain: 'sales', actions: ['read', 'view_price'] }] },
        orders: [ORDER],
      }),
    );

    expect(html).toContain('完成');
    expect(html).toContain('取消');
    // 只有 read + view_price：按钮在，但 disabled（权限判定在服务端，前端只是不放开）
    expect(html).toContain('disabled');
  });
});
