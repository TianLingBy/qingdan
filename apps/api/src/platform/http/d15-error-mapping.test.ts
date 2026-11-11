import { describe, expect, it } from 'vitest';
import { isD15Violation } from './errors.js';

/** 数据库级 D15 违规的识别口径：只认 23514 + `D15:` 前缀，别把别的约束误映射成 422。 */
describe('isD15Violation', () => {
  it('识别触发器抛出的 23514 + D15 前缀', () => {
    expect(isD15Violation({ code: '23514', message: 'D15: 商品 a 属于公司 b，不属于采购单公司 c' })).toBe(
      true,
    );
  });

  it('其它 check 约束违规不当作 D15', () => {
    expect(isD15Violation({ code: '23514', message: 'new row violates check constraint' })).toBe(false);
  });

  it('别的错误码即使带 D15 字样也不认', () => {
    expect(isD15Violation({ code: '23503', message: 'D15: 外键缺失' })).toBe(false);
  });

  it('非对象/空值安全', () => {
    expect(isD15Violation(null)).toBe(false);
    expect(isD15Violation(new Error('D15: 手写的'))).toBe(false);
  });
});
