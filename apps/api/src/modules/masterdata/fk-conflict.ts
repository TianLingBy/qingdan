import { AppError } from '@qingdan/contracts';

/**
 * PostgreSQL 引用冲突：`foreign_key_violation`（23503）或 `restrict_violation`（23001）。
 *
 * 主数据改成物理删除后，只要仍被单据 / 子表引用（外键 `ON DELETE RESTRICT`），
 * `DELETE` 就会失败；调用方据此翻译成可读的 409，而不是 500。
 *
 * 注意：`ON DELETE RESTRICT` 在 PG 里由独立的 restrict 触发器实现，报的是 23001
 * （`update or delete on table ... violates RESTRICT setting of foreign key`），
 * 不是 INSERT 场景的 23503；两者都要识别。
 */
export function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === '23503' || code === '23001';
}

/**
 * 外键冲突 → 409 `STATE_CONFLICT`（资源存在、版本也对，只是「仍被引用」不允许删）。
 * `reason = HAS_REFERENCES` 供前端按原因出人话；`entityLabel` 区分四个主数据实体。
 */
export function rethrowIfReferenced(error: unknown, entityLabel: string): never {
  if (isForeignKeyViolation(error)) {
    throw new AppError('STATE_CONFLICT', `该${entityLabel}还有单据在用，不能删除`, {
      reason: 'HAS_REFERENCES',
    });
  }
  throw error;
}
