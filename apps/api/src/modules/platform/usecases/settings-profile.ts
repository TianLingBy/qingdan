import {
  AppError,
  SettingsProfileUpdateSchema,
  allowsScope,
  etagOf,
  type Company,
  type SettingsProfile,
} from '@qingdan/contracts';
import type { ZodType } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withAudit, type AuditEvent } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import { maskPhone } from './employees.js';

/**
 * 保存我的资料（`platform.settings.update_profile`，Issue #298 / D97）。
 *
 * 三条硬口径：
 *   ① 路径写死 `/api/v1/employees/me`，**不接受任何员工 id**；改谁一律由会话里的
 *      principal 决定。这是防越权的根：只要端点上留一个 id 参数，就迟早会有人
 *      把「管理员改员工」的语义塞进来，届时权限判断就又散回各业务模块。
 *   ② `name` 是员工自己的名字，改它不需要任何业务 scope——本人改自己的显示名
 *      不该依赖管理员授权；而公司的地址 / 电话 / 税号 / LOGO 是公司级资料，
 *      必须 `company.update`（与 `/companies/{id}` 的 PATCH 同权限）。
 *   ③ `If-Match` 必填，版本取员工的 `version`（D60① 同一套并发口径）：
 *      资料保存是「读到旧值 → 全量提交」的表单流程，没有乐观锁就会静默覆盖
 *      别人刚保存的修改。
 */

const ACTION = 'platform.settings.update_profile';
const EMPLOYEE_OBJECT_TYPE = 'employee';

export interface SettingsProfileContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

/** 契约字段 → DB 列的固定白名单（拼 SQL 的列名只能来自这里，不能来自请求）。 */
const COMPANY_FIELD_COLUMNS = {
  address: 'address',
  contactPhone: 'contact_phone',
  taxNo: 'tax_no',
  logoUrl: 'logo_url',
} as const;

type CompanyFieldKey = keyof typeof COMPANY_FIELD_COLUMNS;

interface SelfRow {
  id: string;
  name: string;
  phone: string;
  version: number;
}

interface CompanyRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  address: string | null;
  contact_phone: string | null;
  tax_no: string | null;
  logo_url: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: SettingsProfileContext): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${ACTION} 不可用`, {
      operationId: ACTION,
    });
  }
  return database;
}

/**
 * 与 `/employees/{id}` PATCH 同一份 If-Match 解析（不抽公共函数是历史原因：
 * 那边先落地，这边照抄形状，避免为一次复用去动已稳定的人员模块）。
 */
function requireIfMatchVersion(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('PRECONDITION_REQUIRED', '本端点必须携带 If-Match（强 ETag "<version>"）');
  }
  const matched = /^"([0-9]+)"$/.exec(value.trim());
  if (!matched) {
    throw new AppError('VERSION_CONFLICT', 'If-Match 格式不合法，应为强 ETag "<version>"', {
      ifMatch: value,
    });
  }
  return Number(matched[1]);
}

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    address: row.address,
    contactPhone: row.contact_phone,
    taxNo: row.tax_no,
    logoUrl: row.logo_url,
    version: row.version,
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

function userAgentOf(request: FastifyRequest): string | null {
  const raw = request.headers['user-agent'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : null;
}

/**
 * 入参校验统一走 safeParse + AppError：全局错误处理器只认 `AppError` 与 fastify 自身
 * 的 `error.validation`，裸抛 ZodError 会被当成未知异常回 500——「参数不合法」必须是 422。
 * 三个 `/me` 用例共用（与 companies.ts / employees.ts 的处理口径一致）。
 */
export function parseBody<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '参数校验失败', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * 三个 `/me` 用例共用同一份审计组包（本模块内导出复用，避免三份形状漂移）。
 * `objectId` 恒为 principal 本人：这些端点没有员工 id 参数，审计里也不该出现别人的 id。
 */
export function settingsAuditEventOf(
  request: FastifyRequest,
  principal: Principal,
  action: string,
  changeSummary: Record<string, unknown>,
): AuditEvent {
  return {
    tenantId: principal.tenantId,
    actorType: principal.actorType,
    actorId: principal.actorId,
    credentialId: principal.credentialId,
    source: request.auditSource,
    action,
    objectType: EMPLOYEE_OBJECT_TYPE,
    objectId: principal.employeeId,
    changeSummary,
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: userAgentOf(request),
    reason: request.auditReason,
  };
}

async function loadSelf(tx: SqlClient, principal: Principal): Promise<SelfRow> {
  const result = await tx.query<SelfRow>(
    'SELECT id, name, phone, version FROM employee WHERE id = $1 AND tenant_id = $2',
    [principal.employeeId, principal.tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    // 会话有效但员工行不在：只可能是被并发删号，按未认证处理，别回 404 让人去猜。
    throw new AppError('UNAUTHENTICATED', '当前账号已不存在，请重新登录');
  }
  return row;
}

/**
 * 本次要编辑的「我的公司」= 可访问公司里公司码最小的一家。
 * 与概览里展示的主公司同一条约定（`settings-overview.ts` 的 `companies[0]`），
 * 否则概览显示 A、资料却存进 B，用户会以为没保存成功。
 */
async function resolveEditableCompanyId(tx: SqlClient, principal: Principal): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM company
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
      ORDER BY code
      LIMIT 1`,
    [principal.tenantId, [...principal.companyIds]],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('FORBIDDEN', '当前账号没有可编辑的公司');
  }
  return row.id;
}

