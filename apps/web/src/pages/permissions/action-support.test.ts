import { describe, expect, it } from 'vitest';
import { actionSupport } from './action-support';

/**
 * #255：动作支撑度必须从契约路由表推导，不能写死在页面里。
 * 下面断言的是「契约当前登记了哪些 (domain, action)」这一事实；
 * 契约哪天补/挪了端点，改的是这里的断言，而不是页面里的映射表。
 */
describe('actionSupport（从契约路由表推导）', () => {
  it('契约里登记过 (domain, action) 的返回 has-endpoint', () => {
    expect(actionSupport('purchase', 'update')).toBe('has-endpoint');
    expect(actionSupport('internal_trade', 'ship')).toBe('has-endpoint');
    expect(actionSupport('internal_trade', 'approve')).toBe('has-endpoint');
    expect(actionSupport('stocktake', 'approve')).toBe('has-endpoint');
    expect(actionSupport('sales', 'read')).toBe('has-endpoint');
  });

  it('契约里没有该组合的返回 preauth-only', () => {
    // D94（#330）给 E 单补了签收完成（sales.approve）、给 A 单补了到货确认（purchase.approve），
    // 这两个域此前是「无端点，只能预授权」，现在都算真实端点；
    // 预授权态的样本改用供应商审（supplier.approve），目前确实没有端点。
    expect(actionSupport('supplier', 'approve')).toBe('preauth-only');
    // stocktake_page 只是页面域，契约里没有任何端点。
    expect(actionSupport('stocktake_page', 'read')).toBe('preauth-only');
    expect(actionSupport('purchase', 'approve')).toBe('has-endpoint');
    expect(actionSupport('sales', 'approve')).toBe('has-endpoint');
  });

  it('同一动作在不同域可以一个有一个没有（说明不是按动作写死）', () => {
    expect(actionSupport('internal_trade', 'approve')).toBe('has-endpoint');
    expect(actionSupport('employee', 'approve')).toBe('preauth-only');
    expect(actionSupport('sales', 'ship')).toBe('has-endpoint');
    expect(actionSupport('supplier', 'approve')).toBe('preauth-only');
  });
});
