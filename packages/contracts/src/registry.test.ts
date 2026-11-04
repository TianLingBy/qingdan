import { describe, expect, it } from 'vitest';
import { ROUTES } from './routes.js';
import { defineRoute, validateRegistry } from './registry.js';

describe('注册表自检', () => {
  it('自检无错误（operationId / 路径 / 功能域 / 重复）', () => {
    expect(validateRegistry(ROUTES)).toEqual([]);
  });

  it('端点数与 operationId 唯一', () => {
    const ids = ROUTES.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  it('scope 由功能域与动作推导，不允许手写不一致', () => {
    for (const r of ROUTES) expect(r.scope).toBe(`${r.domain}.${r.action}`);
  });

  it('危险动作默认禁止 AI（D54 ⑥）', () => {
    const dangerous = ROUTES.filter((r) => /\.(delete|revoke|reverse|cost-correct|confirm)$/.test(r.operationId) || r.operationId.includes('.permission.'));
    expect(dangerous.length).toBeGreaterThan(0);
    for (const r of dangerous) {
      expect(r.ai.policy, r.operationId).toBe('forbid');
      expect(r.ai.reasonRequired, r.operationId).toBe(true);
    }
  });

  it('写操作必须记审计（D51）', () => {
    for (const r of ROUTES.filter((x) => x.method !== 'GET')) {
      expect(r.audit.required, r.operationId).toBe(true);
      expect(r.audit.kind, r.operationId).toBe('write');
    }
  });

  it('defineRoute 推出默认值（审计必填规则）', () => {
    const r = defineRoute({ operationId: 'sales.create', method: 'POST', path: '/api/v1/x', domain: 'sales', action: 'create', summary: 'x' });
    expect(r.audit).toEqual({ kind: 'none', required: false });
    expect(r.ai.policy).toBe('allow');
  });
});
