import type { Product, SalesOrder, SalesOrderDetail } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { MASKED_AMOUNT } from '../../lib/decimal';
import { authKeys } from '../auth/auth-api';
import { DetailPanel, NewCustomerInlineForm, SalesOrdersPage } from './SalesOrdersPage';
import { salesQueryKeys } from './sales-api';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000201';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000101';
const BATCH_ID = '00000000-0000-4000-8000-000000000401';
const SECOND_PRODUCT_ID = '00000000-0000-4000-8000-000000000102';

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
  /** 商品簿：列表「商品」列靠它把 productId 换回名字。 */
  readonly products?: readonly Product[];
  /** 页码模式的总条数（D95）：不传就按本页行数算，即「只有一页」。 */
  readonly total?: number;
}): ReturnType<typeof createQueryClient> {
  const client = createQueryClient();
  client.setQueryData(authKeys.me, input.me);
  client.setQueryData(salesQueryKeys.products, {
    items: [...(input.products ?? [PRODUCT])],
    nextCursor: null,
  });
  client.setQueryData(salesQueryKeys.customers('', ''), { items: [], nextCursor: null });
  client.setQueryData(
    salesQueryKeys.list({
      companyId: undefined,
      customerId: undefined,
      status: undefined,
      keyword: undefined,
      page: 1,
      pageSize: 20,
      sort: 'createdAt',
      order: 'desc',
    }),
    {
      items: [...input.orders],
      total: input.total ?? input.orders.length,
      page: 1,
      pageSize: 20,
      nextCursor: null,
    },
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
    expect(html).toContain('+ 新建');
    // 数量合计来自明细行，不是单头字段
    expect(html).toContain('>10<');
    // 开单时间用短格式（`11/08 10:00`，与 A / B 页同款）：表格里塞完整年月日会把操作列挤出卡片。
    expect(html).toContain('11/08 10:00');
    expect(html).not.toContain('2026/11/08');
  });

  it('列表「商品」列：单商品写名字，多商品补「等 N 种」', () => {
    // 一单多行多商品时，只写首行商品名会让人以为整单就这一种货。
    const single = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));
    expect(single).toContain('不锈钢合页 4寸');
    expect(single).not.toContain('等 2 种');

    const second: Product = {
      ...PRODUCT,
      id: SECOND_PRODUCT_ID,
      productNo: 'P-1002',
      name: '铝合金拉手 128mm',
    };
    const twoKinds: SalesOrder = {
      ...ORDER,
      lines: [ORDER.lines[0]!, { ...ORDER.lines[0]!, productId: SECOND_PRODUCT_ID }],
    };
    const multi = renderPage(
      seedClient({ me: ME_WITH_PRICE, orders: [twoKinds], products: [PRODUCT, second] }),
    );
    expect(multi).toContain('不锈钢合页 4寸 等 2 种');
  });

  it('同一商品拆成两行只算一种货，不写成「等 2 种」', () => {
    const twoLines: SalesOrder = {
      ...ORDER,
      lines: [ORDER.lines[0]!, { ...ORDER.lines[0]!, qty: '5', amount: '62.5' }],
    };
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [twoLines] }));

    expect(html).toContain('不锈钢合页 4寸');
    // 「种」按不同商品数算，不是按行数——否则一单分两批发的同一商品会被说成两种。
    expect(html).not.toContain('等 2 种');
    // 数量仍然按行合计（10 + 5）。
    expect(html).toContain('>15<');
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

  it('销售身份（有 update、无 ship）看到「发货」被禁用并写明缺 sales.ship（D85）', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    // 列表这一格原叫「完成」，但它调的是出库（askShip）；D94 之后「完成」专指客户签收。
    expect(buttonTag(html, '发货')).toContain('disabled=""');
    expect(html).toContain('取消');
    // D85：能改单不等于能出库——只有 sales.update 时按钮仍在但禁用，并给出具体权限点。
    expect(html).toContain('当前身份没有 sales.ship 权限');
    expect(html).toContain('disabled');
  });

  it('授予 sales.ship 后「发货」可点，也不再提示缺权限', () => {
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

    expect(buttonTag(html, '发货')).not.toContain('disabled=""');
    expect(html).not.toContain('当前身份没有 sales.ship 权限');
  });

  it('无 export 权限时说清导出需要 sales.export（敏感读记审计，D54②）', () => {
    const withoutExport = renderPage(
      seedClient({
        me: {
          ...ME_WITH_PRICE,
          scope: [{ domain: 'sales', actions: ['read', 'create', 'update', 'view_price'] }],
        },
        orders: [ORDER],
      }),
    );
    expect(withoutExport).toContain('「导出 CSV」需要 sales.export');
    expect(withoutExport).toContain('敏感读记审计');

    // 有 export 时不该出现这条提示（否则等于把有权限的人也劝退了）
    const withExport = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));
    expect(withExport).not.toContain('「导出 CSV」需要 sales.export');
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
  canComplete: true,
  canCancel: true,
  canCreatePayment: true,
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
        canComplete={perms.canComplete ?? FULL_PERMS.canComplete}
        canCancel={perms.canCancel ?? FULL_PERMS.canCancel}
        canCreatePayment={perms.canCreatePayment ?? FULL_PERMS.canCreatePayment}
        busy={false}
        onClose={() => undefined}
        onEdit={() => undefined}
        onShip={() => undefined}
        onComplete={() => undefined}
        onCancel={() => undefined}
        onPrint={() => undefined}
        onRefresh={() => undefined}
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

