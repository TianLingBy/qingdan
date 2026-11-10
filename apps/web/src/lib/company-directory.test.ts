import { describe, expect, it } from 'vitest';
import { buildCompanyNameMap, labelOfCompany, shortIdLabel } from './company-directory';

/**
 * 公司名簿纯函数部分。
 *
 * 口径与 `employee-directory` 一致：查到给「名称（码）」，查不到给**短 id**，
 * 空值给破折号——绝不让整串 UUID 或空串出现在界面上。
 */
const UUID = '01900000-0000-7000-8000-000000000002';

describe('buildCompanyNameMap', () => {
  it('公司码非空时显示「名称（码）」，便于和单据上的公司码对上', () => {
    const map = buildCompanyNameMap([{ id: 'c1', name: '演示公司', code: '0001' }]);
    expect(map.get('c1')).toBe('演示公司（0001）');
  });

  it('公司码缺失时只显示名称，不拼空括号', () => {
    const map = buildCompanyNameMap([{ id: 'c1', name: '演示公司', code: null }]);
    expect(map.get('c1')).toBe('演示公司');
  });
});

describe('labelOfCompany', () => {
  const map = buildCompanyNameMap([{ id: 'c1', name: '演示公司', code: '0001' }]);

  it('命中给「名称（码）」', () => {
    expect(labelOfCompany(map, 'c1')).toBe('演示公司（0001）');
  });

  it('未命中（无 company.read 权限 → 空表）退回**尾部**短 id，不露整串 UUID', () => {
    expect(labelOfCompany(map, UUID)).toBe('…000002');
  });

  it('同一批公司前 8 位相同，取尾部才分得清', () => {
    const first = labelOfCompany(map, UUID);
    const second = labelOfCompany(map, '01900000-0000-7000-8000-000000000003');
    expect(first).not.toBe(second);
  });

  it('空值给破折号', () => {
    expect(labelOfCompany(map, null)).toBe('—');
    expect(labelOfCompany(map, '')).toBe('—');
  });
});

describe('shortIdLabel', () => {
  it('超过 6 位才截断，省略号在前表示「前面省掉了」', () => {
    expect(shortIdLabel(UUID)).toBe('…000002');
    expect(shortIdLabel('abc')).toBe('abc');
  });
});
