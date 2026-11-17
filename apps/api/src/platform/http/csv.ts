/**
 * CSV 拼装（#342 列表导出）。
 *
 * 刻意不引第三方 csv 库：这里只需要「加 BOM + 转义 + CRLF」三件事，
 * 一个两百行不到的库要换来的维护面和体积远超收益，而且公式注入防护
 * 各家实现口径不一（不少库默认不做），自己写才能把规则钉死。
 *
 * 三条硬规则（都是踩过的坑，不是洁癖）：
 * 1. 公式注入：单元格以 `= + - @` 或制表/回车开头时，前面加一个单引号。
 *    Excel / WPS 打开 CSV 时会把 `=cmd|'/c calc'!A1` 当公式执行，
 *    导出功能因此变成「谁点了这个文件谁中招」——客户名、备注都是用户
 *    可控字段，所以这条不是理论风险，是必须堵的洞。
 * 2. UTF-8 BOM：没有 BOM 时 Excel（中文 Windows 默认 GBK 解码）打开中文全乱码，
 *    用户第一反应是「你们导出的数据坏了」。
 * 3. 行尾 CRLF：Excel 兼容性最好，RFC 4180 也这么要求。
 */

/** 单元格取值范围：null 表示空单元格，数字不走公式前缀（数字不可能是公式）。 */
export type CsvValue = string | number | null;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * 把单个值转成 CSV 单元格文本。
 *
 * 先做公式前缀，再做引号包裹：前缀加完后如果还是以 `=` 开头就说明没加，
 * 顺序反了会出现 `"'=1+1"` 这种把防护关掉的写法。
 */
export function csvEscape(value: CsvValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  // 数字直接 stringify：它不可能是公式，加前缀反而把金额变成文本，Excel 无法求和。
  if (typeof value === 'number') {
    return String(value);
  }
  let text = value;
  if (FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
  }
  // 含分隔符 / 引号 / 换行的值必须整体包引号，内部引号双写成 ""（RFC 4180）。
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * 拼出完整 CSV 文本：BOM + 表头 + 数据行，每行以 CRLF 结尾（含最后一行）。
 * 末尾补 CRLF 是为了让 Excel 和 `split(/\r\n/)` 两边都不产生「最后一行缺空行」的歧义。
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvValue[])[],
): string {
  const lines: string[] = [];
  lines.push(headers.map((header) => csvEscape(header)).join(','));
  for (const row of rows) {
    lines.push(row.map((cell) => csvEscape(cell)).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
