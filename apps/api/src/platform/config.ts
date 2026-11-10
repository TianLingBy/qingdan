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

/**
 * `TRUST_PROXY`：默认 `false`，不信任任何代理头（`X-Forwarded-For` 不可伪造 `request.ip`）。
 *   - `false` / 空串 → 不信任；
 *   - `true` → 信任所有代理（仅限确定处于可信反向代理之后时使用）；
 *   - 逗号分隔的网段 / 地址 → 只信任这些代理（如 `10.0.0.0/8,127.0.0.1`），原样交给 Fastify。
 */
const TRUST_PROXY = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'false') return false;
    if (trimmed.toLowerCase() === 'true') return true;
    const list = trimmed
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    return list.length > 0 ? list : false;
  },
  z.union([z.boolean(), z.array(z.string().min(1))]).default(false),
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
  /** 反向代理信任策略；默认 false，避免 `X-Forwarded-For` 伪造 `request.ip`。 */
  TRUST_PROXY,
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
  /**
   * Fastify `trustProxy`：`false` 不信任代理头；`true` 信任全部；
   * 数组 = 只信任列出的地址 / 网段。
   */
  readonly trustProxy: boolean | readonly string[];
}

/**
 * 本机地址白名单：`PUBLIC_BASE_URL` 指向这些主机时不可能对公网提供同源 Cookie 写操作。
 * `NODE_ENV=production` 下出现即拒绝启动（2026-11-10 负责人拍板）。
 */
// 注意：WHATWG URL 的 hostname 对 IPv6 保留方括号（`new URL('http://[::1]').hostname === '[::1]'`），
// 所以这里同时列出带括号与不带括号两种写法。
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/**
 * 校验 `PUBLIC_BASE_URL`（D59⑧：Cookie 同源校验只认这个基址）。
 *
 * - 非空时必须能解析成绝对 http(s) URL，否则配置写错会让所有写操作 403；
 * - production 下不允许指向本机地址——上线漏配的典型表现是「本地开发正常、部署后写操作全 403」，
 *   与其让运维在运行时排查，不如启动即失败。
 */
function assertPublicBaseUrl(publicBaseUrl: string, nodeEnv: Env['NODE_ENV']): void {
  if (publicBaseUrl === '') return;
  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    throw new ConfigError(
      `PUBLIC_BASE_URL 不是合法 URL：${publicBaseUrl}（需形如 https://qingdan.example.com，不带结尾斜杠）`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(
      `PUBLIC_BASE_URL 只支持 http / https 协议，收到：${publicBaseUrl}`,
    );
  }
  if (nodeEnv === 'production' && LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new ConfigError(
      `PUBLIC_BASE_URL 在生产环境不能指向本机地址（收到 ${publicBaseUrl}）：` +
        '浏览器 Origin 与它不一致时所有写操作都会 403，请填实际上线域名或服务器 IP。',
    );
  }
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
  const publicBaseUrl = (value.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  assertPublicBaseUrl(publicBaseUrl, value.NODE_ENV);
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    databaseUrl: value.DATABASE_URL,
    logLevel: value.LOG_LEVEL,
    loginDevCode: value.LOGIN_DEV_CODE,
    sessionTtlDays: value.SESSION_TTL_DAYS,
    appTimezone: value.APP_TIMEZONE,
    publicBaseUrl,
    trustProxy: Array.isArray(value.TRUST_PROXY)
      ? Object.freeze([...value.TRUST_PROXY])
      : value.TRUST_PROXY,
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
    trustProxy: false,
    ...overrides,
  });
}