async function loadCompany(
  tx: SqlClient,
  tenantId: string,
  companyId: string,
): Promise<CompanyRow> {
  const result = await tx.query<CompanyRow>(
    `SELECT id, tenant_id, code, name, address, contact_phone, tax_no, logo_url,
            version, created_at, updated_at
       FROM company
      WHERE id = $1 AND tenant_id = $2`,
    [companyId, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('NOT_FOUND', '公司不存在或已被删除');
  return row;
}

/**
 * 只把「真的传了」的字段拼进 SET 列表。
 * 传 `null` = 清空该字段，不传 = 保持原值——两者必须区分，
 * 所以不能用一个 `COALESCE($n, address)` 糊过去。
 */
interface CompanyProfileInput {
  readonly address?: string | null;
  readonly contactPhone?: string | null;
  readonly taxNo?: string | null;
  readonly logoUrl?: string | null;
}

function buildCompanyAssignments(company: CompanyProfileInput): {
  assignments: string[];
  values: (string | null)[];
} {
  const assignments: string[] = [];
  const values: (string | null)[] = [];
  for (const key of Object.keys(COMPANY_FIELD_COLUMNS) as CompanyFieldKey[]) {
    const value = company[key];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${COMPANY_FIELD_COLUMNS[key]} = $${values.length + 2}`);
  }
  return { assignments, values };
}

export async function updateSettingsProfile(ctx: SettingsProfileContext): Promise<SettingsProfile> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);
  const input = parseBody(SettingsProfileUpdateSchema, ctx.request.body);
  const expectedVersion = requireIfMatchVersion(ctx.request);

  // 公司四字段属于公司级资料：先判权限再碰库，没有 company.update 直接 403，
  // 不靠「反正 SQL 也会失败」来兜底。
  if (input.company !== undefined && !allowsScope(principal.scope, 'company', 'update')) {
    throw new AppError('FORBIDDEN', '缺少 company.update 权限');
  }

  const summary: Record<string, unknown> = { fields: [] as string[] };

  const result = await withAudit(
    database,
    settingsAuditEventOf(ctx.request, principal, ACTION, summary),
    async (tx) => {
      const fields = summary.fields as string[];
      const self = await loadSelf(tx, principal);
      if (self.version !== expectedVersion) {
        throw new AppError('VERSION_CONFLICT', '员工已被并发修改，请重新读取后重试', {
          expectedVersion,
          actualVersion: self.version,
        });
      }

      let version = self.version;
      let name = self.name;
      if (input.name !== undefined && input.name !== self.name) {
        // 名字变了才 +1：只在公司字段变化时抬高员工版本，会让并发的另一次
        // 「只改名字」保存莫名其妙 409。
        const updated = await tx.query<{ version: number }>(
          `UPDATE employee
              SET name = $3, version = version + 1
            WHERE id = $1 AND tenant_id = $2 AND version = $4
            RETURNING version`,
          [principal.employeeId, principal.tenantId, input.name, self.version],
        );
        const row = updated.rows[0];
        if (!row) {
          throw new AppError('VERSION_CONFLICT', '员工已被并发修改，请重新读取后重试');
        }
        version = row.version;
        name = input.name;
        fields.push('name');
      }

      let company: Company | null = null;
      if (input.company !== undefined) {
        const companyId = await resolveEditableCompanyId(tx, principal);
        const { assignments, values } = buildCompanyAssignments(input.company);
        if (assignments.length > 0) {
          await tx.query(
            `UPDATE company
                SET ${assignments.join(', ')}, version = version + 1, updated_at = now()
              WHERE id = $1 AND tenant_id = $2`,
            [companyId, principal.tenantId, ...values],
          );
          fields.push(...Object.keys(input.company));
        }
        summary.companyId = companyId;
        company = toCompany(await loadCompany(tx, principal.tenantId, companyId));
      }

      // 响应带 phoneMasked：前端保存后要立刻刷新「我的资料」卡片，
      // 不该为一串掩码再拉一次概览。
      return {
        id: principal.employeeId,
        name,
        phoneMasked: maskPhone(self.phone),
        version,
        company,
      } satisfies SettingsProfile;
    },
  );

  ctx.reply.header('ETag', etagOf(result.version));
  return result;
}
