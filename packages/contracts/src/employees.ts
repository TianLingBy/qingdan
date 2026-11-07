import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { EmployeeSchema } from './entities.js';

/**
 * 员工管理写端点（创建 / 编辑 / 停用）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **工号由服务端自动发放**（D48）：6 位、全租户唯一，入参不接收 `employeeNo`；
 * - **绑定公司集合**（D15）：`companyIds` 决定数据可见范围，服务端再校验调用者可见性；
 * - **手机号**是一期登录账号（D13/D48）；返回实体只回脱敏后的 `phoneMasked`，
 *   完整手机号不出服务端（与 `EmployeeSummary` 同口径）；
 * - 写操作必记审计（D51）；**创建账号 / 停用属危险动作，AI 默认禁止**（D52.1 / D54⑥）；
 * - **停用 = 软删除**（不物理删）；停用后会话与 API Token 在下一次请求立即失效（D52.1②）。
 */

/** 手机号：11 位、以 1 开头（与 `0001_platform_core.sql` 的 `employee.phone` CHECK 一致）。 */
const EmployeePhoneSchema = z
  .string()
  .regex(/^1[0-9]{10}$/, '手机号必须是 11 位数字、以 1 开头');

/**
 * 创建员工入参。
 * body 里**不接收工号**：D48 规定由服务端自动发放 6 位全租户唯一编号。
 * `.strict()` 让客户端误传 `employeeNo` / `id` 直接校验失败，而不是静默丢弃。
 */
export const EmployeeCreateInputSchema = z
  .object({
    name: z.string().min(1).max(64),
    phone: EmployeePhoneSchema,
    /** 岗位（D4 一人多岗）；公司 × 岗位的绑定落 `employee_company_position`。 */
    positionIds: z.array(z.string().uuid()).min(1),
    /** 绑定公司集合（D15）：员工的数据可见范围。 */
    companyIds: z.array(z.string().uuid()).min(1),
    /** 仅老板可传 true（老板标识口径 D59⑥；岗位角色标识 D60②）；缺省 false。 */
    isOwner: z.boolean().optional(),
  })
  .strict();

/**
 * 更新员工入参：全字段可选、至少改一个。
 * 不可改 `id` / `employeeNo`（同上，`.strict()` 拒绝客户端传入）。
 * 改 `isOwner` 属于老板身份变更，必须由人类操作；路由级 AI 策略对普通编辑放行，
 * 字段级的人类限制由实现按 actorType 拦截。
 */
export const EmployeeUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    phone: EmployeePhoneSchema.optional(),
    positionIds: z.array(z.string().uuid()).min(1).optional(),
    companyIds: z.array(z.string().uuid()).min(1).optional(),
    isOwner: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });

export type EmployeeCreateInput = z.infer<typeof EmployeeCreateInputSchema>;
export type EmployeeUpdateInput = z.infer<typeof EmployeeUpdateInputSchema>;

/**
 * 员工管理端点（3 条）。
 *
 * 权限：`employee.read` / `.create` / `.update` / `.delete`（scope = domain.action）。
 * 审计：写操作必记（D51）。
 * AI：修改允许；**创建账号 / 停用属危险动作，默认禁止**（D52.1 / D54⑥）。
 * 并发：update / disable 强制 If-Match 强 ETag（实体回 `version`）。
 */
export const EMPLOYEE_ROUTES: readonly RouteDef[] = [
  defineRoute({
    operationId: 'platform.employee.create',
    method: 'POST',
    path: '/api/v1/employees',
    domain: 'employee',
    action: 'create',
    summary: '创建员工（工号由服务端按 D48 自动发放；建账号属危险动作，AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: EmployeeCreateInputSchema },
    response: { status: 201, schema: EmployeeSchema },
  }),
  defineRoute({
    operationId: 'platform.employee.update',
    method: 'PATCH',
    path: '/api/v1/employees/{id}',
    domain: 'employee',
    action: 'update',
    summary: '修改员工（强 ETag If-Match；不可改 id / 工号；改 isOwner 仅限人类）',
    audit: { kind: 'write' },
    ai: { policy: 'allow' },
    requiresIfMatch: true,
    request: { body: EmployeeUpdateInputSchema },
    response: { status: 200, schema: EmployeeSchema },
  }),
  defineRoute({
    operationId: 'platform.employee.disable',
    method: 'DELETE',
    path: '/api/v1/employees/{id}',
    domain: 'employee',
    action: 'delete',
    summary: '停用员工（软删除，不做物理删除；危险动作，AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
    // 回实体而不是 204：客户端要拿到新 `version` 才能继续并发写（与商品/客户同款）。
    // D52.1②：停用后会话与 API Token 在下一次请求立即失效。
    response: { status: 200, schema: EmployeeSchema },
  }),
];
