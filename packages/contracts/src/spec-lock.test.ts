import { describe, expect, it } from 'vitest';
import { ROUTES } from './routes.js';
import { AUTHZ_LAYER_ORDER, scopeIsSubset } from './authz.js';
import { AUTHZ_LAYER_ORDER as LAYERS } from './authz.js';
import { assertCancelable, canCancel, HEADER_STATES } from './documents.js';
import { DOCUMENT_NO_PATTERN, formatDocumentNo, formatEmployeeNo, DocumentNoSchema } from './numbering.js';
import { isDangerousOperation, mcpPolicy } from './mcp-map.js';
import { AppError } from './errors.js';

/**
 * P0-2 口径锁定测试：把 decisions 里的硬口径变成对实现契约的断言。
 * 目的（qa-reviewer 2026-11-04 体检）：文档正文删成 TODO 也不会让测试变绿。
 */
describe('D16 编号口径', () => {
  it('单号结构：类型字母-公司码(4)-日期(8)-流水(4)', () => {
    expect(formatDocumentNo({ type: 'A', companyCode: 1, date: new Date('2026-11-03T00:00:00Z'), sequence: 1 })).toBe('A-0001-20261103-0001');
    expect(DOCUMENT_NO_PATTERN.test('B-0042-20261231-9999')).toBe(true);
    expect(DocumentNoSchema.safeParse('A-1-20261103-0001').success).toBe(false);
    expect(DocumentNoSchema.safeParse('X-0001-20261103-0001').success).toBe(false);
  });

  it('公司码定长 4 位、流水 1~9999', () => {
    expect(formatDocumentNo({ type: 'E', companyCode: 10, date: new Date('2026-01-02T00:00:00Z'), sequence: 7 })).toBe('E-0010-20260102-0007');
    expect(() => formatDocumentNo({ type: 'E', companyCode: 10000, date: new Date(), sequence: 1 })).toThrowError(AppError);
    expect(() => formatDocumentNo({ type: 'E', companyCode: 1, date: new Date(), sequence: 0 })).toThrowError(AppError);
  });

  it('工号 6 位、全局唯一（不带公司前缀）', () => {
    expect(formatEmployeeNo(1)).toBe('000001');
    expect(formatEmployeeNo(999999)).toBe('999999');
    expect(() => formatEmployeeNo(1000000)).toThrowError(AppError);
  });
});

describe('D50 / D15 权限三层', () => {
  it('生效顺序 = 岗位并集 → 个人覆盖 → 公司集合', () => {
    expect([...AUTHZ_LAYER_ORDER]).toEqual(['position_union', 'employee_override', 'company_set']);
    expect([...LAYERS]).toHaveLength(3);
  });

  it('AI scope 不得超出创建人授权（D52.1 ①）', () => {
    const human = [{ domain: 'sales' as const, actions: ['read', 'create'] as const }];
    expect(scopeIsSubset([{ domain: 'sales', actions: ['read'] }], human)).toBe(true);
    expect(scopeIsSubset([{ domain: 'sales', actions: ['delete'] }], human)).toBe(false);
  });
});

describe('D21 取消级联', () => {
  it('未完成且无下游 → 可取消', () => {
    expect(canCancel('进行中', false)).toEqual({ allowed: true, reason: null });
    expect(() => assertCancelable('进行中', false)).not.toThrow();
  });

  it('有直接下游 → 不可取消（先取消下游）', () => {
    expect(canCancel('进行中', true)).toEqual({ allowed: false, reason: 'has_downstream' });
    expect(() => assertCancelable('进行中', true)).toThrowError(/下游/);
  });

  it('已完成 / 已取消 → 一律不可取消（走冲正 R/S/I）', () => {
    expect(canCancel('已完成', false).reason).toBe('already_completed');
    expect(canCancel('已取消', false).reason).toBe('already_cancelled');
    expect([...HEADER_STATES]).toEqual(['进行中', '已完成', '已取消']);
  });
});

describe('D51 / D54 审计与 AI 边界', () => {
  it('全部写操作 100% 记审计', () => {
    const writes = ROUTES.filter((r) => r.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    for (const r of writes) {
      expect(r.audit.required, r.operationId).toBe(true);
      expect(r.audit.kind, r.operationId).toBe('write');
    }
  });

  it('敏感读必记（日志查看 / Token 列表）', () => {
    for (const id of ['platform.audit.read', 'platform.token.read']) {
      const r = ROUTES.find((x) => x.operationId === id);
      expect(r, id).toBeTruthy();
      expect(r!.audit.kind).toBe('sensitive-read');
      expect(r!.audit.required).toBe(true);
    }
  });

  it('危险动作默认禁止 AI；租户开审批后仍需审批（D54 ⑥）', () => {
    const revoke = ROUTES.find((r) => r.operationId === 'platform.token.revoke')!;
    expect(isDangerousOperation(revoke.operationId)).toBe(true);
    expect(mcpPolicy(revoke, false)).toBe('forbid');
    expect(mcpPolicy(revoke, true)).toBe('require-approval');
    const health = ROUTES.find((r) => r.operationId === 'platform.health.read')!;
    expect(mcpPolicy(health, false)).toBe('allow');
  });
});
