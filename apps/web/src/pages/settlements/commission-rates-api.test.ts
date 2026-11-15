import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import {
  describeCommissionRateError,
  formatRatePercent,
  percentToRate,
  todayIsoDate,
} from './commission-rates-api';

/**
 * 提成比例配置的口径测试。
 *
 * 重点不在「能不能跑通」，而在两条容易错的口径：
 * 1. 百分比 ↔ decimal 的换算**不能过浮点**（D54）：`0.07 × 100` 用 number 会得 7.000000000000001；
 * 2. 409 在这个域里**不是版本冲突**（配置行没有版本列），文案不能说「这张单已被别人改过」。
 */

describe('percentToRate', () => {
  it('整数百分比 → 两位小数 decimal', () => {
    expect(percentToRate('5')).toBe('0.05');
    expect(percentToRate('100')).toBe('1');
    expect(percentToRate('0')).toBe('0');
  });

  it('带小数的百分比按定点换算，不产生浮点尾巴', () => {
    expect(percentToRate('7.5')).toBe('0.075');
    expect(percentToRate('0.125')).toBe('0.00125');
    // 用 number 算 0.07 / 100 会得到 0.0007000000000000001
    expect(percentToRate('0.07')).toBe('0.0007');
    // 4 位小数是上限：换算后正好 6 位，落在 numeric(18,6) 上
    expect(percentToRate('12.3456')).toBe('0.123456');
  });

  it('超过 100% 一律拒绝，不静默截断成 1', () => {
    expect(percentToRate('100.1')).toBeNull();
    expect(percentToRate('101')).toBeNull();
    expect(percentToRate('1000')).toBeNull();
  });

  it('超过 4 位小数、负数、非数字、空串都返回 null（绝不返回 0 顶替）', () => {
    expect(percentToRate('0.00001')).toBeNull();
    expect(percentToRate('-5')).toBeNull();
    expect(percentToRate('abc')).toBeNull();
    expect(percentToRate('')).toBeNull();
    expect(percentToRate('  ')).toBeNull();
    expect(percentToRate('1e2')).toBeNull();
  });

  it('容忍首尾空格（用户从 Excel 粘过来常见）', () => {
    expect(percentToRate(' 5 ')).toBe('0.05');
  });
});

describe('formatRatePercent', () => {
  it('不足 2 位小数补 0，与详情页的快照展示对齐', () => {
    expect(formatRatePercent('0.05')).toBe('5.00%');
    expect(formatRatePercent('0')).toBe('0.00%');
    expect(formatRatePercent('1')).toBe('100.00%');
  });

  it('超过 2 位小数按实际值展示，不截断成「看起来配错了」的数', () => {
    expect(formatRatePercent('0.123456')).toBe('12.3456%');
    expect(formatRatePercent('0.003456')).toBe('0.3456%');
    // 0.125 不该显示成 12.50%（补 0 可以，但不能丢掉有效位）
    expect(formatRatePercent('0.125')).toBe('12.50%');
  });
});

describe('describeCommissionRateError', () => {
  const apiError = (code: string, status: number, message = '服务端原文') =>
    new ApiError({ code, status, message });

  it('409 说「这个生效日已有配置」，不能说成「这张单被别人改过」', () => {
    const text = describeCommissionRateError(apiError('VERSION_CONFLICT', 409));
    expect(text).toContain('已经有配置');
    expect(text).toContain('生效日');
    expect(text).not.toContain('这张单已被别人改过');
    expect(text).not.toContain('版本过期');
  });

  it('422 指向「员工不属于该公司 / 比例越界」两个真实原因（D80 / D54）', () => {
    const text = describeCommissionRateError(apiError('VALIDATION_FAILED', 422));
    expect(text).toContain('员工不属于所选公司');
    expect(text).toContain('0–100%');
  });

  it('404 说明「别人先删了」，刷新即可（删除幂等语义）', () => {
    expect(describeCommissionRateError(apiError('NOT_FOUND', 404))).toContain('别人先删了');
  });

  it('403 点明需要哪个权限域', () => {
    const text = describeCommissionRateError(apiError('FORBIDDEN', 403));
    expect(text).toContain('commission.read');
  });

  it('未知码保留服务端原文与 code，便于贴给后端定位', () => {
    expect(describeCommissionRateError(apiError('INTERNAL_ERROR', 500, '数据库炸了'))).toBe(
      '数据库炸了（INTERNAL_ERROR）',
    );
  });

  it('非 ApiError（网络中断）用 error.message 兜底，不用内部措辞', () => {
    expect(describeCommissionRateError(new TypeError('Failed to fetch'))).toBe('Failed to fetch');
    expect(describeCommissionRateError(undefined)).toBe('操作失败，请稍后重试');
  });
});

describe('todayIsoDate', () => {
  it('按本地时区取日期（不能用 toISOString，晚 8 点后会变成昨天）', () => {
    // 2026-11-12 23:30 本地时间
    expect(todayIsoDate(new Date(2026, 10, 12, 23, 30))).toBe('2026-11-12');
    // 2026-01-05 00:10 本地时间（补零）
    expect(todayIsoDate(new Date(2026, 0, 5, 0, 10))).toBe('2026-01-05');
  });
});
