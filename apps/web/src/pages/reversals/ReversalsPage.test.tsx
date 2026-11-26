import type {
  CustomerReturn,
  ScopeMatrix,
  SupplierReturn,
} from '@qingdan/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { CustomerReturnsPanel } from './CustomerReturnsPanel';
import { ReversalsView } from './ReversalsPage';
import { SupplierReturnsPanel } from './SupplierReturnsPanel';
import { reversalsQueryKeys } from './reversals-api';

/**
 * 冲正页版式（#140 三条验收：原单关联、看价遮罩、三态齐全）。
 *
 * 用静态渲染 + `queries.enabled = false`：列表与下拉都停在骨架态，
 * 这样既不需要 jsdom，也不会在 Node 里发起真实请求。
 * 真实的「开单 → 列表出现 → 审批」在联调里验（见 PR 截图）。
 */

const COMPANY = '01900000-0000-7000-8000-000000000002';

const OWNER: ScopeMatrix = [
  { domain: 'customer_return', actions: ['read', 'create', 'view_price'] },
  { domain: 'supplier_return', actions: ['read', 'create', 'view_price'] },
  { domain: 'stocktake', actions: ['read', 'create', 'delete', 'approve'] },
];

const SUPPLIER_ONLY: ScopeMatrix = [
  { domain: 'supplier_return', actions: ['read', 'create', 'view_price'] },
];

const STOCKTAKE_READ_ONLY: ScopeMatrix = [
  { domain: 'stocktake', actions: ['read'] },
];

/** 有 R 单读写但没有看价（D79）——列表金额应显示破折号提示。 */
const CUSTOMER_NO_PRICE: ScopeMatrix = [
  { domain: 'customer_return', actions: ['read', 'create'] },
];

