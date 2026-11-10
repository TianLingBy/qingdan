import type { ScopeMatrix } from '@qingdan/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReversalsView } from './ReversalsPage';

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

const STOCKTAKE_READ_ONLY: ScopeMatrix = [{ domain: 'stocktake', actions: ['read'] }];

/** 有 R 单读写但没有看价（D79）——列表金额应显示破折号提示。 */
const CUSTOMER_NO_PRICE: ScopeMatrix = [
  { domain: 'customer_return', actions: ['read', 'create'] },
];

function view(scope: ScopeMatrix, companyIds: readonly string[] = [COMPANY]): string {
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
    expect(html).toContain('当前身份没有盘盈 / 盘亏权限（D71）');
  });

  it('盘盈盘亏权限齐了就不再提示缺权限', () => {
    const html = view([{ domain: 'stocktake', actions: ['read', 'create', 'delete'] }]);
    expect(html).not.toContain('当前身份没有盘盈 / 盘亏权限');
  });
});

describe('三态齐全', () => {
  it('列表停在骨架态时不下「没有数据」的结论', () => {
    const html = view(OWNER);
    expect(html).toContain('aria-label="列表加载中"');
    expect(html).not.toContain('还没有客户退货单');
  });

  it('身份读取失败时给提示，但仍显示分栏结构', () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
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
