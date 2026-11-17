import { AppError } from '@qingdan/contracts';
import { describe, expect, it } from 'vitest';
import { buildOrderBy } from './order-by.js';

/**
 * 排序片段拼装（D95）。
 * 这里只验三件事：默认列、白名单外的键一律 422、id 收尾保证稳定序。
 */

const COLUMN_MAP = {
  id: 'o.id',
  orderNo: 'o.order_no',
  createdAt: 'o.created_at',
} as const satisfies Record<string, string>;

describe('buildOrderBy', () => {
  it('未指定 sort 时用默认列，方向默认 DESC', () => {
    expect(buildOrderBy(COLUMN_MAP, undefined, undefined, 'o.id', 'createdAt')).toBe(
      'o.created_at DESC, o.id DESC',
    );
  });

  it('指定 asc 时方向跟随，id 仍收尾', () => {
    expect(buildOrderBy(COLUMN_MAP, 'orderNo', 'asc', 'o.id', 'createdAt')).toBe(
      'o.order_no ASC, o.id ASC',
    );
  });

  it('默认列就是 id 时不重复拼一次', () => {
    expect(buildOrderBy(COLUMN_MAP, undefined, undefined, 'o.id', 'id')).toBe('o.id DESC');
  });

  it('白名单外的键 → VALIDATION_FAILED（details.field=sort）', () => {
    expect(() => buildOrderBy(COLUMN_MAP, 'totalAmount', 'desc', 'o.id', 'createdAt')).toThrowError(
      AppError,
    );
    try {
      buildOrderBy(COLUMN_MAP, 'totalAmount', 'desc', 'o.id', 'createdAt');
    } catch (error) {
      expect((error as AppError).details).toMatchObject({ field: 'sort' });
    }
  });
});
