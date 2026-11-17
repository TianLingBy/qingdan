import { describe, expect, it } from 'vitest';
import { csvEscape, toCsv } from './csv.js';

/**
 * CSV 拼装单元测试（#342）。
 *
 * 重点不是「能拼出逗号分隔的字符串」，而是三条安全 / 兼容规则：
 * - 公式注入：以 `= + - @` 或制表 / 回车开头的单元格必须加单引号前缀，
 *   否则 Excel 打开就把客户名当公式执行；
 * - 引号包裹：含 `,` `"` CRLF 的值要整体包引号并双写内部引号（RFC 4180）；
 * - 文件头尾：UTF-8 BOM（Excel 中文不乱码）+ CRLF 行尾（Excel 兼容）。
 */
describe('csvEscape', () => {
  it('普通值原样返回', () => {
    expect(csvEscape('导出客户一')).toBe('导出客户一');
    expect(csvEscape('E-20261117-0001')).toBe('E-20261117-0001');
  });

  it('null 输出空字符串（空单元格）', () => {
    expect(csvEscape(null)).toBe('');
  });

  it('含逗号的值用双引号包裹', () => {
    expect(csvEscape('导出,客户')).toBe('"导出,客户"');
  });

  it('含双引号的值包裹并双写内部引号', () => {
    expect(csvEscape('导出"客户"')).toBe('"导出""客户"""');
  });

  it('含换行的值用双引号包裹', () => {
    expect(csvEscape('第一行\n第二行')).toBe('"第一行\n第二行"');
    expect(csvEscape('第一行\r\n第二行')).toBe('"第一行\r\n第二行"');
  });

  it('以 = 开头的值加单引号前缀（公式注入防护）', () => {
    expect(csvEscape('=1+1')).toBe("'=1+1");
    expect(csvEscape("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it('以 @ 开头的值加单引号前缀（公式注入防护）', () => {
    expect(csvEscape('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
  });

  it('+ / - / 制表 / 回车开头同样加前缀；数字不受影响', () => {
    expect(csvEscape('+1')).toBe("'+1");
    expect(csvEscape('-1')).toBe("'-1");
    expect(csvEscape('\tX')).toBe("'\tX");
    expect(csvEscape('\rX')).toBe('"\'\rX"'); // 前缀后仍含 CR，所以要再包引号
    // 数字类型不走前缀：金额加前缀会变成文本，Excel 无法求和。
    expect(csvEscape(-1)).toBe('-1');
    expect(csvEscape(12.5)).toBe('12.5');
  });
});

describe('toCsv', () => {
  it('开头写 UTF-8 BOM，行尾 CRLF，末尾也补 CRLF', () => {
    const csv = toCsv(['单号', '客户'], [['E-1', '客户一']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('单号,客户\r\nE-1,客户一\r\n');
  });

  it('只给表头时也以 CRLF 结尾', () => {
    const csv = toCsv(['批次号', '商品名称'], []);
    expect(csv.slice(1)).toBe('批次号,商品名称\r\n');
  });

  it('单元格逐列转义：表头里的逗号也包引号', () => {
    const csv = toCsv(['金额,合计'], [['=1+1', null]]);
    expect(csv.slice(1)).toBe('"金额,合计"\r\n\'=1+1,\r\n');
  });
});
