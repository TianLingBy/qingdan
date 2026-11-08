import {
  AppError,
  type AuditSource,
  type CompanySubscription,
  type CompanySubscriptionUpdate,
} from '@qingdan/contracts';
import { withAudit, type ActorType } from '../../../platform/audit/writer.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';

/**
 * 公司订阅读取（billing.subscription.read）。
 *
 * - `expires_at = NULL` 表示永久，`daysRemaining = null`、`dueSoon = false`；
 * - `daysRemaining` 按自然日计算：今天到期 = 0，已过期 = 负数；用 UTC 日历日做差，
 *   避免服务器时区导致 `YYYY-MM-DD` 被解析成前一天；
 * - `dueSoon` = 30 天内到期（含已过期），只用于提示续费，不拦任何请求（D1/D12）。
 * - 本函数在调用方已设置 `app.tenant_id` 的事务里执行（company 表 FORCE RLS）。
 */

/** 到期前 30 天进入「即将到期」提醒。 */
export const DUE_SOON_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

interface CompanySubscriptionRow {
  plan: string;
  expires_at: Date | string | null;
  status: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** DATE / date-like 值 → `YYYY-MM-DD`（契约 z.iso.date()）。 */
function toIsoDate(value: Date | string): string {
  if (value instanceof Date) {
    // pg 把 date 解析成本地零点；按本地年月日回写，避免 toISOString() 在 UTC+8 偏移一天。
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  return value.slice(0, 10);
}

/** 把到期日换算成 UTC 日历日序号；只取日期部分，忽略时间。 */
function calendarDayOf(value: Date | string): number {
  if (value instanceof Date) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    throw new AppError('INTERNAL_ERROR', 'company.expires_at 不是合法日期', { expiresAt: value });
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 今天到到期日的整天数（向上取整）；永久返回 null，已过期返回负数。 */
export function daysRemainingUntil(
  expiresAt: Date | string | null,
  now: Date = new Date(),
): number | null {
  if (expiresAt === null) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.ceil((calendarDayOf(expiresAt) - today) / DAY_MS);
}

/** 读取公司订阅；调用方负责租户上下文（withTenant）与 companyId 可见性校验。 */
export async function getCompanySubscription(
  db: SqlClient,
  companyId: string,
): Promise<CompanySubscription> {
  const result = await db.query<CompanySubscriptionRow>(
    'SELECT plan, expires_at, status FROM company WHERE id = $1::uuid',
    [companyId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('NOT_FOUND', '公司不存在或不属于当前租户', { companyId });
  }

  const daysRemaining = daysRemainingUntil(row.expires_at);
  return {
    companyId,
    plan: row.plan,
    expiresAt: row.expires_at === null ? null : toIsoDate(row.expires_at),
    status: row.status as CompanySubscription['status'],
    daysRemaining,
    dueSoon: daysRemaining !== null && daysRemaining <= DUE_SOON_DAYS,
  };
}

// ---------------------------------------------------------------------------
// 运营调整订阅（billing.subscription.update）
//
// 口径：只更新请求里出现的字段（plan / expires_at），expiresAt=null 表示永久；
// 写操作必须与审计同事务提交（appendAudit 失败 ⇒ 订阅修改一并回滚，D51/D55⑤）。
// ---------------------------------------------------------------------------

const UPDATE_ACTION = 'billing.subscription.update';
const COMPANY_OBJECT_TYPE = 'company';

/** 审计所需的请求上下文（路由层从 principal / request 提取）。 */
export interface SubscriptionUpdateActor {
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly credentialId: string | null;
  readonly source: AuditSource;
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface UpdateCompanySubscriptionInput {
  readonly companyId: string;
  readonly patch: CompanySubscriptionUpdate;
  /** 请求头 `X-Reason` 的值（审计必填字段，缺失时为 null）。 */
  readonly reason: string | null;
  readonly actor: SubscriptionUpdateActor;
}

/** 调整套餐 / 到期日并写审计；返回更新后的订阅。 */
export async function updateCompanySubscription(
  db: Database,
  input: UpdateCompanySubscriptionInput,
): Promise<CompanySubscription> {
  const { companyId, patch, reason, actor } = input;

  const sets: string[] = [];
  const params: unknown[] = [companyId];
  const changes: Record<string, unknown> = {};
  if (patch.plan !== undefined) {
    params.push(patch.plan);
    sets.push(`plan = $${params.length}`);
    changes.plan = patch.plan;
  }
  if (patch.expiresAt !== undefined) {
    params.push(patch.expiresAt);
    sets.push(`expires_at = $${params.length}::date`);
    changes.expiresAt = patch.expiresAt;
  }
  if (sets.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'plan 与 expiresAt 至少修改一个');
  }

  return await withAudit(
    db,
    {
      tenantId: actor.tenantId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      credentialId: actor.credentialId,
      source: actor.source,
      action: UPDATE_ACTION,
      objectType: COMPANY_OBJECT_TYPE,
      objectId: companyId,
      changeSummary: changes,
      result: 'success',
      requestId: actor.requestId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      reason,
    },
    async (tx) => {
      const updated = await tx.query(
        `UPDATE company SET ${sets.join(', ')} WHERE id = $1::uuid RETURNING id`,
        params,
      );
      if (updated.rows.length === 0) {
        throw new AppError('NOT_FOUND', '公司不存在或不属于当前租户', { companyId });
      }
      return getCompanySubscription(tx, companyId);
    },
  );
}