function view(
  scope: ScopeMatrix,
  companyIds: readonly string[] = [COMPANY],
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ReversalsView
        scope={scope}
        companyIds={companyIds}
        loading={false}
        error={null}
        onRetry={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('分栏按权限收窄', () => {
  it('三个域都有权限时，三个分栏都出现，默认落在 R', () => {
    const html = view(OWNER);
    expect(html).toContain('R 客户退货');
    expect(html).toContain('S 供应商退货');
    expect(html).toContain('I 盘点盈亏');
    // 默认分栏是 R：出现 R 的口径说明
    expect(html).toContain('R 单挂原销售单');
  });

  it('只有供应商退货权限时，回退到 S 分栏，不渲染 R 的列表与表单', () => {
    const html = view(SUPPLIER_ONLY);
    expect(html).toContain('只做');
    expect(html).toContain('退钱');
    expect(html).not.toContain('R 单挂原销售单');
    expect(html).not.toContain('退回商品（至少 1 行）');
  });

  it('只有盘点权限时，落在 I 分栏', () => {
    const html = view(STOCKTAKE_READ_ONLY);
    expect(html).toContain('唯一能直接改批次数量');
    expect(html).not.toContain('R 单挂原销售单');
  });

  it('一个冲正域都没有时给说明，不渲染空面板', () => {
    const html = view([]);
    expect(html).toContain('当前身份没有冲正单据的可读权限');
    expect(html).not.toContain('R 单挂原销售单');
    // 三个 tab 仍然在（只是禁用），方便知道有哪三类单
    expect(html).toContain('R 客户退货');
    expect(html).toContain('I 盘点盈亏');
  });
});

describe('看价权限（D79）', () => {
  it('没有 customer_return.view_price 时，列表明说金额显示破折号', () => {
    const html = view(CUSTOMER_NO_PRICE);
    expect(html).toContain('当前身份无看价权限，金额显示 —');
  });

  it('有看价权限时不出现这条提示', () => {
    const html = view(OWNER);
    expect(html).not.toContain('当前身份无看价权限');
  });
});

describe('盘点权限拆得比别的页细（D71）', () => {
  it('只有 read 时，开单按钮禁用并说明缺盘盈 / 盘亏权限', () => {
    const html = view(STOCKTAKE_READ_ONLY);
    expect(html).toContain('需要 stocktake.create 或 stocktake.delete 权限');
  });

  it('盘盈盘亏权限齐了就不再提示缺权限', () => {
    const html = view([
      { domain: 'stocktake', actions: ['read', 'create', 'delete'] },
    ]);
    expect(html).not.toContain('当前身份没有盘盈 / 盘亏权限');
  });
});

describe('v3.0 列表版式（#431）', () => {
  it('列表落在 card.list-card 上，表格套 .tw、页脚是 .tf，三个状态行常驻 tbody', () => {
    const html = view(OWNER);
    expect(html).toContain('class="card list-card"');
    expect(html).toContain('class="tw"');
    expect(html).toContain('class="tf"');
    expect(html).toContain('data-state="loading"');
    for (const stateClass of [
      'st-tr st-loading',
      'st-tr st-error',
      'st-tr st-empty',
    ]) {
      expect(html).toContain(stateClass);
    }
  });

  it('游标分页只写「第 N 批」+ 上一批 / 下一批，不画页码', () => {
    const html = view(OWNER);
    expect(html).toContain('上一批');
    expect(html).toContain('下一批');
    expect(html).toContain('第 1 批');
    expect(html).not.toContain('下一页');
    expect(html).not.toContain('第 1 页');
  });

  it('页脚左侧只写条数，不写合计（游标契约拿不到全量金额）', () => {
    const html = view(OWNER);
    expect(html).toContain('共 0 条');
    expect(html).not.toContain('合计');
  });
});

describe('三态齐全', () => {
  it('列表停在骨架态时容器与 tbody 都报 loading，空态行被 CSS 藏起来', () => {
    const html = view(OWNER);
    // v0.13 四态是同一份 DOM 靠 data-state 切显示，所以「空态文案不在 HTML 里」不再是判据；
    // 判据是容器/表体报 loading，且空态那行挂在 st-tr st-empty 上（CSS 只在该态之外才放它出来）。
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-label="列表加载中"');
    expect(html).toContain('st-tr st-empty');
  });

  it('身份读取失败时给提示，但仍显示分栏结构', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { enabled: false } },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ReversalsView
          scope={undefined}
          companyIds={[]}
          loading={false}
          error="网络不可达"
          onRetry={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('身份读取失败：网络不可达');
    expect(html).toContain('重试');
  });

  it('没有可用公司时开单按钮点不了（避免提交空 companyId）', () => {
    const html = view(OWNER, []);
    // 开单按钮 disabled 在 HTML 里是布尔属性
    expect(html).toContain('disabled');
  });
});

describe('完成入口（R / S）', () => {
  const PRODUCT_ID = '01900000-0000-7000-8000-0000000000p1';
  const BATCH_ID = '01900000-0000-7000-8000-0000000001b1';

  function customerReturn(status: CustomerReturn['status']): CustomerReturn {
    return {
      id: '01900000-0000-7000-8000-0000000000c1',
      tenantId: 't1',
      companyId: COMPANY,
      returnNo: 'R-0001-20261115-0001',
      originalSalesOrderId: '01900000-0000-7000-8000-0000000000e1',
      originalSettlementOrderId: null,
      returnType: '退货退款',
      onlyRefundKind: null,
      refundMode: '原路退款',
      status,
      refundAmount: '100',
      lines: [
        {
          productId: PRODUCT_ID,
          batchIds: [BATCH_ID],
          qty: '2',
          unitPrice: '50',
          amount: '100',
        },
      ],
      remark: null,
      version: 1,
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-15T00:00:00.000Z',
    };
  }

  function supplierReturn(status: SupplierReturn['status']): SupplierReturn {
    return {
      id: '01900000-0000-7000-8000-0000000000c1',
      tenantId: 't1',
      companyId: COMPANY,
      returnNo: 'S-0001-20261115-0001',
      originalPurchaseOrderId: '01900000-0000-7000-8000-0000000000a1',
      status,
      refundAmount: '1200',
      lines: [
        {
          productId: PRODUCT_ID,
          batchIds: [BATCH_ID],
          qty: '2',
          unitPrice: '600',
          amount: '1200',
        },
      ],
      remark: null,
      version: 1,
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-15T00:00:00.000Z',
    };
  }

  function renderCustomerDetail(
    status: CustomerReturn['status'],
    canApprove = true,
  ): string {
    const detail = customerReturn(status);
    const client = createQueryClient();
    client.setQueryData(reversalsQueryKeys.customerReturn(detail.id), detail);
    client.setQueryData(
      reversalsQueryKeys.customerReturns({
        companyId: COMPANY,
        status: undefined,
        keyword: undefined,
        cursor: null,
      }),
      { items: [detail], nextCursor: null },
    );
    client.setQueryData(reversalsQueryKeys.batches(COMPANY), {
      items: [],
      nextCursor: null,
    });
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CustomerReturnsPanel
          canCreate
          canApprove={canApprove}
          canViewPrice
          companyIds={[COMPANY]}
          companyId={COMPANY}
          onCompanyChange={() => {}}
          initialDetailId={detail.id}
        />
      </QueryClientProvider>,
    );
  }

  function renderSupplierDetail(
    status: SupplierReturn['status'],
    canApprove = true,
    canCancel = true,
  ): string {
    const detail = supplierReturn(status);
    const client = createQueryClient();
    client.setQueryData(reversalsQueryKeys.supplierReturn(detail.id), detail);
    client.setQueryData(
      reversalsQueryKeys.supplierReturns({
        companyId: COMPANY,
        status: undefined,
        keyword: undefined,
        cursor: null,
      }),
      { items: [detail], nextCursor: null },
    );
    client.setQueryData(reversalsQueryKeys.batches(COMPANY), {
      items: [],
      nextCursor: null,
    });
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SupplierReturnsPanel
          canCreate
          canApprove={canApprove}
          canViewPrice
          canCancel={canCancel}
          companyIds={[COMPANY]}
          companyId={COMPANY}
          onCompanyChange={() => {}}
          initialDetailId={detail.id}
        />
      </QueryClientProvider>,
    );
  }

  it('进行中的客户退货单详情渲染「完成」按钮', () => {
    const html = renderCustomerDetail('进行中');
    expect(html).toContain('完成');
    // 状态满足条件：不出现「仅进行中」的禁用提示
    expect(html).not.toContain('仅「进行中」状态的单据可完成');
  });

  it('进行中的供应商退货单详情渲染「完成」按钮', () => {
    const html = renderSupplierDetail('进行中');
    expect(html).toContain('完成');
    expect(html).not.toContain('仅「进行中」状态的单据可完成');
  });

  it('S 单是三类冲正里唯一能取消的：有 supplier_return.delete 才画「取消单据」', () => {
    expect(renderSupplierDetail('进行中')).toContain('取消单据');
    expect(renderSupplierDetail('进行中', true, false)).not.toContain(
      '取消单据',
    );
  });

  it('已完成的 S 单不给取消（cancel 端点只放行进行中）', () => {
    expect(renderSupplierDetail('已完成')).not.toContain('取消单据');
  });

  it('已完成的单据「完成」按钮禁用并说明原因', () => {
    const html = renderCustomerDetail('已完成');
    expect(html).toContain('完成');
    expect(html).toContain('仅「进行中」状态的单据可完成');
  });

  it('完成是审批动作：没有 customer_return.approve 时按钮禁用并写缺哪个权限点', () => {
    const html = renderCustomerDetail('进行中', false);
    expect(html).toContain('当前身份没有 customer_return.approve 权限');
    expect(html).not.toContain('customer_return.create 权限');
  });

  it('完成是审批动作：没有 supplier_return.approve 时按钮禁用并写缺哪个权限点', () => {
    const html = renderSupplierDetail('进行中', false);
    expect(html).toContain('当前身份没有 supplier_return.approve 权限');
    expect(html).not.toContain('supplier_return.create 权限');
  });
});
