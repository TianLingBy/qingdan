import { z } from 'zod';
import { DOMAIN_KEYS, ACTION_KEYS } from './domains.js';
import { defineRoute, type RouteDef } from './registry.js';
import { ApiTokenCreatedSchema, ApiTokenSchema, EmployeeSummarySchema } from './entities.js';
import { AuditLogSchema } from './audit.js';
import { ScopeMatrixSchema } from './authz.js';
import { WorkbenchEntryListSchema } from './workbench.js';
import { PageQuerySchema, pageSchema } from './pagination.js';
import { PRODUCT_ROUTES } from './products.js';
import { CUSTOMER_ROUTES } from './customers.js';
import { SUPPLIER_ROUTES } from './suppliers.js';
import { PROCESSOR_ROUTES } from './processors.js';
import { EMPLOYEE_ROUTES } from './employees.js';
import { POSITION_ROUTES } from './positions.js';
import { COMPANY_ROUTES } from './companies.js';
import { INVENTORY_ROUTES } from './inventory.js';
import { STOCKTAKE_ROUTES } from './stocktakes.js';
import { COST_ADJUSTMENT_ROUTES } from './cost-adjustments.js';
import { SALES_ORDER_ROUTES } from './sales-orders.js';
import { SALES_RECEIPT_ROUTES } from './sales-receipts.js';
import { CUSTOMER_RETURN_ROUTES } from './customer-returns.js';
import { PURCHASE_ORDER_ROUTES } from './purchase-orders.js';
import { SUPPLIER_RETURN_ROUTES } from './supplier-returns.js';
import { PROCESSING_ORDER_ROUTES } from './processing-orders.js';
import { INTERNAL_TRADE_ORDER_ROUTES } from './internal-trade-orders.js';
import { SETTLEMENT_ORDER_ROUTES } from './settlement-orders.js';
import { COMMISSION_RATE_ROUTES } from './commission-rates.js';
import { PRINT_ROUTES } from './prints.js';
import { PAYMENT_ROUTES } from './payments.js';
import { BILLING_ROUTES } from './billings.js';
import { PROFIT_REPORT_ROUTES } from './profit-report.js';

/**
 * 端点注册表（全量真源）。
 *
 * 一期规则（D54 缺口 10）：全部端点先在注册表登记签名，handler 允许先返 501。
 * **模块归属**（D62）：每条路由带 `module`，各模块只挂自己的那批；
 *   - `platform` 内核已冻结的端点在下方直接登记；
 *   - 业务模块的端点在各自文件里定义（如 `products.ts` 的 `PRODUCT_ROUTES`），
 *     再汇总进本表——注册表仍是全量真源，OpenAPI/CLI/MCP 都从这里发射。
 */

const LoginInput = z.object({
  phone: z.string().min(6).max(32),
  code: z.string().min(1).max(16),
});
const LoginOutput = z.object({
  employeeId: z.string(),
  tenantId: z.string(),
  displayName: z.string(),
});
/** 发登录验证码：只需手机号；是否真的发短信由服务端环境与配置决定。 */
const SendCodeInput = z.object({
  phone: z.string().min(6).max(32),
});
const SendCodeOutput = z.object({
  sent: z.literal(true),
});
const MeOutput = z.object({
  employeeId: z.string(),
  tenantId: z.string(),
  displayName: z.string(),
  /** 老板 / 员工身份位（Issue #227）：老板 = `employee.is_owner`，由账号属性决定，非前端角色切换。 */
  isOwner: z.boolean(),
  companyIds: z.array(z.string()),
  scope: ScopeMatrixSchema,
  /** 后端按身份 scope 现算的工作台入口清单；员工看不到的入口不在返回体里。 */
  entries: WorkbenchEntryListSchema,
});

const CreateApiTokenInput = z.object({
  name: z.string().min(1).max(64),
  employeeId: z.string(),
  scope: ScopeMatrixSchema,
  expiresAt: z.string().datetime().nullable().optional(),
  ipAllowlist: z.array(z.string()).optional(),
});

const PermissionOverrideInput = z.object({
  overrides: z.array(
    z.object({
      domain: z.enum(DOMAIN_KEYS as [string, ...string[]]),
      action: z.enum(ACTION_KEYS as [string, ...string[]]),
      granted: z.boolean(),
    }),
  ),
});

const IdParam = z.object({ id: z.string() });

