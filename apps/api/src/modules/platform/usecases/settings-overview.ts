import {
  AppError,
  DOCUMENT_TYPES,
  allowsScope,
  formatDocumentNo,
  type DocumentType,
  type ScopeMatrix,
  type SettingsOverview,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Principal } from '../../../platform/auth/principal.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import {
  DOCUMENT_SEQUENCE_MAX,
  documentScopeKey,
} from '../../../platform/numbering/service.js';
import { maskPhone } from './employees.js';

/**
 * 设置中心概览（`platform.settings.overview`，Issue #298 / D93）。
 *
 * 口径：
 *   - 必须先有 `company.read`：没有权限直接 403，**不返回 `companies: []`**
 *     （否则前端会把「没权限」显示成「没有公司」，design-settings-center §5.3②）；
 *   - 公司范围只取 `principal.companyIds`（computeAuthz 已算好：老板 = 全租户，
 *     其余 = 绑定公司），服务端过滤，客户端传参不能放大；
 *   - 手机号只回脱敏值（复用员工列表的 `maskPhone`，不另写一份）；
 *   - `permissions` 直接取 principal 的生效 scope，不在概览里重算权限表，
 *     避免与认证链路出现两份不一致的结果。
 *
 * 查询次数固定为 2，与公司数量无关：
 *   ① 主聚合一条 SQL 拿齐 tenant / companies / me / positions；
 *   ② 编号预览按「选定公司的 8 个 scope_key」一次查 number_sequence。
 * 不对每个公司单独查一次，因此没有 N+1。
 */

const ACTION = 'platform.settings.overview';

/** 单据类型顺序与 DOCUMENT_TYPES 的声明顺序一致（A/B/E/N/C/R/S/I）。 */
const DOCUMENT_TYPE_LIST = Object.keys(DOCUMENT_TYPES) as DocumentType[];
/** D16 固定格式；自定义编号不做（design-settings-center §八 E2）。 */
const DOCUMENT_RULE = '类型字母-公司码(4)-日期(8)-流水(4)';

export interface SettingsOverviewContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

interface OverviewRow {
  tenant: unknown;
  companies: unknown;
  me: unknown;
  positions: unknown;
}

interface TenantJson {
  id: string;
  name: string;
  status: '启用' | '停用';
}

