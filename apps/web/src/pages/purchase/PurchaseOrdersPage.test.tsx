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
import {
  DetailPanel,
  NewSupplierInlineForm,
  PurchaseOrdersPage,
  validateDraft,
} from './PurchaseOrdersPage';
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
  lines: [{ lineNo: 1, productId: PRODUCT_ID, qty: '500', unitPrice: '8.6', amount: '4300' }],
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

const DETAIL_BASE: PurchaseOrderDetail = {
  ...ORDER,
  cancelable: { allowed: true, reason: null },
};

interface DetailOpts {
  readonly status?: PurchaseOrderStatus;
  readonly canUpdate?: boolean;
  readonly canViewPrice?: boolean;
  /** 到货确认 / 完成：都是 `purchase.approve`。 */
  readonly canApprove?: boolean;
  /** 发货 / 撤销发货：`purchase.ship`。 */
  readonly canShip?: boolean;
  readonly revoking?: boolean;
  readonly revokeError?: string | null;
  readonly cancelable?: PurchaseOrderDetail['cancelable'];
}

/** 详情面板的静态渲染（本仓 Web 测试不带 jsdom，只能断言 SSR HTML）。 */
function renderDetail(opts: DetailOpts = {}): string {
  return renderToStaticMarkup(
    <DetailPanel
      order={{
        ...DETAIL_BASE,
        status: opts.status ?? '进行中',
        cancelable: opts.cancelable ?? DETAIL_BASE.cancelable,
      }}
      products={[PRODUCT]}
      handlerLabel="张明"
      canCancel
      canceling={false}
      canComplete={opts.canApprove ?? true}
      completing={false}
      canUpdate={opts.canUpdate ?? true}
      canViewPrice={opts.canViewPrice ?? true}
      canShip={opts.canShip ?? true}
      canApprove={opts.canApprove ?? true}
      shipping={false}
      receiving={false}
      revoking={opts.revoking ?? false}
      revokeBusy={false}
      revokeReason=""
      revokeError={opts.revokeError ?? null}
      onClose={() => {}}
      onEdit={() => {}}
      onCancel={() => {}}
      onComplete={() => {}}
      onShip={() => {}}
      onReceive={() => {}}
      onStartRevoke={() => {}}
      onRevokeReasonChange={() => {}}
      onCancelRevoke={() => {}}
      onSubmitRevoke={() => {}}
    />,
  );
}

/** 取某个按钮的标签，用于断言它是否置灰（只能认 `disabled` 属性，class 里也有 `disabled:`）。 */
function buttonMarkup(html: string, label: string): string {
  return new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? '';
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
    // 经手人不再占列表一列（8 列已把「操作」挤到卡片外），改在详情里给
    expect(html).not.toContain('>经手<');
    // 页头主按钮按视觉稿是「+ 新建」（`采购单A.html` 的 .btn-primary）
    expect(html).toContain('+ 新建');
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
    expect(html).toContain('+ 新建');
  });
});

describe('采购单详情「完成」入口（D94 起权限是 purchase.approve）', () => {
  it('进行中的单据渲染「完成采购单」按钮，且可点', () => {
    const html = renderDetail({ status: '进行中' });
    expect(html).toContain('完成采购单');
    expect(buttonMarkup(html, '完成采购单')).not.toContain('disabled=""');
  });

  it('已完成 / 已取消 / 在途的单据完成按钮置灰，不可点', () => {
    for (const status of ['已完成', '已取消', '在途'] as const) {
      expect(buttonMarkup(renderDetail({ status }), '完成采购单')).toContain('disabled=""');
    }
  });

  it('缺 purchase.approve：「完成」置灰并说清是审批动作，不再写 purchase.update', () => {
    // D94 把 `purchase.order.complete` 从 `update` 摘到了 `approve`：
    // 能改单不再自动能入库。提示必须跟着改，否则别人照着去配 `purchase.update`。
    const html = renderDetail({ canApprove: false, canUpdate: true });
    expect(buttonMarkup(html, '完成采购单')).toContain('disabled=""');
    expect(html).toContain('当前身份没有 purchase.approve 权限');
  });

  it('在途时「完成」给出下一步（去点到货确认），不是一句「状态不对」', () => {
    const html = renderDetail({ status: '在途' });
    expect(html).toContain('请点「到货确认」入库');
  });
});

describe('采购单详情「编辑」入口的三态（#261 同型缺陷）', () => {
  it('有 update + 看价 + 进行中：编辑可点，无置灰理由文案', () => {
    const html = renderDetail();
    expect(buttonMarkup(html, '编辑')).not.toContain('disabled=""');
    expect(html).not.toContain('purchase.update 权限');
  });

  it('缺 purchase.update：编辑置灰，并说明缺哪个权限点', () => {
    const html = renderDetail({ canUpdate: false });
    expect(buttonMarkup(html, '编辑')).toContain('disabled=""');
    expect(html).toContain('当前身份没有 purchase.update 权限');
  });

  it('有 update 但无看价：编辑置灰，并说明看不到单价没法改单', () => {
    const html = renderDetail({ canViewPrice: false });
    expect(buttonMarkup(html, '编辑')).toContain('disabled=""');
    expect(html).toContain('无看价权限');
    expect(html).toContain('purchase.view_price');
  });

  it('权限都够但单据已完成：编辑置灰，理由是状态而不是权限', () => {
    const html = renderDetail({ status: '已完成' });
    expect(buttonMarkup(html, '编辑')).toContain('disabled=""');
    expect(html).toContain('只有「进行中」的采购单能编辑，当前是「已完成」');
    expect(html).not.toContain('当前身份没有 purchase.update 权限');
  });
});

