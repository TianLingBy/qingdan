import type { ScopeMatrix } from '@qingdan/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FlowView, pathOf } from './FlowPage';
import { FLOW_DOCS } from './flow-map';

/**
 * 图页版式（#141 三条验收：口径、可点击、三态齐全）。
 *
 * 和别处一样用 `renderToStaticMarkup` 做静态断言，不引 jsdom——
 * 点击行为由 `href` 断言覆盖（真实点击在联调里验，见 PR 截图）。
 */

const OWNER_SCOPE: ScopeMatrix = [
  { domain: 'purchase', actions: ['read', 'create'] },
  { domain: 'processing', actions: ['read', 'create'] },
  { domain: 'sales', actions: ['read', 'create', 'view_price'] },
  { domain: 'settlement', actions: ['read', 'approve'] },
  { domain: 'internal_trade', actions: ['read'] },
  { domain: 'customer_return', actions: ['read'] },
  { domain: 'supplier_return', actions: ['read'] },
  { domain: 'stocktake', actions: ['read', 'approve'] },
];

/** 种子里的销售岗位：只有销售、客户、商品、库存数量、结算的读权限。 */
const SALES_SCOPE: ScopeMatrix = [
  { domain: 'sales', actions: ['read', 'create', 'update', 'view_price'] },
  { domain: 'customer', actions: ['read', 'create', 'update'] },
  { domain: 'product', actions: ['read'] },
  { domain: 'inventory_qty', actions: ['read'] },
  { domain: 'settlement', actions: ['read'] },
];

function view(scope: ScopeMatrix | undefined, extra: Partial<Parameters<typeof FlowView>[0]> = {}) {
  return renderToStaticMarkup(
    <FlowView
      scope={scope}
      loading={false}
      error={null}
      onRetry={() => {}}
      onOpen={() => {}}
      {...extra}
    />,
  );
}

describe('主线与辅助节点', () => {
  it('八个单据都渲染出来，代号与名称成对出现', () => {
    const html = view(OWNER_SCOPE);
    for (const node of FLOW_DOCS) {
      expect(html, `缺少节点 ${node.code}`).toContain(node.name);
    }
    expect(html).toContain('主线：一张货的流向');
    expect(html).toContain('辅助与冲正');
  });

  it('两个断点标在连接带上，另有「链路断点」小节写清为什么断', () => {
    const html = view(OWNER_SCOPE);
    expect(html).toContain('未接 · 原料入库');
    expect(html).toContain('未接 · 产出结转');
    expect(html).toContain('链路断点（2 处）');
    expect(html).toContain('没有批次创建端点');
    expect(html).toContain('成品批次不会因加工而出现');
    // 断点不是单据：这两段说明里不出现任何跳转链接
    const section = html.slice(html.indexOf('链路断点'), html.indexOf('辅助与冲正'));
    expect(section).not.toContain('<a ');
  });

  it('批次口径写成一句能核对的话，不写示例金额', () => {
    const html = view(OWNER_SCOPE);
    expect(html).toContain('可用量 = 入库量 − 在途占用 − 待执行占用');
    expect(html).not.toContain('¥');
  });
});

describe('节点可点击性按权限决定', () => {
  it('老板：八个入口都有 href', () => {
    const html = view(OWNER_SCOPE);
    for (const node of FLOW_DOCS) {
      expect(html, `${node.code} 应该可点`).toContain(`href="${pathOf(node)}"`);
    }
  });

  it('销售：只有销售单与结算单可点，采购 / 加工 / 冲正的卡片没有链接', () => {
    const html = view(SALES_SCOPE);
    expect(html).toContain('href="/sales-orders"');
    expect(html).toContain('href="/settlements"');
    expect(html).not.toContain('href="/purchase-orders"');
    expect(html).not.toContain('href="/processing-orders"');
    expect(html).not.toContain('href="/reversals"');
    expect(html).not.toContain('href="/stocktakes"');
    // 卡片还在，只是虚线框 + 标「无权限」（图对全员开放，D44）
    expect(html).toContain('采购单');
    expect(html).toContain('加工单');
    expect(html).toContain('无权限');
  });

  it('一个单据权限都没有时，给出说明而不是空白页', () => {
    const html = view([]);
    expect(html).toContain('当前身份没有任何单据权限');
    expect(html).not.toContain('href="/sales-orders"');
  });
});

describe('三种状态', () => {
  it('加载中只出骨架，不出「无权限」的结论', () => {
    const html = view(undefined, { loading: true });
    expect(html).not.toContain('当前身份没有任何单据权限');
    expect(html).not.toContain('href="/sales-orders"');
    expect(html).toContain('animate-pulse');
  });

  it('身份读取失败时给可重试提示，并说明入口可用性暂不可判', () => {
    const html = view(undefined, { error: '网络不可达' });
    expect(html).toContain('身份读取失败');
    expect(html).toContain('网络不可达');
    expect(html).toContain('重试');
  });

  it('失败时节点保持可点：不把「读不到身份」当成「没权限」', () => {
    const html = view(undefined, { error: '网络不可达' });
    expect(html).toContain('href="/sales-orders"');
  });
});

describe('落地情况表', () => {
  it('每个单据一行，缺什么写清楚', () => {
    const html = view(OWNER_SCOPE);
    expect(html).toContain('落地情况');
    // B 单的完成缺口
    expect(html).toContain('端点已登记，调用返回 501');
    // 「有意不做」单列，不和缺口混在一起
    expect(html).toContain('有意不做');
    expect(html).toContain('一期一单一次结算');
    // 页面状态
    expect(html).toContain('已上线');
    expect(html).toContain('占位页');
  });
});
