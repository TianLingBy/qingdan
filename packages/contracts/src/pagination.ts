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

/** 页码模式的每页条数默认 20（与游标模式默认 50 不同：页码模式一次只显示一屏）。 */
export const DEFAULT_PAGE_SIZE = 20;

/** 排序方向。 */
export const SortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrderSchema>;

/**
 * 列表查询基类：游标模式（cursor/limit）。**必须保持纯 ZodObject**——各模块用 `.extend()`
 * 追加过滤与排序白名单，包一层 `.refine()` 会让 `.extend()` 直接报错。
 *
 * 页码模式的四个参数**不放这里**：基类被 20 多个列表复用，加在这等于对它们全部承诺
 * 「支持 page/pageSize/sort/order」，而实际只有试点模块认这些参数——契约不能撒谎，
 * 前端照着表头点排序会静默无效。需要页码模式的模块用 `PageableSchema` 自己 extend。
 */
export const PageQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).optional(),
});

/**
 * 页码模式的公共参数，供 `.extend()` 展开：`PageQuerySchema.extend({ ...PageableSchema, sort: z.enum([...]) })`。
 * `sort` 不在这里——白名单因表而异，必须各模块自己给。
 */
export const PageableSchema = {
  /** 页码模式：第几页，从 1 起。与 cursor 互斥。 */
  page: z.coerce.number().int().positive().optional(),
  /** 页码模式：每页条数。与 limit 是同一件事，同时给时 pageSize 优先。 */
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).optional(),
  /** 排序方向，默认 desc（列表默认看最新的）。 */
  order: SortOrderSchema.optional(),
} as const;

export type PagingMode = 'cursor' | 'offset';

export interface ResolvedPaging {
  mode: PagingMode;
  /** 每页条数（cursor 模式即原 limit）。 */
  limit: number;
  /** 仅 offset 模式有意义，cursor 模式恒为 0。 */
  offset: number;
  /** 仅 offset 模式有意义，cursor 模式恒为 1。 */
  page: number;
}

/**
 * 把「游标模式」与「页码模式」归一。
 * 为什么要有互斥：两种模式的分页语义不同（游标靠 id 比较、页码靠 OFFSET），
 * 同时生效会静默丢掉其中一个条件，翻页结果错乱却看不出错，所以直接报错
 * （VALIDATION_FAILED → HTTP 422，与其它入参校验同一口径）。
 * 只带 cursor → 游标模式；只带 page → 页码模式；都不带 → 页码模式第 1 页（前端默认要看到页码条）。
 */
export function resolvePaging(query: {
  cursor?: string | undefined;
  limit?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}): ResolvedPaging {
  if (query.cursor !== undefined && query.page !== undefined) {
    throw new AppError('VALIDATION_FAILED', 'page 与 cursor 不能同时使用', { field: 'page' });
  }
  // 只带 limit 时仍是游标模式：老前端就是「先 ?limit=N 拿 nextCursor，再带 cursor 翻下一页」，
  // 把 limit 当成页码模式会直接让它拿不到 nextCursor（老行为必须一行不变）。
  const hasOffsetParam = query.page !== undefined || query.pageSize !== undefined;
  if (query.cursor !== undefined || (!hasOffsetParam && query.limit !== undefined)) {
    return { mode: 'cursor', limit: clampLimit(query.limit), offset: 0, page: 1 };
  }
  const limit = clampLimit(query.pageSize ?? query.limit ?? DEFAULT_PAGE_SIZE);
  const page = query.page ?? 1;
  return { mode: 'offset', limit, offset: (page - 1) * limit, page };
}

/**
 * 页码模式的分页响应。total 是该过滤条件下的总条数，前端据此算总页数。
 * cursor 模式下 total/page/pageSize 一律为 null——老调用方只读 items 与 nextCursor，行为不变。
 */
export function pagedResultSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative().nullable(),
    page: z.number().int().positive().nullable(),
    pageSize: z.number().int().positive().nullable(),
    nextCursor: CursorSchema.nullable(),
  });
}
