import { describe, expect, it } from 'vitest';
import { allocatePurchaseFees } from './fee-allocation.js';

/**
 * A 单费用分摊（D83 / #272）：按明细金额占比摊、末行承接余数、按数量退化、零数量跳过。
 *
 * 纯函数测试，不碰数据库；集成行为（批次落库 + 审计）见
 * `apps/api/src/modules/purchase/usecases/purchase-orders-complete.test.ts`。
 */

const line = (lineNo: number, qty: string, unitPrice: string) => ({ lineNo, qty, unitPrice });

function sumShares(lines: readonly { feeShare: string }[]): string {
  // 用 6 位定点整数累加，避免测试自身引入浮点。
  const total = lines.reduce((sum, row) => {
    const [whole = '0', fraction = ''] = row.feeShare.split('.');
    const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
    return sum + micro;
  }, 0n);
  const whole = total / 1_000_000n;
  const fraction = (total % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

describe('allocatePurchaseFees', () => {
  it('单行 + 正费用：摊后单价 = (行金额 + 费用) / 数量', () => {
    const result = allocatePurchaseFees([line(1, '2', '12.5')], ['5']);

    expect(result).toMatchObject({ basis: 'byAmount', feeTotal: '5' });
    expect(result.lines).toEqual([
      { lineNo: 1, qty: '2', unitPrice: '12.5', feeShare: '5', adjustedUnitCost: '15' },
    ]);
  });

  it('多行按金额占比摊，末行承接余数，SUM(share) 精确等于 feeTotal', () => {
    const result = allocatePurchaseFees(
      [line(1, '1', '1'), line(2, '1', '1'), line(3, '1', '1')],
      ['10'],
    );

    expect(result.basis).toBe('byAmount');
    expect(result.lines.map((row) => row.feeShare)).toEqual(['3.333333', '3.333333', '3.333334']);
    expect(result.lines.map((row) => row.adjustedUnitCost)).toEqual([
      '4.333333',
      '4.333333',
      '4.333334',
    ]);
    expect(sumShares(result.lines)).toBe(result.feeTotal);
    expect(sumShares(result.lines)).toBe('10');
  });

  it('行金额合计为 0 时退化为按数量占比，末行承接余数', () => {
    const result = allocatePurchaseFees([line(1, '2', '0'), line(2, '3', '0')], ['10']);

    expect(result.basis).toBe('byQty');
    expect(result.lines.map((row) => row.feeShare)).toEqual(['4', '6']);
    expect(result.lines.map((row) => row.adjustedUnitCost)).toEqual(['2', '2']);
    expect(sumShares(result.lines)).toBe('10');
  });

  it('无费用时摊后单价严格等于明细单价（不因 6 位落库反算而漂移）', () => {
    const result = allocatePurchaseFees([line(1, '0.1', '0.333333'), line(2, '3', '12.5')], []);

    expect(result.feeTotal).toBe('0');
    expect(result.lines.map((row) => row.adjustedUnitCost)).toEqual(['0.333333', '12.5']);
  });

  it('数量为 0 的行跳过，不参与分摊也不出现在结果里', () => {
    const result = allocatePurchaseFees([line(1, '0', '10'), line(2, '2', '5')], ['3']);

    expect(result.lines).toEqual([
      { lineNo: 2, qty: '2', unitPrice: '5', feeShare: '3', adjustedUnitCost: '6.5' },
    ]);
  });

  it('全零金额 + 全零数量：没有可建批次的明细，份额为空', () => {
    const result = allocatePurchaseFees([line(1, '0', '0')], ['5']);

    expect(result).toMatchObject({ basis: 'byQty', feeTotal: '5', lines: [] });
  });
});
