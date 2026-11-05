import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from './routes.js';
import {
  EMPLOYEE_ROUTES,
  EmployeeCreateInputSchema,
  EmployeeUpdateInputSchema,
} from './employees.js';
import { EmployeeSchema, ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';

/**
 * 员工管理契约（创建 / 编辑 / 停用）。
 *
 * 这些断言锁的是「员工写端点契约签名」本身，不是实现：
 * 实现（repo / usecase / HTTP）由平台负责人按本文件落地，改签名必须先改这里并过评审。
 */

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const POSITION_ID = '00000000-0000-4000-8000-000000000002';

const validCreate = {
  name: '张三',
  phone: '13800000000',
  positionIds: [POSITION_ID],
  companyIds: [COMPANY_ID],
};

describe('员工管理契约（platform）', () => {
  it('3 条端点全部登记并汇总进 ROUTES，且归属 platform', () => {
    expect(EMPLOYEE_ROUTES).toHaveLength(3);
    for (const route of EMPLOYEE_ROUTES) expect(route.module).toBe('platform');

    const platformIds = routesOfModule(ROUTES, 'platform').map((r) => r.operationId);
    for (const route of EMPLOYEE_ROUTES) expect(platformIds).toContain(route.operationId);
  });

  it('operationId / 方法 / 路径与契约一致', () => {
    const actual = EMPLOYEE_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'POST /api/v1/employees platform.employee.create',
        'PATCH /api/v1/employees/{id} platform.employee.update',
        'DELETE /api/v1/employees/{id} platform.employee.disable',
      ].sort(),
    );
  });

  it('权限 scope = employee.<动作>，写操作必记审计（D51）', () => {
    const byId = new Map(EMPLOYEE_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('platform.employee.create')?.scope).toBe('employee.create');
    expect(byId.get('platform.employee.update')?.scope).toBe('employee.update');
    expect(byId.get('platform.employee.disable')?.scope).toBe('employee.delete');

    for (const route of EMPLOYEE_ROUTES) {
      expect(route.audit).toEqual({ kind: 'write', required: true });
    }
  });

  it('更新/停用带强 ETag；创建与停用禁止 AI，停用必须带 reason（D52.1/D54⑥）', () => {
    const byId = new Map(EMPLOYEE_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('platform.employee.update')?.requiresIfMatch).toBe(true);
    expect(byId.get('platform.employee.disable')?.requiresIfMatch).toBe(true);
    expect(byId.get('platform.employee.create')?.ai).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(byId.get('platform.employee.update')?.ai).toEqual({ policy: 'allow', reasonRequired: false });
    expect(byId.get('platform.employee.disable')?.ai).toEqual({ policy: 'forbid', reasonRequired: true });
  });

  it('创建入参：工号不可由客户端传入；phone / 公司 / 岗位按契约校验（D48/D15）', () => {
    expect(EmployeeCreateInputSchema.safeParse(validCreate).success).toBe(true);
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, isOwner: false }).success).toBe(true);

    // D48：工号由服务端发放，body 不接收（strict → 传入即失败，不静默丢弃）。
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, employeeNo: '000001' }).success).toBe(false);
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, id: COMPANY_ID }).success).toBe(false);
    expect(Object.keys(EmployeeCreateInputSchema.shape)).not.toContain('employeeNo');
    expect(Object.keys(EmployeeCreateInputSchema.shape)).not.toContain('id');

    // 手机号：11 位、以 1 开头（与 employee.phone CHECK 一致）。
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, phone: '1380000000' }).success).toBe(false);
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, phone: '23800000000' }).success).toBe(false);
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, phone: '1380000000a' }).success).toBe(false);

    // 公司集合 / 岗位：uuid 数组且不能为空（D15 绑定公司集合）。
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, companyIds: [] }).success).toBe(false);
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, positionIds: [] }).success).toBe(false);
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, companyIds: ['not-uuid'] }).success).toBe(false);
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, positionIds: ['not-uuid'] }).success).toBe(false);
    expect(EmployeeCreateInputSchema.safeParse({ ...validCreate, name: '' }).success).toBe(false);
  });

  it('更新入参：全字段可选、至少改一个；不可改 id / 工号', () => {
    expect(EmployeeUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(EmployeeUpdateInputSchema.safeParse({ name: '改名' }).success).toBe(true);
    expect(EmployeeUpdateInputSchema.safeParse({ phone: '13900000000' }).success).toBe(true);
    expect(EmployeeUpdateInputSchema.safeParse({ isOwner: true }).success).toBe(true);
    expect(EmployeeUpdateInputSchema.safeParse({ employeeNo: '000002' }).success).toBe(false);
    expect(EmployeeUpdateInputSchema.safeParse({ id: COMPANY_ID }).success).toBe(false);
    expect(Object.keys(EmployeeUpdateInputSchema.shape)).not.toContain('employeeNo');
    expect(Object.keys(EmployeeUpdateInputSchema.shape)).not.toContain('id');
  });

  it('Employee 实体已登记且脱敏：只回 phoneMasked + version，不出现完整 phone', () => {
    expect(ENTITIES.map((e) => e.name)).toContain('Employee');
    expect(z.globalRegistry.has(EmployeeSchema)).toBe(true);
    expect(z.globalRegistry.get(EmployeeSchema)?.id).toBe('Employee');

    const keys = Object.keys(EmployeeSchema.shape).sort();
    expect(keys).toEqual(
      ['id', 'employeeNo', 'name', 'status', 'isOwner', 'phoneMasked', 'companies', 'version'].sort(),
    );
    expect(keys).not.toContain('phone');

    const doc = buildOpenApiDocument(ROUTES);
    const employee = doc.components.schemas.Employee as { properties: Record<string, unknown> };
    expect(employee).toBeDefined();
    expect(employee.properties).toHaveProperty('phoneMasked');
    expect(employee.properties).toHaveProperty('version');
    expect(employee.properties).not.toHaveProperty('phone');
    expect(employee.properties).not.toHaveProperty('password');
  });

  it('OpenAPI 发射出员工端点与 x-module / x-scope / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);

    const collection = doc.paths['/api/v1/employees'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(collection).sort()).toEqual(['get', 'post']);
    expect(collection.get?.['x-scope']).toBe('employee.read');
    expect(collection.post?.['x-module']).toBe('platform');
    expect(collection.post?.['x-scope']).toBe('employee.create');
    expect(collection.post?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: false });
    expect(collection.post?.['x-mcp-tool']).toBe('qingdan_platform_employee_create');

    const detail = doc.paths['/api/v1/employees/{id}'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(detail).sort()).toEqual(['delete', 'patch']);
    expect(detail.patch?.['x-scope']).toBe('employee.update');
    expect(detail.patch?.['x-requires-if-match']).toBe(true);
    expect(detail.delete?.['x-scope']).toBe('employee.delete');
    expect(detail.delete?.['x-requires-if-match']).toBe(true);
    expect(detail.delete?.['x-ai-policy']).toEqual({ policy: 'forbid', reasonRequired: true });
  });
});
