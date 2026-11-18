/**
 * 发起收款面板的「不该出现」（#101 / #386）。
 *
 * 只测 SSR 首屏能观察到的三态：无看价权限、无收款权限、正常初始态。
 * **点开二维码之后的界面测不到** —— `renderToStaticMarkup` 不跑 effect，
 * `QRCodeSVG` 与倒计时都不会出现在静态 HTML 里。那部分靠 `payments-api.test.ts`
 * 咬住请求形状，加上 E 盘真环境手点验证。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaymentRequestPanel } from './PaymentRequestPanel';

function view(overrides: { canCreate?: boolean; canViewPrice?: boolean } = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PaymentRequestPanel
        orderId="o1"
        canCreate={overrides.canCreate ?? true}
        canViewPrice={overrides.canViewPrice ?? true}
        onClose={() => undefined}
        onPaid={() => undefined}
        onError={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe('发起收款面板', () => {
  it('无看价权限：不画二维码，直接说明为什么不能发起', () => {
    const html = view({ canViewPrice: false });
    expect(html).toContain('无「看价」权限，不能发起收款');
    // 关键：这时候连「生成收款二维码」按钮都不该有 —— 点了会得到一个「¥ —」的二维码。
    expect(html).not.toContain('生成收款二维码');
  });

  it('有看价但没有 payment.create：置灰并说清缺哪个权限点', () => {
    const html = view({ canCreate: false });
    expect(html).toContain('发起收款需要 payment.create 权限');
    expect(html).not.toContain('生成收款二维码');
  });

  it('两样都有：初始态给渠道选择与「生成收款二维码」，且此时没有二维码', () => {
    const html = view();
    expect(html).toContain('生成收款二维码');
    expect(html).toContain('微信');
    expect(html).toContain('支付宝');
    // 首屏不该出现任何二维码图形：还没发起。
    expect(html).not.toContain('<svg');
  });

  it('金额输入框不存在 —— 收多少由服务端按应收余额算', () => {
    const html = view();
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('inputMode="decimal"');
  });
});