describe('销售单「发货 → 客户签收」两步（D94）', () => {
  it('进行中 + 有 ship：发货可点，签收置灰（还没发货）', () => {
    const html = renderDetailPanel();
    expect(buttonTag(html, '发货')).not.toContain('disabled=""');
    expect(buttonTag(html, '客户签收')).toContain('disabled=""');
    expect(html).toContain('仅「已发货」状态的销售单可签收');
  });

  it('已发货 + 有 approve：签收可点，发货置灰（已经发过了）', () => {
    const html = renderDetailPanel({ status: '已发货' });
    expect(buttonTag(html, '客户签收')).not.toContain('disabled=""');
    expect(buttonTag(html, '发货')).toContain('disabled=""');
  });

  it('已发货但缺 sales.approve（如仓管）：签收置灰并说明缺哪个权限点', () => {
    // 这是把「发货」与「签收」拆成两个 action 的全部意义：仓管能发货，但认不了收入。
    const html = renderDetailPanel({ status: '已发货', canComplete: false });
    expect(buttonTag(html, '客户签收')).toContain('disabled=""');
    expect(html).toContain('当前身份没有 sales.approve 权限');
  });
});

/* ---------------------- v0.13 详情版式（#337 单据组） ---------------------- */

describe('v0.13 详情版式（#337）', () => {
  it('详情落在 card 上，走 DetailHead + DocMeta + LinesFooter 三块公用版式', () => {
    const html = renderDetailPanel();

    expect(html).toContain('class="card min-w-0 space-y-3 p-4"');
    // DetailHead：单据名 + 单号 + 状态徽标 + 关闭（关闭按 v0.13 叫「收起」）
    expect(html).toContain('销售单');
    expect(html).toContain('收起');
    // DocMeta 网格（gap-px 模拟单元格分隔线）
    expect(html).toContain('gap-px');
    expect(html).toContain('数量合计');
    // LinesFooter：明细合计行
    expect(html).toContain('共');
    expect(html).toContain('行');
  });

  it('状态徽标用 .st 语义档，「已发货」是 transit 而不是自拼琥珀', () => {
    const shipping = renderDetailPanel({ status: '已发货' });

    expect(shipping).toContain('class="st transit"');
    expect(shipping).not.toContain('bg-amber-50');
    expect(renderDetailPanel({ status: '进行中' })).toContain('class="st now"');
    expect(renderDetailPanel({ status: '已完成' })).toContain('class="st ok"');
    expect(renderDetailPanel({ status: '已取消' })).toContain('class="st cancel"');
  });

  it('主色只给当前状态该做的那一步：进行中亮「发货」，已发货亮「客户签收」', () => {
    expect(buttonTag(renderDetailPanel({ status: '进行中' }), '发货')).toContain('btn-p');
    expect(buttonTag(renderDetailPanel({ status: '进行中' }), '客户签收')).not.toContain('btn-p');
    expect(buttonTag(renderDetailPanel({ status: '已发货' }), '客户签收')).toContain('btn-p');
    expect(buttonTag(renderDetailPanel({ status: '已发货' }), '发货')).not.toContain('btn-p');
  });

  it('明细表列序把「引用批次」贴近商品，合计才落在「金额」列下', () => {
    const html = renderDetailPanel();

    const productAt = html.indexOf('>商品<');
    const batchAt = html.indexOf('>引用批次<');
    const qtyAt = html.indexOf('>数量<');
    const amountAt = html.lastIndexOf('>金额<');
    expect(productAt).toBeGreaterThan(-1);
    expect(productAt).toBeLessThan(batchAt);
    expect(batchAt).toBeLessThan(qtyAt);
    expect(qtyAt).toBeLessThan(amountAt);
  });
});

