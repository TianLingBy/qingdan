import type { InternalTradeOrder, InternalTradeOrderDetail, Product } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../api/query';
import { employeeDirectoryKey } from '../../lib/employee-directory';
import { authKeys } from '../auth/auth-api';
import {
  DetailPanel,
  InternalTradeOrdersPage,
  confirmRevokeDispatch,
  openRevokeDispatch,
  revokeReasonError,
} from './InternalTradeOrdersPage';
import { createInternalTradesApi, internalTradeQueryKeys } from './internal-trades-api';

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
    readonly actions: readonly ('read' | 'create' | 'update' | 'delete' | 'ship' | 'approve')[];
  }[];
}

const OWNER: TestMe = {
  employeeId: 'e1',
  tenantId: 't1',
  displayName: '张明',
  companyIds: [FROM, TO],
  scope: [{ domain: 'internal_trade', actions: ['read', 'create', 'update', 'delete', 'ship', 'approve'] }],
};

/** 造不同权限的身份，避免把 `readonly ['read']` 这种字面量元组塞进上面的窄类型。 */
function meWith(
  actions: readonly ('read' | 'create' | 'update' | 'delete' | 'ship' | 'approve')[],
): TestMe {
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

const DETAIL: InternalTradeOrderDetail = {
  ...ORDER,
  cancelable: { allowed: true, reason: null },
};

interface RenderDetailOptions {
  readonly canReceive?: boolean;
  readonly canShip?: boolean;
  readonly revoking?: boolean;
  readonly revokeReason?: string;
  readonly revokeError?: string | null;
}

function renderDetail(order: InternalTradeOrderDetail, options: RenderDetailOptions = {}): string {
  const client = createQueryClient();
  // 姓名簿空表：详情面板回显经手人走 id 前缀兜底，不触发网络。
  client.setQueryData(employeeDirectoryKey, []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DetailPanel
        order={order}
        products={[PRODUCT]}
        batches={[]}
        canUpdate
        canCancel
        canReceive={options.canReceive ?? true}
        canShip={options.canShip ?? true}
        busy={false}
        receiveBusy={false}
        dispatchBusy={false}
        revokeBusy={false}
        revoking={options.revoking ?? false}
        revokeReason={options.revokeReason ?? ''}
        revokeError={options.revokeError ?? null}
        onClose={() => {}}
        onEdit={() => {}}
        onCancel={() => {}}
        onReceive={() => {}}
        onDispatch={() => {}}
        onStartRevoke={() => {}}
        onRevokeReasonChange={() => {}}
        onSubmitRevoke={() => {}}
        onCancelRevoke={() => {}}
      />
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

  it('「在途」单据渲染「到货确认」按钮，已完成 / 已取消不渲染（#211 口径变更）', () => {
    // #211 起契约补充了 internal_trade.order.receive 端点（D31 / D68③），
    // 前端从「故意不画到货确认按钮」改为「仅在途可点」。发货 / 撤销发货接入后，
    // 在途显示的是「撤销发货」，仍然不显示「发货」。
    const inTransit = renderDetail(DETAIL);
    expect(inTransit).toContain('>到货确认<');
    expect(inTransit).not.toContain('>发货<');

    const completed = renderDetail({ ...DETAIL, status: '已完成' });
    expect(completed).not.toContain('>到货确认<');

    const cancelled = renderDetail({ ...DETAIL, status: '已取消' });
    expect(cancelled).not.toContain('>到货确认<');
  });

  it('「进行中」渲染「发货」，「在途」渲染「撤销发货」且不渲染「发货」', () => {
    const inProgress = renderDetail({ ...DETAIL, status: '进行中' });
    expect(inProgress).toContain('>发货<');
    expect(inProgress).not.toContain('>撤销发货<');

    const inTransit = renderDetail(DETAIL);
    expect(inTransit).toContain('>撤销发货<');
    expect(inTransit).not.toContain('>发货<');
  });

  it('「已完成」「已取消」两个发货按钮都不渲染，并给一句状态原因', () => {
    const completed = renderDetail({ ...DETAIL, status: '已完成' });
    expect(completed).not.toContain('>发货<');
    expect(completed).not.toContain('>撤销发货<');
    expect(completed).toContain('不能再发货或撤销发货');

    const cancelled = renderDetail({ ...DETAIL, status: '已取消' });
    expect(cancelled).not.toContain('>发货<');
    expect(cancelled).not.toContain('>撤销发货<');
    expect(cancelled).toContain('不能发货或撤销发货');
  });

  it('没有 internal_trade.approve 时「到货确认」禁用并写明缺哪个权限点（D86）', () => {
    // 到货确认会把批次转司并生成结算草稿，按 D86 走 approve，不再借用 update：
    // 能改单不等于能把货收进自己公司。
    const html = renderDetail(DETAIL, { canReceive: false });
    expect(html).toContain('>到货确认<');
    expect(html).toContain('当前身份没有 internal_trade.approve 权限');
    expect(html).toContain('disabled');

    const allowed = renderDetail(DETAIL);
    expect(allowed).not.toContain('当前身份没有 internal_trade.approve 权限');
  });
  it('没有 internal_trade.ship 时不渲染「发货」/「撤销发货」（权限断言）', () => {
    const inProgress = renderDetail({ ...DETAIL, status: '进行中' }, { canShip: false });
    expect(inProgress).not.toContain('>发货<');

    const inTransit = renderDetail(DETAIL, { canShip: false });
    expect(inTransit).not.toContain('>撤销发货<');
  });

  it('点开「撤销发货」只展开原因输入区（不发请求），确认按钮才提交', () => {
    const closed = renderDetail(DETAIL);
    expect(closed).toContain('>撤销发货<');
    expect(closed).not.toContain('撤销原因（必填）');
    expect(closed).not.toContain('>确认撤销<');

    // 第一步只把单号写进草稿，不产生任何请求。
    expect(openRevokeDispatch(DETAIL)).toEqual({ orderId: DETAIL.id });

    const opened = renderDetail(DETAIL, { revoking: true });
    expect(opened).toContain('撤销原因（必填）');
    expect(opened).toContain('>确认撤销<');
    expect(opened).toContain('不转司');
  });

  it('撤销原因为空 / 全是空白时提交被拦下，不发请求', () => {
    expect(revokeReasonError('')).toContain('必须填写原因');
    expect(revokeReasonError('   ')).toContain('必须填写原因');
    expect(revokeReasonError('x'.repeat(201))).toContain('不能超过 200 字');
    expect(confirmRevokeDispatch(DETAIL, '   ')).toEqual({
      error: '撤销发货必须填写原因，本次未提交。',
    });

    // 校验失败时页面只把 revokeError 显示在输入区，不会走到 mutation。
    const opened = renderDetail(DETAIL, { revoking: true, revokeError: revokeReasonError('') });
    expect(opened).toContain('撤销发货必须填写原因');
  });

  it('填了原因提交时以 { confirm: true, reason } 与 If-Match 调 /dispatch-revoke', async () => {
    const post = vi.fn().mockResolvedValue({});
    const client = { post } as unknown as Parameters<typeof createInternalTradesApi>[0];
    const api = createInternalTradesApi(client);

    const confirmed = confirmRevokeDispatch(DETAIL, '  批次锁错  ');
    if (!('input' in confirmed)) throw new Error('期望校验通过');
    expect(confirmed.input.reason).toBe('批次锁错');

    await api.dispatchRevoke(
      confirmed.input.order.id,
      confirmed.input.order.version,
      confirmed.input.reason,
    );

    expect(post).toHaveBeenCalledWith(
      '/internal-trade-orders/n1/dispatch-revoke',
      { confirm: true, reason: '批次锁错' },
      { headers: { 'If-Match': '"2"' } },
    );
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

  /**
   * 四态（#337 v0.13）：DOM 里三个状态行**常驻**，靠 `data-state` 让 CSS 决定谁显示。
   * 这条测试盯着「别改回 `{rows.length === 0 ? … : …}`」——那样列数会塌、样式也拿不到。
   */
  it('有数据时容器与 tbody 都是 filled，三个状态行仍常驻（交给 CSS 显隐）', () => {
    const html = renderPage(seedClient({ me: OWNER, orders: [ORDER] }));

    expect(html).toContain('data-state="filled"');
    expect(html).toContain('st-tr st-loading');
    expect(html).toContain('st-tr st-error');
    expect(html).toContain('st-tr st-empty');
    // 数据行只带 r-row：带上 st-tr 会被 `tbody > tr.st-tr{display:none}` 整行吃掉（只有表头可见）
    expect(html).toContain('class="r-row"');
    expect(html).not.toContain('st-tr r-row');
  });

  it('空列表时 data-state 切到 empty，状态行 colSpan 等于表头列数（9 列不塌）', () => {
    const html = renderPage(seedClient({ me: OWNER, orders: [] }));

    expect(html).toContain('data-state="empty"');
    expect(html).toContain('colSpan="9"');
    expect(html).toContain('暂无内部交易单');
  });

  /** 游标分页没有总页数：只给「上一批 / 下一批」，不许画页码（D95 的例外情况）。 */
  it('单批数据不渲染分页条：没有 nextCursor 就不画「下一批」', () => {
    const html = renderPage(seedClient({ me: OWNER, orders: [ORDER] }));

    expect(html).not.toContain('下一批');
    expect(html).not.toContain('页</span>');
  });

  it('详情面板用单据信息网格 + 明细表 tfoot 合计（v0.13 单据详情版式）', () => {
    const html = renderDetail(DETAIL);

    expect(html).toContain('内部交易单');
    expect(html).toContain('内部价');
    expect(html).toContain('在途量');
    expect(html).toContain('共 1 行 · 数量合计 10');
    expect(html).toContain('¥125.00');
    // 状态徽标走 v0.13 的 `.st` 语义档，「在途」是 transit
    expect(html).toContain('st transit');
  });
});
