import type {
  Product,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderStatus,
} from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { authKeys } from '../auth/auth-api';
import { DetailPanel, PurchaseOrdersPage, validateDraft } from './PurchaseOrdersPage';
import { MASKED_AMOUNT, purchaseQueryKeys } from './purchase-api';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000101';
const SUPPLIER_ID = '00000000-0000-4000-8000-000000000201';

const PRODUCT: Product = {
  id: PRODUCT_ID,
  tenantId: 't1',
  companyId: COMPANY_ID,
  productNo: 'P-1001',
  name: '不锈钢合页 4寸',
  aliases: [],
  specification: '50/箱',
  unit: '箱',
  defaultSalePrice: '15.5',
  version: 1,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
};

const ORDER: PurchaseOrder = {
  id: 'o1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  orderNo: 'A-BJ01-20261108-0001',
  supplierId: SUPPLIER_ID,
  supplierName: '宁波塑料厂',
  status: '进行中',
  handlerId: 'e1',
  lines: [{ productId: PRODUCT_ID, qty: '500', unitPrice: '8.6', amount: '4300' }],
  fees: [{ feeName: '运费', qty: '1', unitPrice: '100', amount: '100', remark: null }],
  goodsAmount: '4300',
  feeAmount: '100',
  totalAmount: '4400',
  version: 3,
  createdAt: '2026-11-08T02:00:00.000Z',
  updatedAt: '2026-11-08T03:00:00.000Z',
};

const ME_WITH_PRICE = {
  employeeId: 'e1',
  tenantId: 't1',
  displayName: '张明',
  companyIds: [COMPANY_ID],
  scope: [{ domain: 'purchase', actions: ['read', 'create', 'update', 'delete', 'view_price'] }],
};

function seedClient(input: {
  readonly me: typeof ME_WITH_PRICE;
  readonly orders: readonly PurchaseOrder[];
}): ReturnType<typeof createQueryClient> {
  const client = createQueryClient();
  client.setQueryData(authKeys.me, input.me);
  client.setQueryData(purchaseQueryKeys.products, { items: [PRODUCT], nextCursor: null });
  client.setQueryData(purchaseQueryKeys.suppliers, { items: [], nextCursor: null });
  client.setQueryData(
    purchaseQueryKeys.list({
      companyId: undefined,
      supplierId: undefined,
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
      <PurchaseOrdersPage />
    </QueryClientProvider>,
  );
}

describe('采购单 A 页面', () => {
  it('列表渲染单号、供应商、物料名、货款、状态与经手人', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('采购单 A');
    expect(html).toContain('A-BJ01-20261108-0001');
    expect(html).toContain('宁波塑料厂');
    // 明细只有 productId：商品名靠主数据映射，映射不到才降级成短 id
    expect(html).toContain('不锈钢合页 4寸');
    expect(html).toContain('¥4,300.00');
    expect(html).toContain('进行中');
    expect(html).toContain('张明');
    expect(html).toContain('新建采购单');
  });

  it('无看价权限时金额全遮罩，且不把 null 当 0（D79）', () => {
    const masked: PurchaseOrder = {
      ...ORDER,
      lines: ORDER.lines.map((line) => ({ ...line, unitPrice: null, amount: null })),
      fees: ORDER.fees.map((fee) => ({ ...fee, unitPrice: null, amount: null })),
      goodsAmount: null,
      feeAmount: null,
      totalAmount: null,
    };
    const html = renderPage(
      seedClient({
        me: {
          ...ME_WITH_PRICE,
          scope: [{ domain: 'purchase', actions: ['read'] }],
        },
        orders: [masked],
      }),
    );

    expect(html).toContain(MASKED_AMOUNT);
    expect(html).toContain('当前身份无「看价」权限');
    // 关键断言：遮罩页面里不能出现任何已格式化的金额
    expect(html).not.toContain('¥');
    expect(html).not.toContain('¥0.00');
  });

  it('无 create 权限时页面直说为什么不能建单，而不是画个灰按钮一了百了', () => {
    const html = renderPage(
      seedClient({
        me: { ...ME_WITH_PRICE, scope: [{ domain: 'purchase', actions: ['read'] }] },
        orders: [],
      }),
    );

    expect(html).toContain('需要 purchase.create');
    expect(html).toContain('暂无采购单');
  });

  it('空列表给出明确空态与下一步', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [] }));
    expect(html).toContain('暂无采购单');
    expect(html).toContain('新建采购单');
  });
});

describe('采购单详情「完成」入口', () => {
  const DETAIL: PurchaseOrderDetail = {
    ...ORDER,
    cancelable: { allowed: true, reason: null },
  };

  function renderDetail(
    order: PurchaseOrderDetail,
    opts: { canUpdate?: boolean; canViewPrice?: boolean } = {},
  ): string {
    return renderToStaticMarkup(
      <DetailPanel
        order={order}
        products={[PRODUCT]}
        canCancel
        canceling={false}
        canComplete={opts.canUpdate ?? true}
        completing={false}
        canUpdate={opts.canUpdate ?? true}
        canViewPrice={opts.canViewPrice ?? true}
        onClose={() => {}}
        onEdit={() => {}}
        onCancel={() => {}}
        onComplete={() => {}}
      />,
    );
  }

  /** 从 SSR HTML 里摘出「完成采购单」按钮的标签，用于断言它是否置灰（disabled）。 */
  function completeButtonMarkup(html: string): string {
    return /<button[^>]*>完成采购单<\/button>/.exec(html)?.[0] ?? '';
  }

  it('进行中的单据渲染「完成采购单」按钮，且可点', () => {
    const html = renderDetail({ ...DETAIL, status: '进行中' });
    expect(html).toContain('完成采购单');
    expect(completeButtonMarkup(html)).not.toContain('disabled=""');
  });

  it('已完成 / 已取消的单据完成按钮置灰，不可点', () => {
    expect(completeButtonMarkup(renderDetail({ ...DETAIL, status: '已完成' }))).toContain(
      'disabled=""',
    );
    expect(completeButtonMarkup(renderDetail({ ...DETAIL, status: '已取消' }))).toContain(
      'disabled=""',
    );
  });
});