/* ---------------------- 开单现场建档的内联表单（D100） ---------------------- */

describe('开单现场建档的内联表单（D100）', () => {
  const render = (fields: {
    name: string;
    contactName: string;
    contactPhone: string;
    creditTermDays: string;
  }): string =>
    // 草档里挂了建档防重（SuggestHint），它要 QueryClient —— 静态渲染也得包一层。
    renderToStaticMarkup(
      <QueryClientProvider client={createQueryClient()}>
        <NewCustomerInlineForm
          fields={fields}
          onChange={() => undefined}
          companyId="01900000-0000-7000-8000-000000000002"
          onPickExisting={() => undefined}
        />
      </QueryClientProvider>,
    );

  it('四个输入齐全：名称必填，其余选填、账期留空即现结', () => {
    const html = render({ name: '', contactName: '', contactPhone: '', creditTermDays: '' });

    for (const label of ['新建客户名称', '新建客户联系人', '新建客户电话', '新建客户账期']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('客户名称（必填）');
    expect(html).toContain('留空 = 现结');
  });

  it('不出现「已建档 / 待审核」之类提示（D100 静默建档：建档对员工透明）', () => {
    const html = render({
      name: '张记建材',
      contactName: '张伟',
      contactPhone: '',
      creditTermDays: '30',
    });

    expect(html).not.toContain('已建档');
    expect(html).not.toContain('待审核');
    expect(html).not.toContain('已提交');
    // 值应当回填到输入框，而不是只在说明文字里出现
    expect(html).toContain('value="张记建材"');
  });
});

describe('v3.0 列表版式（#431）', () => {
  it('列表落在 card list-card 上，页脚是 .tf（左汇总 + 右分页）', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('class="card list-card"');
    expect(html).toContain('class="tw"');
    expect(html).toContain('class="tf"');
    expect(html).toContain('共 1 张');
  });

  it('页脚画首 / 上 / 页码 / 下 / 末 + 每页条数，总页数取服务端 total', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER], total: 45 }));

    for (const label of ['第一页', '上一页', '下一页', '最后一页']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    // 45 张 / 20 条 = 3 页
    expect(html).toContain('aria-label="第 3 页"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="每页条数"');
  });

  it('合计只在「一页装得下全部」时给，翻页态不拿本页和冒充全量', () => {
    const single = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));
    expect(single).toContain('· 合计');
    expect(single).toContain('¥225.00');

    const paged = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER], total: 45 }));
    expect(paged).not.toContain('· 合计');
  });
});
