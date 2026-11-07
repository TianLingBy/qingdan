import { z } from 'zod';
import { AppError } from './errors.js';

/** 游标分页（契约第三批 §3）：不透明游标 + limit 默认 50 / 上限 200。 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export const CursorSchema = z.string().min(1);

export interface CursorPayload {
  /** keyset 第一列，ISO 8601；与 id 组成唯一序。 */
  createdAt: string;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('VALIDATION_FAILED', 'cursor 无法解码', { field: 'cursor' });
  }
  const result = z.object({ createdAt: z.string().datetime(), id: z.string() }).safeParse(parsed);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 'cursor 内容不合法', { field: 'cursor' });
  }
  return result.data;
}

/** 非法 limit 视为不带（按默认 50），超过上限按 200 截断——不报错，避免分页参数把列表打挂。 */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(n), MAX_PAGE_LIMIT);
}

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: CursorSchema.nullable(),
  });
}

export const PageQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).optional(),
});
