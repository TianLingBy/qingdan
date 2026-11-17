import { describe, expect, it } from 'vitest';
import { orderEditBlockedText } from './order-edit-guard';

/**
 * 单据「编辑」按钮三态口径（#261 定在加工单上，这里推广到采购单 / 销售单）。
 *
 * 三条分支的**顺序**本身就是要测的东西：没权限的人不该先听到「状态不对」，
 * 否则他会去等单据状态变化，而真正该做的是找管理员配权限。
 */
describe('orderEditBlockedText', () => {
  const ready = { canUpdate: true, canViewPrice: true, status: '进行中' } as const;

  it('权限齐 + 进行中 → 可点（返回 null）', () => {
    expect(orderEditBlockedText({ domain: 'purchase', ...ready })).toBeNull();
    expect(orderEditBlockedText({ domain: 'sales', ...ready })).toBeNull();
  });

  it('缺 update：先报权限，不报状态', () => {
    expect(
      orderEditBlockedText({ domain: 'purchase', ...ready, canUpdate: false, status: '已完成' }),
    ).toBe('当前身份没有 purchase.update 权限');
    expect(
      orderEditBlockedText({ domain: 'sales', ...ready, canUpdate: false }),
    ).toBe('当前身份没有 sales.update 权限');
  });

  it('有 update 但无看价：说清看不到单价就没法改单，并给出权限点', () => {
    expect(
      orderEditBlockedText({ domain: 'sales', ...ready, canViewPrice: false }),
    ).toBe('无看价权限：看不到单价就没法改单（sales.view_price）');
    expect(
      orderEditBlockedText({ domain: 'purchase', ...ready, canViewPrice: false }),
    ).toContain('purchase.view_price');
  });

  it('权限齐但状态不对：带出单据名与当前状态', () => {
    expect(orderEditBlockedText({ domain: 'purchase', ...ready, status: '已完成' })).toBe(
      '只有「进行中」的采购单能编辑，当前是「已完成」',
    );
    expect(orderEditBlockedText({ domain: 'sales', ...ready, status: '已取消' })).toBe(
      '只有「进行中」的销售单能编辑，当前是「已取消」',
    );
  });

  it('两种单据的文案不串：采购单不会说出销售单的权限点', () => {
    const purchase = orderEditBlockedText({ domain: 'purchase', ...ready, canUpdate: false });
    expect(purchase).toContain('purchase.');
    expect(purchase).not.toContain('sales.');
  });
});
