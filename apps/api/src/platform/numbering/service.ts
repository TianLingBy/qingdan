import {
  AppError,
  formatDocumentNo,
  formatEmployeeNo,
  type DocumentType,
} from '@qingdan/contracts';
import type { SqlClient } from '../db/client.js';

/**
 * 取号服务（D16 / D48 / domain-model §3）。
 *
 * 并发安全靠「单行原子自增」：`INSERT ... ON CONFLICT (tenant_id, scope_key) DO UPDATE SET last_value = +1 RETURNING`，
 * 一条语句完成「取新值并返回」，不需要外部锁、不需要先读再写。
 *
 * 按月重置 = 换键（scope_key 里带 yyyyMM），不是清表；跨月 0 点不会与上月流水撞号。
 * 时区口径：日期取 `date` 的 UTC 年月（与 `formatDocumentNo` 的 UTC 取日一致）。N2「业务日取哪个时区」
 * 在 decisions 里仍标未定，这里沿用契约包现有的 UTC 约定，已在交付报告里标为未验证项。
 */

export const DOCUMENT_SEQUENCE_MAX = 9999;
export const EMPLOYEE_SEQUENCE_MAX = 999999;
export const EMPLOYEE_SCOPE_KEY = 'employee';

function monthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

/**
 * 单据流水的计数键：按「公司 + 类型 + 年月」分开（D16：流水按公司、单公司月内 9999）。
 * 公司维度不可省——否则同租户两家公司会共享流水号，违反 D16 且跨公司撞号。
 */
export function documentScopeKey(type: DocumentType, date: Date, companyId: string): string {
  return `document:${companyId}:${type}:${monthKey(date)}`;
}

interface DocumentSequenceRow {
  last_value: number;
  company_code: string;
}

/**
 * 取下一个单据号：`类型字母-公司码(4)-日期(8)-流水(4)`。
 * 必须传业务事务的 tx（同事务取号，回滚即弃号；domain-model §3.3 N3 推荐「允许跳号」）。
 */
export async function takeDocumentNo(
  tx: SqlClient,
  type: DocumentType,
  companyId: string,
  date: Date,
): Promise<string> {
  const scopeKey = documentScopeKey(type, date, companyId);
  const result = await tx.query<DocumentSequenceRow>(
    `WITH company_row AS (
       SELECT id, tenant_id, code AS company_code
       FROM company
       WHERE id = $1
     ), upserted AS (
       INSERT INTO number_sequence (tenant_id, scope_key, last_value)
       SELECT tenant_id, $2, 1 FROM company_row
       ON CONFLICT (tenant_id, scope_key) DO UPDATE
         SET last_value = number_sequence.last_value + 1,
             updated_at = now()
         WHERE number_sequence.last_value < $3
       RETURNING last_value
     )
     SELECT u.last_value, c.company_code
     FROM upserted u
     CROSS JOIN company_row c`,
    [companyId, scopeKey, DOCUMENT_SEQUENCE_MAX],
  );

  const row = result.rows[0];
  if (!row) {
    const company = await tx.query('SELECT 1 FROM company WHERE id = $1', [companyId]);
    if (company.rows.length === 0) {
      throw new AppError('NOT_FOUND', '公司不存在', { companyId });
    }
    // 容量耗尽必须显式失败，禁止回绕（domain-model §3.3 第 5 条）。
    throw new AppError(
      'VALIDATION_FAILED',
      `${type} 单在 ${monthKey(date)} 的月流水已用满 ${DOCUMENT_SEQUENCE_MAX}，需扩容后再建单`,
      { type, scopeKey },
    );
  }

  return formatDocumentNo({
    type,
    companyCode: Number(row.company_code),
    date,
    sequence: Number(row.last_value),
  });
}

interface EmployeeSequenceRow {
  last_value: number;
}

/**
 * 取下一个工号：6 位数字、租户级全局唯一、不按月重置、不带公司前缀（D48）。
 */
export async function takeEmployeeNo(tx: SqlClient, tenantId: string): Promise<string> {
  const tenant = await tx.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError('NOT_FOUND', '租户不存在', { tenantId });
  }

  const result = await tx.query<EmployeeSequenceRow>(
    `INSERT INTO number_sequence (tenant_id, scope_key, last_value)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, scope_key) DO UPDATE
       SET last_value = number_sequence.last_value + 1,
           updated_at = now()
       WHERE number_sequence.last_value < $3
     RETURNING last_value`,
    [tenantId, EMPLOYEE_SCOPE_KEY, EMPLOYEE_SEQUENCE_MAX],
  );

  const row = result.rows[0];
  if (!row) {
    throw new AppError(
      'VALIDATION_FAILED',
      `工号流水已用满 ${EMPLOYEE_SEQUENCE_MAX}，需扩容后再建员工`,
      { tenantId },
    );
  }
  return formatEmployeeNo(Number(row.last_value));
}
