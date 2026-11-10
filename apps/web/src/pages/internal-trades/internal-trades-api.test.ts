import { describe, expect, it } from 'vitest';
import {
  INTERNAL_TRADE_STATES,
  canEdit,
  internalPriceGap,
  lineAmountOf,
  linesTotal,
  totalLineQty,
  tradeRouteText,
  updateInputOf,
  validateDraft,
  type InternalTradeLineDraft,
} from './internal-trades-api';

/**
 * N 单的口径测试（四态、内部价手填、明细引发出公司批次）。
 *
 * 这里只测「前端能自己判断的部分」：必填项、发出≠接收、内部价可 0 但要手填、
 * 金额定点运算。状态推进与批次归属一律以服务端为准，不在这里重算。
 */

const LINE: InternalTradeLineDraft = {
  productId: '00000000-0000-4000-8000-000000000101',
  batchIds: ['00000000-0000-4000-8000-000000000401'],
  qty: '10',
  unitPrice: '12.5',
};

const DRAFT = {
  fromCompanyId: '00000000-0000-4000-8000-000000000001',
  toCompanyId: '00000000-0000-4000-8000-000000000002',
  handlerId: '00000000-0000-4000-8000-000000000021',
  internalPrice: '125',
  lines: [LINE],
};

describe('N 单是独立四态，不是单据三态（D68②）', () => {
  it('四态里含「在途」，且顺序与契约一致', () => {
    expect(INTERNAL_TRADE_STATES).toEqual(['进行中', '在途', '已完成', '已取消']);
    expect(INTERNAL_TRADE_STATES).toContain('在途');
    expect(INTERNAL_TRADE_STATES).toHaveLength(4);
  });

  it('只有「进行中」能改单：在途的货已经锁走，改明细会跟锁定量对不上', () => {
    expect(canEdit('进行中')).toBe(true);
    expect(canEdit('在途')).toBe(false);
    expect(canEdit('已完成')).toBe(false);
    expect(canEdit('已取消')).toBe(false);
  });
});

describe('提交前校验', () => {
  it('完整草稿通过', () => {
    expect(validateDraft(DRAFT)).toEqual([]);
  });

  it('发出公司与接收公司相同直接拦下', () => {
    const errors = validateDraft({ ...DRAFT, toCompanyId: DRAFT.fromCompanyId });
    expect(errors.some((item) => item.includes('不能相同'))).toBe(true);
  });

  it('内部价必须手工填，不能留空（D68①）', () => {
    const errors = validateDraft({ ...DRAFT, internalPrice: '  ' });
    expect(errors.some((item) => item.includes('内部价必须手工填写'))).toBe(true);
  });

  it('内部价允许 0（内部调拨不收钱），但不接受负数', () => {
    expect(validateDraft({ ...DRAFT, internalPrice: '0' })).toEqual([]);
    const errors = validateDraft({ ...DRAFT, internalPrice: '-1' });
    expect(errors.some((item) => item.includes('非负数字'))).toBe(true);
  });

  it('明细至少 1 行，每行必须引发出公司批次（D22）', () => {
    expect(validateDraft({ ...DRAFT, lines: [] })).toContain('内部交易单至少 1 行商品明细');
    const errors = validateDraft({ ...DRAFT, lines: [{ ...LINE, batchIds: [] }] });
    expect(errors.some((item) => item.includes('至少引用 1 个发出公司批次'))).toBe(true);
  });

  it('数量必须大于 0，单价可以是非负', () => {
    const errors = validateDraft({
      ...DRAFT,
      lines: [{ ...LINE, qty: '0', unitPrice: '0' }],
    });
    expect(errors.some((item) => item.includes('数量必须大于 0'))).toBe(true);
    expect(errors.some((item) => item.includes('单价'))).toBe(false);
  });
});

describe('金额与数量（定点，不用浮点）', () => {
  it('0.1 × 3 = 0.3，不是 0.30000000000000004', () => {
    expect(lineAmountOf({ ...LINE, qty: '0.1', unitPrice: '3' })).toBe('0.3');
  });

  it('明细合计与总数量', () => {
    expect(linesTotal([LINE, { ...LINE, qty: '2' }])).toBe('150');
    expect(totalLineQty([LINE, { ...LINE, qty: '2.5' }])).toBe('12.5');
  });

  it('非法数量 / 单价按 0 计，不抛错也不显示 NaN', () => {
    expect(lineAmountOf({ ...LINE, qty: '', unitPrice: '12' })).toBe('0');
  });
});

describe('内部价与明细合计的关系（D68①）', () => {
  it('一致时不给提示', () => {
    expect(internalPriceGap('125', [LINE])).toBeNull();
  });

  it('不一致时只如实说明允许手填，不自己「纠正」', () => {
    const text = internalPriceGap('150', [LINE]);
    expect(text).toContain('不一致');
    expect(text).toContain('D68①');
  });

  it('内部价还没填完时不下结论', () => {
    expect(internalPriceGap('', [LINE])).toBeNull();
  });
});

describe('改单入参只带契约允许的三个字段', () => {
  it('不含发出 / 接收公司（本批不开放变更）', () => {
    const input = updateInputOf([LINE], '125', '00000000-0000-4000-8000-000000000021');
    expect(Object.keys(input).sort()).toEqual(['handlerId', 'internalPrice', 'lines']);
    expect(input.lines?.[0]?.amount).toBe('125');
  });
});

describe('展示口径', () => {
  it('方向一列讲清「从哪到哪」', () => {
    expect(tradeRouteText({ fromCompanyName: '演示公司', toCompanyName: '二公司' })).toBe(
      '演示公司 → 二公司',
    );
  });
});