describe('采购单详情「编辑」入口的三态（#261 同型缺陷）', () => {
  const DETAIL: PurchaseOrderDetail = {
    ...ORDER,
    status: '进行中',
    cancelable: { allowed: true, reason: null },
  };

  function renderDetail(
    opts: { canUpdate?: boolean; canViewPrice?: boolean; status?: PurchaseOrderStatus } = {},
  ): string {
    return renderToStaticMarkup(
      <DetailPanel
        order={{ ...DETAIL, status: opts.status ?? DETAIL.status }}
        products={[PRODUCT]}
        canCancel
        canceling={false}
        canComplete={opts.canUpdate ?? true}
        completing={false}
        canUpdate={opts.canUpdate ?? true}
        canViewPrice={opts.canViewPrice ?? true}
        onClose={() => {}}
        onEdit={() => {}}
        onCancel={() => {}}
        onComplete={() => {}}
      />,
    );
  }

  function editButton(html: string): string {
    return /<button[^>]*>编辑<\/button>/.exec(html)?.[0] ?? '';
  }

  it('有 update + 看价 + 进行中：编辑可点，无置灰理由文案', () => {
    const html = renderDetail();
    expect(editButton(html)).not.toContain('disabled=""');
    expect(html).not.toContain('purchase.update 权限');
  });

  it('缺 purchase.update：编辑置灰，并说明缺哪个权限点', () => {
    const html = renderDetail({ canUpdate: false });
    expect(editButton(html)).toContain('disabled=""');
    expect(html).toContain('当前身份没有 purchase.update 权限');
  });

  it('有 update 但无看价：编辑置灰，并说明看不到单价没法改单', () => {
    const html = renderDetail({ canViewPrice: false });
    expect(editButton(html)).toContain('disabled=""');
    expect(html).toContain('无看价权限');
    expect(html).toContain('purchase.view_price');
  });

  it('权限都够但单据已完成：编辑置灰，理由是状态而不是权限', () => {
    const html = renderDetail({ status: '已完成' });
    expect(editButton(html)).toContain('disabled=""');
    expect(html).toContain('只有「进行中」的采购单能编辑，当前是「已完成」');
    expect(html).not.toContain('当前身份没有 purchase.update 权限');
  });

  it('「完成采购单」的提示给的是真实权限点 purchase.update，不是 purchase.approve', () => {
    // 契约里 `purchase.order.complete` 的 action 是 update；写成 approve 会让人去配错权限。
    const html = renderDetail({ canUpdate: false });
    expect(html).toContain('purchase.update');
    expect(html).not.toContain('purchase.approve');
  });
});

describe('采购单开单前校验', () => {
  const validLine = { productId: PRODUCT_ID, qty: '500', unitPrice: '8.6' };

  it('供应商、明细、数量单价都是硬门槛', () => {
    expect(validateDraft('', [], [])).toContain('请选择供应商');
    expect(validateDraft(SUPPLIER_ID, [], [])).toContain('采购单至少 1 行商品明细');
    expect(validateDraft(SUPPLIER_ID, [{ productId: '', qty: '', unitPrice: '' }], [])).toEqual(
      expect.arrayContaining([
        '第 1 行商品：请选择商品',
        '第 1 行商品：数量必须是非负数字（最多 6 位小数）',
        '第 1 行商品：单价必须是非负数字',
      ]),
    );
    expect(validateDraft(SUPPLIER_ID, [{ ...validLine, qty: '0' }], [])).toContain(
      '第 1 行商品：数量必须大于 0',
    );
  });

  it('费用金额不得为负，最低 0（D83：D39 的负数口径已作废）', () => {
    const negative = { feeName: '运费', qty: '1', unitPrice: '100', amount: '-100', remark: '' };
    expect(validateDraft(SUPPLIER_ID, [validLine], [negative])).toContain(
      '第 1 行费用：金额必须是非负数字（最多 6 位小数）',
    );
    // 填了备注也照样拒——负数费用没有合法场景。
    expect(
      validateDraft(SUPPLIER_ID, [validLine], [{ ...negative, remark: '供应商返利' }]),
    ).toContain('第 1 行费用：金额必须是非负数字（最多 6 位小数）');
    expect(
      validateDraft(SUPPLIER_ID, [validLine], [{ ...negative, amount: '0' }]),
    ).toHaveLength(0);
    expect(
      validateDraft(SUPPLIER_ID, [validLine], [{ ...negative, amount: '100' }]),
    ).toHaveLength(0);
  });

  it('合法单据零报错', () => {
    expect(validateDraft(SUPPLIER_ID, [validLine], [])).toHaveLength(0);
  });
});
