import { describe, expect, it } from 'vitest';
import { toYaml } from './yaml.js';

describe('toYaml', () => {
  it('键按插入顺序、2 空格缩进、数组用 - 形式', () => {
    expect(toYaml({ b: 1, a: { c: true, d: null }, list: ['x', 'z'] })).toBe(
      'b: 1\na:\n  c: true\n  d: null\nlist:\n  - x\n  - z\n',
    );
  });

  it('空对象 / 空数组 / null 写成单行', () => {
    expect(toYaml({ a: {}, b: [], c: null })).toBe('a: {}\nb: []\nc: null\n');
  });

  it('对象数组：首个键跟在 - 后，其余键与首个键对齐', () => {
    expect(toYaml({ parameters: [{ name: 'id', in: 'path', required: true }] })).toBe(
      'parameters:\n  - name: id\n    in: path\n    required: true\n',
    );
  });

  it('含 : 或 # 的字符串加双引号，并转义内部双引号', () => {
    expect(toYaml({ a: 'a: b', b: 'x # y', c: 'k: "v"' })).toBe(
      'a: "a: b"\nb: "x # y"\nc: "k: \\"v\\""\n',
    );
  });

  it('行首指示符（- ? * & ! | > @ `）都加双引号', () => {
    for (const ch of ['-', '?', '*', '&', '!', '|', '>', '@', '`']) {
      expect(toYaml({ [ch]: ch }), ch).toBe(`"${ch}": "${ch}"\n`);
    }
  });

  it('前导 / 尾随空格与空串加双引号', () => {
    expect(toYaml({ a: ' x', b: 'x ', c: '' })).toBe('a: " x"\nb: "x "\nc: ""\n');
  });

  it('看起来像数字 / 布尔 / null 的字符串加双引号', () => {
    expect(toYaml({ a: '123', b: '1.5', c: 'true', d: 'null', e: 'yes', f: '0x1f' })).toBe(
      'a: "123"\nb: "1.5"\nc: "true"\nd: "null"\ne: "yes"\nf: "0x1f"\n',
    );
  });

  it('普通字符串不加引号', () => {
    expect(toYaml({ a: 'hello', b: 'api_integration', c: '3.1.0', d: '/api/v1/health' })).toBe(
      'a: hello\nb: api_integration\nc: 3.1.0\nd: /api/v1/health\n',
    );
  });

  it('换行 / tab / 控制字符走双引号转义，输出里没有裸 tab', () => {
    const out = toYaml({ a: 'line1\nline2', b: 'tab\there', c: `x${String.fromCharCode(1)}y` });
    expect(out).toBe('a: "line1\\nline2"\nb: "tab\\there"\nc: "x\\u0001y"\n');
    expect(out).not.toContain('\t');
  });

  it('数字形式的 mapping key 加引号（响应码等必须保持字符串）', () => {
    expect(toYaml({ '200': { description: 'ok' }, default: {} })).toBe(
      '"200":\n  description: ok\ndefault: {}\n',
    );
  });

  it('嵌套数组不输出 tab，保持 2 空格缩进', () => {
    expect(toYaml({ rows: [[1, 2], [3]] })).toBe('rows:\n  -\n    - 1\n    - 2\n  -\n    - 3\n');
  });
});
