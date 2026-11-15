import { describe, expect, it } from 'vitest';
import { DOMAIN_KEYS } from './domains.js';
import { buildOpenApiDocument } from './openapi.js';
import { ROUTES } from './routes.js';
import { routesOfModule, validateRegistry } from './registry.js';
import {
  TODO_KINDS,
  TodoItemSchema,
  TodoListSchema,
  WORKBENCH_TODO_ROUTES,
} from './todos.js';

/**
 * 工作台待办契约（D89 / #289）。
 *
 * 锁的是「端点签名 + 响应形状」：实现（聚合 SQL / 权限过滤）由 API 用例落地。
 */

describe('工作台待办契约（platform 模块 / workbench 功能域，D89）', () => {
  it('1 条端点登记进 ROUTES，归属 platform、域为新增的 workbench', () => {
    expect(WORKBENCH_TODO_ROUTES).toHaveLength(1);
    const route = WORKBENCH_TODO_ROUTES[0]!;
    expect(route.operationId).toBe('workbench.todos.read');
    expect(route.method).toBe('GET');
    expect(route.path).toBe('/api/v1/todos');
    expect(route.module).toBe('platform');
    expect(route.domain).toBe('workbench');
    expect(route.action).toBe('read');
    expect(route.scope).toBe('workbench.read');
    expect(route.audit).toEqual({ kind: 'none', required: false });
    expect(route.ai).toEqual({ policy: 'allow', reasonRequired: false });

    const platformIds = routesOfModule(ROUTES, 'platform').map((r) => r.operationId);
    expect(platformIds).toContain('workbench.todos.read');
    expect(validateRegistry(ROUTES)).toEqual([]);
  });

  it('workbench 是 DOMAIN_KEYS 的第 25 个功能域（只新增这一个）', () => {
    expect(DOMAIN_KEYS).toContain('workbench');
    expect(DOMAIN_KEYS).toHaveLength(25);
    expect(DOMAIN_KEYS.filter((domain) => domain === 'workbench')).toHaveLength(1);
    expect(DOMAIN_KEYS.indexOf('billing')).toBeLessThan(DOMAIN_KEYS.indexOf('workbench'));
  });

  it('响应：items[].{kind,title,count,hint,routeId}，count 为非负整数，且没有金额字段', () => {
    expect(TodoListSchema.safeParse({ items: [] }).success).toBe(true);

    const item = {
      kind: 'settlement_pending',
      title: '结算单待确认',
      count: 3,
      hint: '本公司在办',
      routeId: 'settlements',
    };
    expect(TodoItemSchema.safeParse(item).success).toBe(true);
    expect(TodoItemSchema.safeParse({ ...item, count: -1 }).success).toBe(false);
    expect(TodoItemSchema.safeParse({ ...item, count: 1.5 }).success).toBe(false);
    expect(TodoItemSchema.safeParse({ ...item, count: '3' }).success).toBe(false);

    // 本端点只给笔数，不返回金额（避免绕过 view_price）：schema 上就没有这些键。
    const amountKeys = ['amount', 'totalAmount', 'grossProfit', 'refundAmount', 'unitCost'];
    const itemKeys = Object.keys(TodoItemSchema.shape);
    for (const key of amountKeys) expect(itemKeys).not.toContain(key);
    expect(TodoListSchema.safeParse({ items: [item], totalAmount: '1' }).success).toBe(true);
    expect(TodoListSchema.shape).not.toHaveProperty('totalAmount');
  });

  it('kind 词表是稳定英文串、顺序固定（D89）', () => {
    expect([...TODO_KINDS]).toEqual([
      'settlement_pending',
      'stocktake_pending',
      'cost_adjustment_pending',
      'customer_return_pending',
      'supplier_return_pending',
      'processing_pending',
    ]);
    for (const kind of TODO_KINDS) expect(kind).toMatch(/^[a-z][a-z0-9_]+$/);
  });

  it('OpenAPI：路径 / tag / x-scope / x-module / x-mcp-tool 与 operationId 一致', () => {
    const doc = buildOpenApiDocument(ROUTES);
    const operation = doc.paths['/api/v1/todos']?.get as Record<string, unknown>;
    expect(operation).toBeTruthy();
    expect(operation.operationId).toBe('workbench.todos.read');
    expect(operation.tags).toEqual(['workbench']);
    expect(operation['x-scope']).toBe('workbench.read');
    expect(operation['x-module']).toBe('platform');
    expect(operation['x-audit']).toEqual({ kind: 'none', required: false });
    // D54 / D89：工具名与 operationId 一对一；本端点按产品口径固定为 qingdan_todos_read。
    expect(operation['x-mcp-tool']).toBe('qingdan_todos_read');
    expect(doc.tags).toContainEqual({ name: 'workbench', description: '工作台' });
  });
});
