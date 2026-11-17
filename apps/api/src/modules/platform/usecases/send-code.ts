import { AppError } from '@qingdan/contracts';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../../platform/config.js';
import type { Database } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import type { SmsSender } from '../../../platform/sms/tencent.js';

/**
 * 登录验证码：发送与校验（D59③）。
 *
 * 口径：
 *   - 只存 sha256(phone:code:pepper)，比对用 timingSafeEqual；明文只在发送那一刻存在；
 *   - 非生产不真发短信，固定 `LOGIN_DEV_CODE` 直通（本地/测试零成本）；
 *   - 生产必须真发：短信服务未配置时明确报错（501），不静默放行；
 *   - 频控：同号 60 秒一条、24 小时最多 10 条；
 *   - 输错 5 次该码作废，登录侧统一回 401（不向客户端区分「码错」与「号不存在」）。
 */

const SEND_CODE_ACTION = 'platform.code.send';
const MAX_DAILY_CODES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;

export interface SendCodeContext {
  readonly database: Database | null;
  readonly config: AppConfig;
  readonly smsSender: SmsSender;
  readonly request: FastifyRequest;
}

export interface SendCodeResult {
  readonly sent: true;
}

function isProduction(config: AppConfig): boolean {
  return config.nodeEnv === 'production';
}

export function hashLoginCode(phone: string, code: string, pepper: string): string {
  return createHash('sha256').update(`${phone}:${code}:${pepper}`, 'utf8').digest('hex');
}

function parsePhone(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象');
  }
  const { phone } = body as Record<string, unknown>;
  if (typeof phone !== 'string' || phone.length < 6 || phone.length > 32) {
    throw new AppError('VALIDATION_FAILED', 'phone 不合法', { field: 'phone' });
  }
  return phone;
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * 发码。
 *
 * 顺序刻意是「先发、后落库」：短信发送失败就不留行，用户可立即重试，
 * 也不会出现「库里有一条永远收不到的码」把 60 秒频控占住。
 */
export async function sendLoginCode(ctx: SendCodeContext): Promise<SendCodeResult> {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `${SEND_CODE_ACTION} 尚未实现（数据库未配置）`, {
      operationId: SEND_CODE_ACTION,
    });
  }

  const phone = parsePhone(ctx.request.body);

  const recent = await database.query<{ id: string }>(
    `SELECT id FROM login_code
      WHERE phone = $1
        AND created_at > now() - ($2 || ' seconds')::interval
      ORDER BY created_at DESC
      LIMIT 1`,
    [phone, String(RESEND_SECONDS)],
  );
  if (recent.rows.length > 0) {
    throw new AppError('RATE_LIMITED', '验证码发送过于频繁，请 60 秒后再试', {
      retryAfterSeconds: RESEND_SECONDS,
    });
  }

  const daily = await database.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM login_code
      WHERE phone = $1 AND created_at > now() - interval '24 hours'`,
    [phone],
  );
  if ((daily.rows[0]?.total ?? 0) >= MAX_DAILY_CODES) {
    throw new AppError('RATE_LIMITED', '该手机号今日验证码发送次数已达上限', {
      limit: MAX_DAILY_CODES,
    });
  }

  const code = isProduction(ctx.config) ? generateCode() : ctx.config.loginDevCode;
  const ttlMinutes = ctx.config.loginCodeTtlMinutes;

  if (isProduction(ctx.config)) {
    // 配置缺失时这里抛 SmsNotConfiguredError，由路由层翻译成 501。
    await ctx.smsSender.sendLoginCode({ phone, code, expiresMinutes: ttlMinutes });
  } else {
    // 本地/测试：不发短信，把码写进日志方便排查；登录用固定码直通。
    ctx.request.log.info({ phone, code }, '非生产环境：登录验证码仅打印，不发送短信');
  }

  await database.query(
    `INSERT INTO login_code (id, phone, purpose, code_hash, expires_at, request_ip, request_id)
     VALUES ($1, $2, 'login', $3, now() + ($4 || ' minutes')::interval, $5, $6)`,
    [
      randomUUID(),
      phone,
      hashLoginCode(phone, code, ctx.config.loginCodePepper),
      String(ttlMinutes),
      ctx.request.ip,
      requestIdFor(ctx.request),
    ],
  );

  return { sent: true };
}

/**
 * 校验并消费验证码。返回 false 表示：没有有效码 / 已过期 / 已用过 / 次数超限 / 码不对。
 * 调用方统一按 `UNAUTHENTICATED` 处理，不区分原因。
 */
export async function consumeLoginCode(
  database: Database,
  config: AppConfig,
  phone: string,
  code: string,
): Promise<boolean> {
  const found = await database.query<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM login_code
      WHERE phone = $1
        AND purpose = 'login'
        AND consumed_at IS NULL
        AND expires_at > now()
        AND attempts < $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [phone, MAX_ATTEMPTS],
  );
  const row = found.rows[0];
  if (!row) return false;

  const expected = Buffer.from(hashLoginCode(phone, code, config.loginCodePepper), 'hex');
  const actual = Buffer.from(row.code_hash, 'hex');
  const matched = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!matched) {
    await database.query('UPDATE login_code SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    return false;
  }

  await database.query('UPDATE login_code SET consumed_at = now() WHERE id = $1', [row.id]);
  return true;
}
