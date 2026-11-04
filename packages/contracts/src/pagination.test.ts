import { describe, expect, it } from 'vitest';
import { clampLimit, decodeCursor, encodeCursor, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, PageQuerySchema, pageSchema } from './pagination.js';
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
