import { describe, expect, it } from 'vitest';
import { buildEmployeeNameMap, shortIdLabel } from './employee-directory';

/**
 * 姓名簿的纯函数部分（`useEmployeeLabel` 的取值逻辑同源）。
 *
 * 这里只测「建表 + 兜底」两条确定性规则：
 * - 命中给姓名；
 * - 未命中 / 空值 / 无权限（空表）→ 短 id 或破折号，**绝不返回空串**。
 */
describe('员工姓名簿', () => {
  it('按 id 建姓名表', () => {
    const map = buildEmployeeNameMap([
      { id: 'e1', name: '张明' },
      { id: 'e2', name: '李强' },
    ]);

    expect(map.get('e1')).toBe('张明');
    expect(map.get('e3')).toBeUndefined();
  });

  it('姓名两端空白会裁掉，空姓名的员工不进表（避免显示成一格白）', () => {
    const map = buildEmployeeNameMap([
      { id: 'e1', name: '  王芳 ' },
      { id: 'e2', name: '   ' },
    ]);

    expect(map.get('e1')).toBe('王芳');
    expect(map.has('e2')).toBe(false);
  });

  it('同一 id 重复出现时以最后一条为准（不抛错）', () => {
    const map = buildEmployeeNameMap([
      { id: 'e1', name: '旧名' },
      { id: 'e1', name: '新名' },
    ]);

    expect(map.get('e1')).toBe('新名');
    expect(map.size).toBe(1);
  });

  it('短 id 兜底：超过 8 位截断加省略号，8 位以内原样', () => {
    expect(shortIdLabel('01900000-0000-7000-8000-000000000021')).toBe('01900000…');
    expect(shortIdLabel('abcdefgh')).toBe('abcdefgh');
    expect(shortIdLabel('abc')).toBe('abc');
  });

  it('空表（无员工读权限 403 的降级结果）建出空表，不是 undefined', () => {
    const map = buildEmployeeNameMap([]);

    expect(map.size).toBe(0);
    expect(map.get('e1')).toBeUndefined();
  });
});