describe('采购单详情 D94 在途三态（#332）', () => {
  it('进行中且无 purchase.ship：发货按钮置灰，文案与 title 都点名权限', () => {
    const html = renderDetail({ status: '进行中', canShip: false });
    const button = buttonMarkup(html, '发货');
    expect(button).toContain('disabled=""');
    expect(button).toContain('purchase.ship');
    expect(html).toContain('当前身份没有 purchase.ship 权限');
  });

  it('进行中且有 purchase.ship：发货可点，且此时没有到货确认 / 撤销发货', () => {
    const html = renderDetail({ status: '进行中', canShip: true });
    expect(buttonMarkup(html, '发货')).not.toContain('disabled=""');
    expect(html).not.toContain('到货确认');
    expect(html).not.toContain('撤销发货');
  });

  it('在途：发货消失，到货确认与撤销发货出现', () => {
    const html = renderDetail({ status: '在途' });
    expect(buttonMarkup(html, '发货')).toBe('');
    expect(html).toContain('到货确认');
    expect(html).toContain('撤销发货');
  });

  it('在途且无 purchase.approve：到货确认置灰，说清是审批动作', () => {
    const html = renderDetail({ status: '在途', canApprove: false });
    const button = buttonMarkup(html, '到货确认');
    expect(button).toContain('disabled=""');
    expect(button).toContain('purchase.approve');
    expect(html).toContain('到货确认是审批动作');
  });

  it('在途且无 purchase.ship：撤销发货置灰（与发货同权限点）', () => {
    const html = renderDetail({ status: '在途', canShip: false, canApprove: true });
    const button = buttonMarkup(html, '撤销发货');
    expect(button).toContain('disabled=""');
    expect(button).toContain('purchase.ship');
  });

  it('撤销输入区展开后：原因框在，且服务端没给原因前不发请求（提示文字在）', () => {
    const html = renderDetail({ status: '在途', revoking: true });
    expect(html).toContain('撤销原因（必填，会记审计）');
    expect(html).toContain('确认撤销');
  });

  it('撤销原因为空时的提示由 revokeReasonError 给出（纯函数，见 ship-flow 测试）', () => {
    const html = renderDetail({ status: '在途', revoking: true, revokeError: '撤销发货必须填写原因，本次未提交。' });
    expect(html).toContain('撤销发货必须填写原因');
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

describe('v0.13 版式（#337）', () => {
  it('列表落在 card 上，三行状态行常驻、数据行只带 r-row', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('class="card"');
    expect(html).toContain('data-state="filled"');
    expect(html).toContain('class="r-row"');
    // 数据行带 st-tr 就会命中 `tbody > tr.st-tr{display:none}`，filled 态没有复原规则
    expect(html).not.toContain('st-tr r-row');
    for (const stateClass of ['st-tr st-loading', 'st-tr st-error', 'st-tr st-empty']) {
      expect(html).toContain(stateClass);
    }
  });

  it('游标分页写「上一批 / 下一批」，不画页码', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('上一批');
    expect(html).toContain('下一批');
    expect(html).not.toContain('下一页');
  });

  it('在途在列表里是 transit（蓝）档，不与「进行中」同色（D94）', () => {
    const inTransit: PurchaseOrder = { ...ORDER, status: '在途' };
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [inTransit] }));

    expect(html).toContain('class="st transit"');
    expect(html).not.toContain('class="st now"');
  });
});

/* ---------------------- 开单现场建档（D100 静默建档） ---------------------- */

describe('开单现场建档（D100）', () => {
  const LINE = { productId: 'p1', qty: '2', unitPrice: '10' };

  it('给了草档就不再要求 supplierId，改要求名称', () => {
    expect(validateDraft('', [LINE], [], { name: '宏发五金' })).not.toContain('请选择供应商');
    expect(validateDraft('', [LINE], [], { name: '   ' })).toContain(
      '新建供应商：请填写供应商名称',
    );
    expect(validateDraft('', [LINE], [], { name: 'x'.repeat(65) })).toContain(
      '新建供应商：名称最多 64 字',
    );
  });

  it('内联表单三个输入齐全，且无建档提示', () => {
    const html = renderToStaticMarkup(
      <NewSupplierInlineForm
        fields={{ name: '宏发五金', contactName: '', contactPhone: '' }}
        onChange={() => undefined}
      />,
    );
    for (const label of ['新建供应商名称', '新建供应商联系人', '新建供应商电话']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain('已建档');
    expect(html).not.toContain('待审核');
    expect(html).toContain('value="宏发五金"');
  });
});
