import { describe, expect, it } from 'vitest';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_LIMIT,
  PageQuerySchema,
  pageSchema,
  pagedResultSchema,
  resolvePaging,
} from './pagination.js';
import { z } from 'zod';
import { AUTHZ_LAYER_ORDER, allowsScope, scopeIsSubset } from './authz.js';
import { AppError } from './errors.js';

describe('游标分页（契约第三批 §3）', () => {
  it('游标编解码往返', () => {
    const payload = { createdAt: '2026-11-04T00:00:00.000Z', id: '0190f0f0-0000-7000-8000-000000000000' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it('非法游标报 VALIDATION_FAILED', () => {
    expect(() => decodeCursor('!!!not-base64!!!')).toThrowError(AppError);
    expect(() => decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toThrowError(/cursor/);
  });

  it('limit 默认 50、上限 200、超限截断', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit('0')).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit('30')).toBe(30);
    expect(clampLimit('9999')).toBe(MAX_PAGE_LIMIT);
  });

  it('分页结构可解析', () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({ items: [{ id: 'a' }], nextCursor: null });
    expect(parsed.items).toHaveLength(1);
    expect(PageQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });
});

describe('页码模式（D95）', () => {
  it('只带 cursor → 游标模式，limit 照旧默认 50', () => {
    expect(resolvePaging({ cursor: 'abc' })).toEqual({
      mode: 'cursor',
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
      page: 1,
    });
  });

  it('只带 page → 页码模式，每页默认 20', () => {
    expect(resolvePaging({ page: 3 })).toEqual({
      mode: 'offset',
      limit: DEFAULT_PAGE_SIZE,
      offset: 40,
      page: 3,
    });
  });

  it('cursor 与 page 同时给 → VALIDATION_FAILED，details.field=page', () => {
    expect(() => resolvePaging({ cursor: 'abc', page: 2 })).toThrowError(AppError);
    try {
      resolvePaging({ cursor: 'abc', page: 2 });
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).details).toMatchObject({ field: 'page' });
    }
  });

  it('pageSize 优先于 limit', () => {
    expect(resolvePaging({ page: 2, limit: 100, pageSize: 5 })).toEqual({
      mode: 'offset',
      limit: 5,
      offset: 5,
      page: 2,
    });
  });

  it('什么都不给 → 页码模式第 1 页（前端默认要看到页码条）', () => {
    expect(resolvePaging({})).toEqual({
      mode: 'offset',
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
      page: 1,
    });
  });

  it('只带 limit 仍是游标模式：老前端靠它拿 nextCursor', () => {
    expect(resolvePaging({ limit: 2 })).toEqual({
      mode: 'cursor',
      limit: 2,
      offset: 0,
      page: 1,
    });
  });

  it('pagedResultSchema 允许 total/page/pageSize 为 null（游标模式）', () => {
    const schema = pagedResultSchema(z.object({ id: z.string() }));
    expect(
      schema.parse({ items: [{ id: 'a' }], total: null, page: null, pageSize: null, nextCursor: null }),
    ).toMatchObject({ total: null, page: null });
    expect(
      schema.parse({ items: [], total: 0, page: 1, pageSize: 20, nextCursor: null }).total,
    ).toBe(0);
  });
});

describe('权限 scope（D52.1 / D50 / D15）', () => {
  const granted = [
    { domain: 'sales' as const, actions: ['read', 'create'] as const },
    { domain: 'inventory_qty' as const, actions: ['read'] as const },
  ];

  it('allowsScope 按域与动作判定', () => {
    expect(allowsScope([...granted], 'sales', 'create')).toBe(true);
    expect(allowsScope([...granted], 'sales', 'delete')).toBe(false);
    expect(allowsScope([...granted], 'settlement', 'read')).toBe(false);
  });

  it('token scope 必须是创建人授权的子集（超出拒绝）', () => {
    expect(scopeIsSubset([{ domain: 'sales', actions: ['read'] }], granted)).toBe(true);
    expect(scopeIsSubset([{ domain: 'sales', actions: ['delete'] }], granted)).toBe(false);
    expect(scopeIsSubset([{ domain: 'settlement', actions: ['read'] }], granted)).toBe(false);
  });

  it('三层生效顺序固定（岗位并集 ⊕ 个人覆盖 ∩ 公司集合）', () => {
    expect([...AUTHZ_LAYER_ORDER]).toEqual(['position_union', 'employee_override', 'company_set']);
  });
});
