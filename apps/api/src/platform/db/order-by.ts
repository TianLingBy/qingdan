import { AppError, type SortOrder } from '@qingdan/contracts';

/**
 * 把契约层的排序键翻成 SQL 片段。
 *
 * 白名单由调用方传入（列名映射表就写在调用方），这里只做「没在表里就 422」，
 * 绝不把用户串直接拼进 SQL——SQL 注入的唯一入口是字符串拼接，白名单表是它唯一闸门。
 *
 * 所有排序都以 id 收尾：同值行（同一天开的两张单、同一个入厂日期的两批货）
 * 必须有稳定次序，否则翻页会漏行或重复。
 *
 * 关于 NULL：**可空列不进白名单**。页式翻页靠复合索引做有序扫描，
 * 而 `DESC` 与 `DESC NULLS LAST` 不是同一个索引序，随手加 NULLS LAST 会让索引失配退化成 Sort 节点。
 * 本批三个列表的排序键全部是 NOT NULL 列（`available_qty` 虽由表达式生成，
 * 但源列全是 NOT NULL，故生成值也不会为 NULL）。
 */
export function buildOrderBy(
  columnMap: Readonly<Record<string, string>>,
  sort: string | undefined,
  order: SortOrder | undefined,
  idColumn: string,
  defaultSort: string,
): string {
  const key = sort ?? defaultSort;
  const column = columnMap[key];
  if (column === undefined) {
    throw new AppError('VALIDATION_FAILED', '不支持的排序字段', { field: 'sort' });
  }
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  // id 收尾保证稳定序；若主排序键就是 id 就不重复拼一次。
  return column === idColumn ? `${column} ${direction}` : `${column} ${direction}, ${idColumn} ${direction}`;
}
