import { z } from 'zod';

/** dryRun 预检结果（D54 缺口 7）：成功与失败都回 200，`valid=false` 时 errors 非空。 */
export const DryRunChangeSchema = z.object({
  operation: z.enum(['create', 'update', 'delete']),
  entity: z.string(),
  id: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
});

export const DryRunIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.array(z.string()).optional(),
});

export const DryRunResultSchema = z.object({
  dryRun: z.literal(true),
  valid: z.boolean(),
  changes: z.array(DryRunChangeSchema),
  errors: z.array(DryRunIssueSchema),
});
export type DryRunResult = z.infer<typeof DryRunResultSchema>;

/** 乐观锁：ETag 用强串 `"<version>"`；更新类强制 If-Match，缺失回 428（D54 缺口 5）。 */
export function etagOf(version: number): string {
  return `"${version}"`;
}

export function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^\s*"?(\d+)"?\s*$/.exec(header);
  return m && m[1] ? Number(m[1]) : null;
}

/** 金额一律 decimal 字符串（D55：存储 numeric(18,6)，展示四舍五入到 2 位）。 */
export const MoneySchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,6})?$/, '金额必须是 decimal 字符串（最多 6 位小数）');

export const Money2Schema = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, '金额必须是最多 2 位小数的 decimal 字符串');