/**
 * 员工列表查询（D15 / D50）：在通用游标分页上追加数据范围过滤。
 * `keyword` 匹配姓名 / 工号 / 手机号后 4 位，始终在调用者可见公司范围内生效。
 */
export const EmployeeListQuerySchema = PageQuerySchema.extend({
  companyId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  status: z.enum(['在职', '停用']).optional(),
  keyword: z.string().min(1).max(64).optional(),
});

export const ROUTES: readonly RouteDef[] = [
  defineRoute({
    operationId: 'platform.health.read',
    method: 'GET',
    path: '/api/v1/health',
    domain: 'api_integration',
    action: 'read',
    summary: '健康检查（不认证、不记审计）',
    audit: { kind: 'none' },
    publicAccess: true,
    response: { status: 200, schema: z.object({ status: z.literal('ok'), version: z.string() }) },
  }),
  defineRoute({
    operationId: 'platform.openapi.read',
    method: 'GET',
    path: '/api/v1/openapi.json',
    domain: 'api_integration',
    action: 'read',
    summary: 'OpenAPI 3.1 文档（接口真源，公开只读）',
    audit: { kind: 'none' },
    publicAccess: true,
  }),
  defineRoute({
    operationId: 'platform.code.send',
    method: 'POST',
    path: '/api/v1/auth/code',
    domain: 'employee',
    action: 'read',
    summary: '发送登录验证码（同号 60 秒一条、每天最多 10 条）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: SendCodeInput },
    response: { status: 200, schema: SendCodeOutput },
  }),
  defineRoute({
    operationId: 'platform.auth.login',
    method: 'POST',
    path: '/api/v1/auth/login',
    domain: 'employee',
    action: 'read',
    summary: '手机号 + 验证码登录（验证码由 /auth/code 下发，非生产固定码直通）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: LoginInput },
    response: { status: 200, schema: LoginOutput },
  }),
  defineRoute({
    operationId: 'platform.auth.logout',
    method: 'POST',
    path: '/api/v1/auth/logout',
    domain: 'employee',
    action: 'read',
    summary: '登出（只失效当前会话）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
  }),
  defineRoute({
    operationId: 'platform.auth.me',
    method: 'GET',
    path: '/api/v1/auth/me',
    domain: 'employee',
    action: 'read',
    summary: '当前登录主体与生效权限',
    audit: { kind: 'none' },
    response: { status: 200, schema: MeOutput },
  }),
  defineRoute({
    operationId: 'platform.employee.read',
    method: 'GET',
    path: '/api/v1/employees',
    domain: 'employee',
    action: 'read',
    summary: '员工列表（普通读不记审计；老板见全租户，非老板仅绑定公司集合）',
    audit: { kind: 'none' },
    request: { query: EmployeeListQuerySchema },
    response: { status: 200, schema: pageSchema(EmployeeSummarySchema) },
  }),
  // —— 员工管理写端点：创建 / 编辑 / 停用（契约，2026-11-05）——
  ...EMPLOYEE_ROUTES,
  // —— 岗位（权限模板）端点：归 permission 功能域（D44，2026-11-05）——
  ...POSITION_ROUTES,
  // —— 公司管理端点（D16 公司码，2026-11-05）——
  ...COMPANY_ROUTES,
  defineRoute({
    operationId: 'platform.audit.read',
    method: 'GET',
    path: '/api/v1/audit-logs',
    domain: 'audit',
    action: 'read',
    summary: '操作日志查询（敏感读，必记审计；保留 180 天在线）',
    audit: { kind: 'sensitive-read' },
    request: { query: PageQuerySchema },
    response: { status: 200, schema: pageSchema(AuditLogSchema) },
  }),
  defineRoute({
    operationId: 'platform.token.create',
    method: 'POST',
    path: '/api/v1/api-tokens',
    domain: 'api_integration',
    action: 'create',
    summary: '创建 API Token（scope ⊆ 创建人授权，超出拒绝）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid' },
    request: { body: CreateApiTokenInput },
    response: { status: 201, schema: ApiTokenCreatedSchema },
  }),
  defineRoute({
    operationId: 'platform.token.read',
    method: 'GET',
    path: '/api/v1/api-tokens',
    domain: 'api_integration',
    action: 'read',
    summary: 'Token 列表（敏感读，必记审计）',
    audit: { kind: 'sensitive-read' },
    request: { query: PageQuerySchema },
    response: { status: 200, schema: pageSchema(ApiTokenSchema) },
  }),
  defineRoute({
    operationId: 'platform.token.revoke',
    method: 'DELETE',
    path: '/api/v1/api-tokens/{id}',
    domain: 'api_integration',
    action: 'delete',
    summary: '撤销 Token（危险动作，AI 默认禁止）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    requiresIfMatch: true,
  }),
  defineRoute({
    operationId: 'platform.permission.update',
    method: 'PATCH',
    path: '/api/v1/employees/{employeeId}/permissions',
    domain: 'permission',
    action: 'update',
    summary: '员工个人级权限覆盖（D50；经理不可改老板/财务/其他经理）',
    audit: { kind: 'write' },
    ai: { policy: 'forbid', reasonRequired: true },
    // If-Match 选填（员工 version 暂无读接口）：缺省跳过版本校验并审计 versionChecked=false；
    // 传入则仍按强 ETag 校验。见 permission-overrides.ts 用例注释。
    requiresIfMatch: false,
    dryRun: true,
    request: { body: PermissionOverrideInput },
  }),
  // —— masterdata 模块：商品资料首切（Issue #15，2026-11-04）——
  ...PRODUCT_ROUTES,
  // —— masterdata 模块：客户资料（契约第一批 §2，2026-11-04）——
  ...CUSTOMER_ROUTES,
  // —— masterdata 模块：供应商资料（契约第一批 §2，2026-11-04）——
  ...SUPPLIER_ROUTES,
  // —— masterdata 模块：加工厂 + 报价记录（契约第一批 §2 / D64）——
  ...PROCESSOR_ROUTES,
  // —— inventory 模块：首批只读（批次 list/detail + 流水，Issue #48 / D67）——
  ...INVENTORY_ROUTES,
  // —— inventory 模块：盘点调整 I 4 条（list/create/detail/approve，契约第一批 §4 / D47）——
  ...STOCKTAKE_ROUTES,
  // —— inventory 模块：成本更正 4 条（提交/历史/审批/驳回，Issue #163 / D70）——
  ...COST_ADJUSTMENT_ROUTES,
  // —— sales 模块：E 销售单首批 5 条（list/create/detail/update/cancel，契约第一批 §3.3）——
  ...SALES_ORDER_ROUTES,
  // —— sales 模块：收款记录 2 条（list/create，契约第一批 §6 / D24/D34/D40）——
  ...SALES_RECEIPT_ROUTES,
  // —— sales 模块：R 客户退货 3 条（list/create/detail，契约第一批 §4 / D36/D40/D47）——
  ...CUSTOMER_RETURN_ROUTES,
  // —— purchase 模块：A 采购单首批 5 条（list/create/detail/update/cancel，契约第一批 §3.1）——
  ...PURCHASE_ORDER_ROUTES,
  // —— purchase 模块：S 供应商退货 3 条（list/create/detail，契约第一批 §4 / F4c）——
  ...SUPPLIER_RETURN_ROUTES,
  // —— processing 模块：B 加工单首批 5 条（list/create/detail/update/cancel，契约第一批 §3.2）——
  ...PROCESSING_ORDER_ROUTES,
  // —— internal-trade 模块：N 内部交易单首批 5 条（契约第二批 §1 / §3，D22/D31/D68）——
  ...INTERNAL_TRADE_ORDER_ROUTES,
  // —— settlement 模块：C 结算单首批 3 条（list/detail/confirm，契约第一批 §3.4）——
  ...SETTLEMENT_ORDER_ROUTES,
  // —— settlement 模块：提成比例配置 3 条（list/create/delete，D77）——
  ...COMMISSION_RATE_ROUTES,
  // —— 打印 / 导出 3 条（销售单打印、加工单打印、销售单列表导出）——
  ...PRINT_ROUTES,
  // —— payment 模块：在线支付回调 1 条（#101，匿名可达 / 幂等）——
  ...PAYMENT_ROUTES,
  // —— billing：平台订阅 2 条（读 / 运营调整，一期仅契约）——
  ...BILLING_ROUTES,
  // —— report 模块：利润报表 2 条（D43 / #97，Issue #164）——
  ...PROFIT_REPORT_ROUTES,
];

export const ROUTE_PARAM = IdParam;
