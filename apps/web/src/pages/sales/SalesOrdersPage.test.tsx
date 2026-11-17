import type { Product, SalesOrder, SalesOrderDetail } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { MASKED_AMOUNT } from '../../lib/decimal';
import { authKeys } from '../auth/auth-api';
import { DetailPanel, SalesOrdersPage } from './SalesOrdersPage';
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

  it('销售身份（有 update、无 ship）看到完成按钮被禁用并写明缺 sales.ship（D85）', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('完成');
    expect(html).toContain('取消');
    // D85：能改单不等于能出库——只有 sales.update 时按钮仍在但禁用，并给出具体权限点。
    expect(html).toContain('当前身份没有 sales.ship 权限');
    expect(html).toContain('disabled');
  });

  it('授予 sales.ship 后不再提示缺权限（按钮可点）', () => {
    const html = renderPage(
      seedClient({
        me: {
          ...ME_WITH_PRICE,
          scope: [
            {
              domain: 'sales',
              actions: ['read', 'create', 'update', 'ship', 'delete', 'export', 'view_price'],
            },
          ],
        },
        orders: [ORDER],
      }),
    );

    expect(html).toContain('完成');
    expect(html).not.toContain('当前身份没有 sales.ship 权限');
  });
});

// ============================ 详情面板「编辑」三态 ============================

const DETAIL: SalesOrderDetail = {
  ...ORDER,
  receipts: [],
  receiptBalance: '225',
  cancelable: { allowed: true, reason: null },
};

const FULL_PERMS = {
  canViewPrice: true,
  canUpdate: true,
  canShip: true,
  canCancel: true,
};

function renderDetailPanel(
  overrides: Partial<typeof FULL_PERMS> & { status?: SalesOrder['status'] } = {},
): string {
  const { status, ...perms } = overrides;
  // 详情面板要读员工姓名簿（`useEmployeeLabel`），必须给 Provider；
  // 空表时回到短 id，不影响按钮三态的断言。
  const client = createQueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DetailPanel
        order={{ ...DETAIL, status: status ?? DETAIL.status }}
        products={[PRODUCT]}
        batches={[]}
        canViewPrice={perms.canViewPrice ?? FULL_PERMS.canViewPrice}
        canUpdate={perms.canUpdate ?? FULL_PERMS.canUpdate}
        canShip={perms.canShip ?? FULL_PERMS.canShip}
        canCancel={perms.canCancel ?? FULL_PERMS.canCancel}
        busy={false}
        onClose={() => undefined}
        onEdit={() => undefined}
        onShip={() => undefined}
        onCancel={() => undefined}
        onPrint={() => undefined}
        onError={() => undefined}
      />
    </QueryClientProvider>,
  );
}

/** 取出某个按钮自己的标签，避免被旁边的提示文案干扰。 */
function buttonTag(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  expect(match, `找不到按钮「${label}」`).not.toBeNull();
  return match![0];
}

describe('销售单详情「编辑」入口的三态（#261 同型缺陷）', () => {
  it('有 update + 看价 + 进行中：编辑可点', () => {
    const html = renderDetailPanel();
    expect(buttonTag(html, '编辑')).not.toContain('disabled=""');
  });

  it('缺 sales.update（如「财务+销售」预设）：编辑置灰并说明缺哪个权限点', () => {
    // 这是修前最要命的一条：财务只有 read + view_price，按钮却能点开表单，保存才 403。
    const html = renderDetailPanel({ canUpdate: false });
    expect(buttonTag(html, '编辑')).toContain('disabled=""');
    expect(html).toContain('当前身份没有 sales.update 权限');
  });

  it('有 update 但无看价：编辑置灰，理由是看不到单价', () => {
    const html = renderDetailPanel({ canViewPrice: false });
    expect(buttonTag(html, '编辑')).toContain('disabled=""');
    expect(html).toContain('sales.view_price');
  });

  it('权限齐但单据不是进行中：编辑置灰，理由是状态', () => {
    const html = renderDetailPanel({ status: '已完成' });
    expect(buttonTag(html, '编辑')).toContain('disabled=""');
    expect(html).toContain('只有「进行中」的销售单能编辑，当前是「已完成」');
  });

  it('无看价时打印客户联仍可点，但要先说打印件金额是「—」（D79）', () => {
    const html = renderDetailPanel({ canViewPrice: false });
    expect(buttonTag(html, '打印客户联')).not.toContain('disabled=""');
    expect(html).toContain('打印件上的金额是「—」');
  });

  it('有看价时打印按钮不带那条说明', () => {
    expect(renderDetailPanel()).not.toContain('打印件上的金额是「—」');
  });
});
