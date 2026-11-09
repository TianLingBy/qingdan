import { describe, expect, it, vi } from 'vitest';
import { internalTradesApi } from '../internal-trades/internal-trades-api';
import { salesApi } from '../sales/sales-api';
import {
  CONFIRM_BLOCK_TEXT,
  SETTLEMENT_SOURCE_LABEL,
  SETTLEMENT_STATES,
  commissionNote,
  confirmBlockedText,
  fetchSourceDocNo,
  fetchSourceDocNoMap,
  formatCommissionRate,
  formatRate,
  lossNote,
  ownerLabel,
  sourceDocText,
} from './settlements-api';

// 来源单单号解析要跨模块取来源单详情 / 列表，这里把两个 api 换成桩（真实请求在联调里验证）。
vi.mock('../sales/sales-api', () => ({ salesApi: { detail: vi.fn(), list: vi.fn() } }));
vi.mock('../internal-trades/internal-trades-api', () => ({
  internalTradesApi: { detail: vi.fn(), list: vi.fn() },
}));

/**
 * 结算单 C 的展示口径测试。
 *
 * 这里只测「前端能自己判断的部分」：两态枚举、毛利率是比例不是百分比、脱敏用 — 不用 0。
 * 毛利 / 净毛利 / 提成金额都是服务端计算值，前端不重算（D5 / D33 / D36）。
 */

describe('C 单是独立两态（D2③ / D19）', () => {
  it('只有待确认 / 已结算，没有进行中、没有已取消', () => {
    expect(SETTLEMENT_STATES).toEqual(['待确认', '已结算']);
    expect(SETTLEMENT_STATES).not.toContain('已取消');
    expect(SETTLEMENT_STATES).not.toContain('进行中');
  });

  it('来源单只可能是 E / N（D29）', () => {
    expect(Object.keys(SETTLEMENT_SOURCE_LABEL)).toEqual(['E', 'N']);
    expect(SETTLEMENT_SOURCE_LABEL.E).toBe('销售单 E');
    expect(SETTLEMENT_SOURCE_LABEL.N).toBe('内部交易单 N');
  });
});

describe('毛利率是比例，不是百分比数字', () => {
  it('0.5 显示成 50.00%', () => {
    expect(formatRate('0.5')).toBe('50.00%');
  });

  it('负毛利照原样带负号（D5：毛利可为负）', () => {
    expect(formatRate('-0.25')).toBe('-25.00%');
  });

  it('无看价权限时是破折号，不是 0%', () => {
    expect(formatRate(null)).toBe('—');
  });

  it('提成比例同样按比例换算（0.05 = 5%）', () => {
    expect(formatCommissionRate('0.05')).toBe('5.00%');
    expect(formatCommissionRate('0')).toBe('0.00%');
  });
});

describe('脱敏与不可确认的原因（D78 / D19）', () => {
  it('不可确认原因只认服务端结论', () => {
    expect(confirmBlockedText(null)).toBeNull();
    expect(confirmBlockedText('already_settled')).toBe(CONFIRM_BLOCK_TEXT.already_settled);
    expect(confirmBlockedText('whatever')).toBe('当前状态不可确认');
  });
});

describe('来源单与提成归属人（契约只回 id）', () => {
  it('来源单显示「类型 + id 前 8 位」', () => {
    expect(sourceDocText('E', '01a1bf69-545e-7265-b209-ff4f133e169e')).toBe('销售单 E · 01a1bf69');
  });

  it('详情拿到来源单单号时显示真实单号，不再露 id 前缀', () => {
    expect(
      sourceDocText('E', '01a1bf69-545e-7265-b209-ff4f133e169e', 'E-0001-20261109-0002'),
    ).toBe('销售单 E · E-0001-20261109-0002');
    expect(sourceDocText('N', 'abc', null)).toBe('内部交易单 N · abc');
  });

  it('提成归属人为空时是破折号，不是 undefined', () => {
    expect(ownerLabel(null)).toBe('—');
    expect(ownerLabel('01900000-0000-7000-8000-000000000021')).toBe('01900000');
  });
});

describe('来源单单号解析（C 单契约没有 sourceDocNo）', () => {
  it('E 单走销售单详情，N 单走内部交易单详情', async () => {
    vi.mocked(salesApi.detail).mockResolvedValueOnce({ orderNo: 'E-0001-20261109-0002' } as never);
    vi.mocked(internalTradesApi.detail).mockResolvedValueOnce({
      orderNo: 'N-0001-20261109-0001',
    } as never);

    await expect(fetchSourceDocNo('E', 'e-1')).resolves.toBe('E-0001-20261109-0002');
    await expect(fetchSourceDocNo('N', 'n-1')).resolves.toBe('N-0001-20261109-0001');
    expect(salesApi.detail).toHaveBeenCalledWith('e-1');
    expect(internalTradesApi.detail).toHaveBeenCalledWith('n-1');
  });

  it('没有来源单读权限（403）时吞掉错误回 null，退回 id 前缀', async () => {
    vi.mocked(salesApi.detail).mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(fetchSourceDocNo('E', 'e-1')).resolves.toBeNull();
  });

  it('列表用批量映射：按类型各拉一页来源单，建成 id → 单号', async () => {
    vi.mocked(salesApi.list).mockResolvedValueOnce({
      items: [{ id: 'e-1', orderNo: 'E-0001-20261109-0002' }],
      nextCursor: null,
    } as never);

    const map = await fetchSourceDocNoMap('E');

    expect(salesApi.list).toHaveBeenCalledWith({ limit: 200 });
    expect(map.get('e-1')).toBe('E-0001-20261109-0002');
    expect(map.size).toBe(1);
  });

  it('批量映射拿不到（403 / 网络）时回空表，列表退回 id 前缀而不是整页报错', async () => {
    vi.mocked(internalTradesApi.list).mockRejectedValueOnce(new Error('403 Forbidden'));
    const map = await fetchSourceDocNoMap('N');
    expect(map.size).toBe(0);
    expect(map.get('n-1')).toBeUndefined();
  });
});

describe('提成与损失的口径说明', () => {
  it('比例与金额都是 0 时说明「没配比例」，而不是让人以为算错（D77 ②）', () => {
    const note = commissionNote('0', '0');
    expect(note).toContain('提成比例为 0');
    expect(note).toContain('D77');
  });

  it('有比例时不多嘴', () => {
    expect(commissionNote('0.05', '10')).toBeNull();
    // 金额被遮罩（null）但比例不为 0 时也不该说「没配比例」
    expect(commissionNote('0.05', null)).toBeNull();
  });

  it('相关损失为 0 时不解释净毛利差在哪', () => {
    expect(lossNote('100', '0')).toBeNull();
    expect(lossNote('100', null)).toBeNull();
    expect(lossNote('100', '30')).toContain('本单相关损失');
  });
});
