import { defineConfig } from 'vitest/config';

/**
 * PGlite（内存 PG）每个测试文件都会在 beforeAll 里独立初始化一个实例并跑完全部迁移。
 * 15 个文件同时并行时，十几个 WASM 实例一起启动 + 迁移会互相抢资源，初始化被拖慢，
 * 偶发超过默认的 10s hook 超时，整个套件因此被 skip（重跑才恢复）。
 *
 * 处理方式：
 * 1. 把涉及数据库的测试文件归入独立 project，并让该 project 内按文件串行执行，
 *    同一时刻最多只有一个 PGlite 在初始化 / 跑迁移；
 * 2. 不涉及数据库的 app.test.ts 单独成组，仍可并行，避免简单全量串行拉长总时长；
 * 3. hook / test 超时统一放宽到 30s，作为慢机器上的兜底（常驻耗时仍在 30s 内）。
 */
export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 30_000,
    projects: [
      {
        test: {
          name: 'db',
          include: ['src/**/*.test.ts'],
          exclude: ['src/app.test.ts'],
          // 每个文件独立初始化 PGlite：串行执行，杜绝多个实例并行互相拖慢。
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'http',
          include: ['src/app.test.ts'],
        },
      },
    ],
  },
});
