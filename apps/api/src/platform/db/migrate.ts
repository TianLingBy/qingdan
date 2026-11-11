import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppError } from '@qingdan/contracts';
import { createPgDatabase, type Database } from './client.js';

/**
 * 纯 SQL 迁移 runner（前向 only）。
 *
 * - 迁移文件放 `apps/api/migrations/*.sql`，按文件名升序执行；
 * - 每个文件一个事务：SQL + `schema_migrations` 记录同事务提交，失败整体回滚；
 * - 已执行文件的 checksum 与库里不一致 → 直接失败（防「改了历史迁移」的漂移）；
 * - 不提供 down：回滚靠新迁移前滚。
 *
 * 目录用 `import.meta.url` 相对定位，src（tsx / vitest）与 dist 两种运行形态都能找到。
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

export interface MigrationFile {
  readonly id: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export type MigrationLog = (message: string) => void;

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function loadMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    throw new Error(`迁移目录不可读：${dir}（${String(error)}）`, { cause: error });
  }
  const files = entries.filter((name) => name.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
  const loaded: MigrationFile[] = [];
  for (const id of files) {
    const sql = await readFile(path.join(dir, id), 'utf8');
    loaded.push({ id, checksum: checksumOf(sql), sql });
  }
  return loaded;
}

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/**
 * 执行全部未应用迁移。返回本次实际执行与跳过的文件名。
 */
export async function runMigrations(
  db: Database,
  options: { dir?: string; log?: MigrationLog } = {},
): Promise<MigrationReport> {
  const log = options.log ?? (() => undefined);
  const files = await loadMigrationFiles(options.dir ?? MIGRATIONS_DIR);
  await ensureMigrationsTable(db);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const existing = await db.query<{ checksum: string }>(
      `SELECT checksum FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = $1`,
      [file.id],
    );
    const record = existing.rows[0];
    if (record) {
      if (record.checksum !== file.checksum) {
        throw new AppError(
          'INTERNAL_ERROR',
          `迁移 ${file.id} 的 checksum 与已应用记录不一致：历史迁移被修改过`,
          { id: file.id, expected: record.checksum, actual: file.checksum },
        );
      }
      skipped.push(file.id);
      continue;
    }

    log(`applying ${file.id}`);
    await db.transaction(async (tx) => {
      await tx.exec(file.sql);
      await tx.query(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (id, checksum) VALUES ($1, $2)`, [
        file.id,
        file.checksum,
      ]);
    });
    applied.push(file.id);
  }

  return { applied, skipped };
}

/**
 * CLI 入口：`pnpm -C apps/api migrate`。
 * 需要 `DATABASE_URL`；缺省直接失败（迁移从不猜数据库地址）。
 */
export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL，无法执行迁移');
    process.exitCode = 1;
    return;
  }
  const { database } = createPgDatabase(databaseUrl);
  try {
    const report = await runMigrations(database, { log: (message) => console.log(`[migrate] ${message}`) });
    console.log(
      `[migrate] 完成：applied=${report.applied.length} skipped=${report.skipped.length}`,
    );
  } finally {
    await database.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('[migrate] 失败', error);
    process.exitCode = 1;
  });
}
