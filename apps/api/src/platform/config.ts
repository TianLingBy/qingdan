import { z } from 'zod';

/**
 * 环境变量校验（启动 fail-fast）。
 *
 * 约定：
 * - 所有环境变量在进程启动时一次性校验，缺项/类型错直接抛错退出，不做「运行期再补默认」；
 * - `DATABASE_URL` 可选：M0 骨架里端点全是 501，没有数据库也能起（但接真实业务前必须配）；
 * - 只暴露 camelCase 的只读配置对象，模块不直接读 `process.env`。
 */

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
const NODE_ENVS = ['development', 'test', 'production'] as const;

/** 空串按「未提供」处理（`.env` 里常见的 `KEY=` 写法）。 */
const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  DATABASE_URL: optionalString,
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** 一期不发短信（D54④）：非生产环境用固定验证码；production 未接服务商时端点返回 501。 */
  LOGIN_DEV_CODE: z.string().trim().min(1).default('000000'),
  /** 会话闲置滑动续期窗口（D59⑦）。 */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** 业务日 / 取号月键 / 工号日期统一按该时区（D59④）。 */
  APP_TIMEZONE: z.string().trim().min(1).default('Asia/Shanghai'),
  /** 对外基址；空 = 按请求 Host 推断同源（D59⑧ 同源校验）。 */
  PUBLIC_BASE_URL: optionalString,
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string | undefined;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly loginDevCode: string;
  readonly sessionTtlDays: number;
  readonly appTimezone: string;
  /** 空串 = 未配置，按请求 Host 推断同源。 */
  readonly publicBaseUrl: string;
}

/**
 * 读取并校验配置；校验失败时抛 `ConfigError`（main 里捕获后 `process.exit(1)`）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`环境变量校验失败：\n${issues}`);
  }
  const value = parsed.data;
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    databaseUrl: value.DATABASE_URL,
    logLevel: value.LOG_LEVEL,
    loginDevCode: value.LOGIN_DEV_CODE,
    sessionTtlDays: value.SESSION_TTL_DAYS,
    appTimezone: value.APP_TIMEZONE,
    publicBaseUrl: value.PUBLIC_BASE_URL ?? '',
  });
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 仅用于测试与本地开发的默认配置（不读环境变量）。 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return Object.freeze({
    nodeEnv: 'test',
    port: 3000,
    host: '127.0.0.1',
    databaseUrl: undefined,
    logLevel: 'silent',
    loginDevCode: '000000',
    sessionTtlDays: 7,
    appTimezone: 'Asia/Shanghai',
    publicBaseUrl: '',
    ...overrides,
  });
}