interface CompanyJson {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  address: string | null;
  contactPhone: string | null;
  taxNo: string | null;
  logoUrl: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface MeJson {
  name: string;
  phone: string;
}

interface PositionJson {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
}

interface SequenceRow {
  scope_key: string;
  last_value: number;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: SettingsOverviewContext): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${ACTION} 不可用`, {
      operationId: ACTION,
    });
  }
  return database;
}

/** pg / PGlite 对 json 列可能回对象，也可能回字符串；统一成对象。 */
function jsonValue<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

/**
 * 主聚合 SQL：一条语句拿齐首屏数据。
 *
 * - `visible_companies` 只取 principal.companyIds，且与租户双重过滤；
 * - `my_positions` 来自 employee_company_position（一人多岗、多公司）；
 * - 公司四列扩展资料只读，不在这里做写入。
 */
const OVERVIEW_SQL = `WITH me AS (
  SELECT e.name, e.phone
  FROM employee e
  WHERE e.id = $2 AND e.tenant_id = $1
),
visible_companies AS (
  SELECT c.id, c.tenant_id, c.code, c.name,
         c.address, c.contact_phone, c.tax_no, c.logo_url,
         c.version, c.created_at, c.updated_at
  FROM company c
  WHERE c.tenant_id = $1 AND c.id = ANY($3::uuid[])
),
my_positions AS (
  SELECT DISTINCT p.id, p.name, c.id AS company_id, c.name AS company_name
  FROM employee_company_position ecp
  JOIN position p ON p.id = ecp.position_id AND p.tenant_id = ecp.tenant_id
  JOIN company c ON c.id = ecp.company_id AND c.tenant_id = ecp.tenant_id
  WHERE ecp.employee_id = $2 AND ecp.tenant_id = $1
)
SELECT
  (SELECT json_build_object('id', t.id, 'name', t.name, 'status', t.status)
     FROM tenant t WHERE t.id = $1) AS tenant,
  (SELECT coalesce(json_agg(json_build_object(
     'id', c.id, 'tenantId', c.tenant_id, 'code', c.code, 'name', c.name,
     'address', c.address, 'contactPhone', c.contact_phone,
     'taxNo', c.tax_no, 'logoUrl', c.logo_url,
     'version', c.version, 'createdAt', c.created_at, 'updatedAt', c.updated_at
   ) ORDER BY c.code), '[]'::json) FROM visible_companies c) AS companies,
  (SELECT json_build_object('name', m.name, 'phone', m.phone) FROM me m) AS me,
  (SELECT coalesce(json_agg(json_build_object(
     'id', p.id, 'name', p.name,
     'companyId', p.company_id, 'companyName', p.company_name
   ) ORDER BY p.company_id, p.name), '[]'::json) FROM my_positions p) AS positions`;

/**
 * 编号预览：给定「选定公司 + 当前月」，读 number_sequence 的当前值再 +1。
 * 不调用 takeDocumentNo（那会真的取号并自增），预览必须是只读的。
 */
async function buildNumbering(
  tx: SqlClient,
  tenantId: string,
  company: CompanyJson | undefined,
  now: Date,
): Promise<SettingsOverview['numbering']> {
  if (!company) return [];

  const keys = DOCUMENT_TYPE_LIST.map((type) => documentScopeKey(type, now, company.id));
  const result = await tx.query<SequenceRow>(
    `SELECT scope_key, last_value
       FROM number_sequence
      WHERE tenant_id = $1 AND scope_key = ANY($2::text[])`,
    [tenantId, keys],
  );
  const lastValues = new Map(result.rows.map((row) => [row.scope_key, Number(row.last_value)]));

  return DOCUMENT_TYPE_LIST.map((type) => {
    const sequence = (lastValues.get(documentScopeKey(type, now, company.id)) ?? 0) + 1;
    return {
      type,
      rule: DOCUMENT_RULE,
      // 用满 9999 时不再给号（与取号服务同口径），前端显示「已用满」。
      next:
        sequence <= DOCUMENT_SEQUENCE_MAX
          ? formatDocumentNo({
              type,
              companyCode: Number(company.code),
              date: now,
              sequence,
            })
          : null,
    };
  });
}

/** principal 的 ScopeMatrix 展平成 `{ domain, action }[]`（B5 只读清单）。 */
function buildPermissions(scope: ScopeMatrix): SettingsOverview['permissions'] {
  const permissions: SettingsOverview['permissions'] = [];
  for (const entry of scope) {
    for (const action of entry.actions) {
      permissions.push({ domain: entry.domain, action });
    }
  }
  return permissions.sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.action.localeCompare(b.action),
  );
}

export async function getSettingsOverview(
  ctx: SettingsOverviewContext,
): Promise<SettingsOverview> {
  const principal = requirePrincipal(ctx.request);

  // §5.3②：没有权限必须 403，不能返回空公司数组冒充「没有公司」。
  if (!allowsScope(principal.scope, 'company', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 company.read 权限');
  }

  const database = requireDatabase(ctx);
  const now = new Date();

  const { row, numbering } = await withTenant(database, principal.tenantId, async (tx) => {
    const result = await tx.query<OverviewRow>(OVERVIEW_SQL, [
      principal.tenantId,
      principal.employeeId,
      [...principal.companyIds],
    ]);
    const overviewRow = result.rows[0];
    if (!overviewRow) throw new AppError('UNAUTHENTICATED');

    const companies = jsonValue<CompanyJson[]>(overviewRow.companies, []);
    // 主公司 = 可访问公司里公司码最小的一家（SQL 已按 code 排序）。
    return {
      row: overviewRow,
      numbering: await buildNumbering(tx, principal.tenantId, companies[0], now),
    };
  });

  const tenant = jsonValue<TenantJson | null>(row.tenant, null);
  const me = jsonValue<MeJson | null>(row.me, null);
  if (!tenant || !me) throw new AppError('UNAUTHENTICATED');

  const companies = jsonValue<CompanyJson[]>(row.companies, []);
  const positions = jsonValue<PositionJson[]>(row.positions, []);

  return {
    tenant,
    companies,
    numbering,
    me: {
      name: me.name,
      phoneMasked: maskPhone(me.phone),
      companies,
      positions,
    },
    permissions: buildPermissions(principal.scope),
  };
}
