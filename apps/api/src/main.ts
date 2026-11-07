import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './platform/config.js';
import { createPgDatabase } from './platform/db/client.js';

/**
 * 进程入口：读配置 → 建数据库（可选）→ buildApp → listen → 优雅退出。
 *
 * 配置错误直接 fail-fast（退出码 1），不做「缺配置也能起」的兜底。
 */

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[api] 启动失败：${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const pg = config.databaseUrl ? createPgDatabase(config.databaseUrl) : undefined;
  if (!pg) {
    console.warn('[api] 未配置 DATABASE_URL：骨架端点可访问，但业务与迁移不可用');
  }

  const app = buildApp({ config, database: pg?.database ?? null });
  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, '收到退出信号，优雅关闭');
    await app.close();
    await pg?.database.close();
  };

  process.once('SIGINT', () => void close('SIGINT'));
  process.once('SIGTERM', () => void close('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error(error, 'API 启动失败');
    await pg?.database.close();
    process.exitCode = 1;
  }
}

await main();
