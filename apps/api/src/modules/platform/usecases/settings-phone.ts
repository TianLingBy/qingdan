import {
  AppError,
  SettingsPhoneChangeConfirmSchema,
  SettingsPhoneChangeRequestSchema,
  type SettingsPhoneChangeRequestResult,
  type SettingsPhoneChangeResult,
} from '@qingdan/contracts';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FastifyRequest } from 'fastify';
import { withAudit } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import type { AppConfig } from '../../../platform/config.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import type { SmsSender } from '../../../platform/sms/tencent.js';
import { maskPhone } from './employees.js';
import { hashLoginCode } from './send-code.js';
import { parseBody, settingsAuditEventOf } from './settings-profile.js';

/**
 * 换手机号（`platform.settings.request_phone_change` / `platform.settings.confirm_phone_change`，Issue #298 / D97）。
 *
 * 为什么要两步：手机号就是登录账号。一步改等于「验证码发到哪都算数」——号填错了、
 * 或者别人把自己的号写进你的表单，账号就直接丢了。所以先把新号写进
 * `employee.pending_phone*` 暂存列，**只有新号真的收到码并确认**才动 `employee.phone`。
 *
 * 为什么频控复用 `login_code`：那张表就是「验证码发送流水」，登录码与换号码要防的是
 * 同一件事（短信轰炸 / 穷举），策略也必须一致（60 秒一条、24 小时 10 条）。
 * 另造一张计数表意味着两套阈值迟早漂移，所以只把 `purpose` 枚举放宽一格。
 *
 * 为什么改号成功后要吊销**全部**会话（含当前这条）：手机号是第二因子，
 * 换号等价于「把账号的钥匙换了」。旧设备上的 cookie 还带着旧号的信任关系，
 * 不吊销就等于改号只改了显示。代价是本人也要重新登录——这正是要的效果。
 */

const REQUEST_ACTION = 'platform.settings.request_phone_change';
const CONFIRM_ACTION = 'platform.settings.confirm_phone_change';

/** 换号码有效期 10 分钟：比登录码宽一点（要开短信、看码、回来输），但不至于长期可试。 */
const PHONE_CODE_TTL_MINUTES = 10;
/** 与 `send-code.ts` 同阈值：同号 60 秒一条、24 小时 10 条。 */
const RESEND_SECONDS = 60;
const MAX_DAILY_CODES = 10;

export interface SettingsPhoneContext {
  readonly database: Database | null;
  readonly config: AppConfig;
  readonly smsSender: SmsSender;
  readonly request: FastifyRequest;
}

interface PendingRow {
  phone: string;
  pending_phone: string | null;
  pending_phone_code_hash: string | null;
  pending_phone_expires_at: Date | string | null;
}

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: SettingsPhoneContext): Database {
  const database = ctx.database;
  if (!database) {
    throw new AppError('NOT_IMPLEMENTED', `数据库未配置，${REQUEST_ACTION} 不可用`, {
      operationId: REQUEST_ACTION,
    });
  }
  return database;
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** 定长十六进制比较，避免用 `===` 比哈希（时序侧信道）。长度不同直接判否。 */
function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

/**
 * 手机号平台级唯一检查（`employee_phone_key` 是全局唯一索引，见 `0001_platform_core.sql`）。
 *
 * 走既有 `auth_find_login`（SECURITY DEFINER）而不是自己 SELECT employee：
 * 换号必须能看见**别的租户**是否已占用这个号，否则不同企业可以抢同一个登录账号。
 * 本人当前号本来就在表里，它的那一行按「不能和当前号相同」单独处理。
 *
 * 判定逻辑是**复制**自 `usecases/employees.ts` 的私有函数 `assertPhoneAvailable`
 * （那里没导出，本单又不该改第 1 块的文件，所以没有共用）：
 *   - 同租户占用 → 422 `PHONE_TAKEN`；跨租户占用 → 403 `PHONE_OCCUPIED_OTHER_TENANT`。
 *   - 这里是**拷贝，不是引用**：将来 employees.ts 那条口径变了（比如改成 409、或加离职判定），
 *     本文件不会自动跟着变，必须手工同步。想彻底消掉这个隐患，得把判定抽成一个导出的纯函数
 *     两边共用——那要动第 1 块的文件，留给后续。
 *   - 本函数额外多一条：目标号 == 本人当前号 → 422 `PHONE_UNCHANGED`
 *     （换号接口收到自己的号是操作错误，不是「已占用」，提示语得分得清）。
 */
async function assertPhoneTargetAvailable(
  tx: SqlClient,
  phone: string,
  principal: Principal,
): Promise<void> {
  const result = await tx.query<{ tenant_id: string; employee_id: string }>(
    'SELECT tenant_id, employee_id FROM auth_find_login($1)',
    [phone],
  );
  for (const row of result.rows) {
    if (row.employee_id === principal.employeeId) {
      throw new AppError('VALIDATION_FAILED', '新手机号不能与当前手机号相同', {
        field: 'phone',
        reason: 'PHONE_UNCHANGED',
      });
    }
    if (row.tenant_id === principal.tenantId) {
      throw new AppError('VALIDATION_FAILED', '该手机号在本企业已被占用', {
        field: 'phone',
        reason: 'PHONE_TAKEN',
      });
    }
    throw new AppError(
      'FORBIDDEN',
      '该手机号已被其他企业使用，请联系原企业管理员移除后再加入本企业',
      { field: 'phone', reason: 'PHONE_OCCUPIED_OTHER_TENANT' },
    );
  }
}

/** 频控：与 `send-code.ts` 同两条策略，只查 purpose='phone_change' 的流水。 */
async function assertPhoneChangeRateLimit(tx: SqlClient, phone: string): Promise<void> {
  const recent = await tx.query<{ id: string }>(
    `SELECT id FROM login_code
      WHERE phone = $1 AND purpose = 'phone_change'
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

  const daily = await tx.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM login_code
      WHERE phone = $1 AND purpose = 'phone_change'
        AND created_at > now() - interval '24 hours'`,
    [phone],
  );
  if ((daily.rows[0]?.total ?? 0) >= MAX_DAILY_CODES) {
    throw new AppError('RATE_LIMITED', '该手机号今日验证码发送次数已达上限', {
      limit: MAX_DAILY_CODES,
    });
  }
}

/**
 * 申请换号：校验新号 → 频控 → 发码到新号 → 落暂存列 + 发送流水。
 *
 * 顺序与 `send-code.ts` 一致（先限流、再发短信、最后写库）：失败越早，越不会出现
 * 「短信已经发出去了但库里没有记录」这种既花钱又没法排查的半状态。
 */
export async function requestPhoneChange(
  ctx: SettingsPhoneContext,
): Promise<SettingsPhoneChangeRequestResult> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);
  const { phone } = parseBody(SettingsPhoneChangeRequestSchema, ctx.request.body);

  // 生产随机 6 位；非生产用配置里的固定码，本地/测试才能确定地输对（同 send-code.ts）。
  const isProduction = ctx.config.nodeEnv === 'production';
  const code = isProduction ? generateCode() : ctx.config.loginDevCode;
  const codeHash = hashLoginCode(phone, code, ctx.config.loginCodePepper);
  const summary: Record<string, unknown> = { phoneMasked: maskPhone(phone) };

  const expiresAt = await withAudit(
    database,
    settingsAuditEventOf(ctx.request, principal, REQUEST_ACTION, summary),
    async (tx) => {
      await assertPhoneTargetAvailable(tx, phone, principal);
      await assertPhoneChangeRateLimit(tx, phone);

      if (isProduction) {
        await ctx.smsSender.sendLoginCode({
          phone,
          code,
          expiresMinutes: PHONE_CODE_TTL_MINUTES,
        });
      } else {
        ctx.request.log.info({ phone, code }, '非生产环境：换号验证码仅打印，不发送短信');
      }

      const updated = await tx.query<{ expires_at: Date | string }>(
        `UPDATE employee
            SET pending_phone = $3,
                pending_phone_code_hash = $4,
                pending_phone_expires_at = now() + ($5 || ' minutes')::interval
          WHERE id = $1 AND tenant_id = $2
          RETURNING pending_phone_expires_at AS expires_at`,
        [
          principal.employeeId,
          principal.tenantId,
          phone,
          codeHash,
          String(PHONE_CODE_TTL_MINUTES),
        ],
      );
      const row = updated.rows[0];
      if (!row) {
        throw new AppError('UNAUTHENTICATED', '当前账号已不存在，请重新登录');
      }

      // 与暂存列同一条事务写流水：要么「有申请也有频控记录」，要么都没有。
      await tx.query(
        `INSERT INTO login_code (id, phone, purpose, code_hash, expires_at, request_ip, request_id)
         VALUES ($1, $2, 'phone_change', $3, now() + ($4 || ' minutes')::interval, $5, $6)`,
        [
          uuidv7(),
          phone,
          codeHash,
          String(PHONE_CODE_TTL_MINUTES),
          ctx.request.ip,
          requestIdFor(ctx.request),
        ],
      );

      return isoOf(row.expires_at);
    },
  );

  return {
    phoneMasked: maskPhone(phone),
    resendAfterSeconds: RESEND_SECONDS,
    expiresAt,
  };
}

/**
 * 确认换号：比对哈希 → 验过期 → 一次性消费 → 改号 → 吊销全部会话。
 *
 * 过期/不匹配一律 422，不吞成 200：换号失败却回「成功」会让用户以为号已换好，
 * 下次登录直接登不上。暂存列在失败时**保留**——清空动作写在事务里，
 * 抛错会跟着回滚，硬要清等于白写一次；重新申请自然会覆盖三列。
 */
export async function confirmPhoneChange(
  ctx: SettingsPhoneContext,
): Promise<SettingsPhoneChangeResult> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);
  const { code } = parseBody(SettingsPhoneChangeConfirmSchema, ctx.request.body);
  const summary: Record<string, unknown> = {};

  return withAudit(
    database,
    settingsAuditEventOf(ctx.request, principal, CONFIRM_ACTION, summary),
    async (tx) => {
      const result = await tx.query<PendingRow>(
        `SELECT phone, pending_phone, pending_phone_code_hash, pending_phone_expires_at
           FROM employee
          WHERE id = $1 AND tenant_id = $2`,
        [principal.employeeId, principal.tenantId],
      );
      const self = result.rows[0];
      if (!self) {
        throw new AppError('UNAUTHENTICATED', '当前账号已不存在，请重新登录');
      }
      if (!self.pending_phone || !self.pending_phone_code_hash || !self.pending_phone_expires_at) {
        throw new AppError('VALIDATION_FAILED', '没有待确认的换手机号申请', {
          reason: 'NO_PENDING_PHONE_CHANGE',
        });
      }
      if (new Date(self.pending_phone_expires_at).getTime() <= Date.now()) {
        throw new AppError('VALIDATION_FAILED', '验证码已过期，请重新申请换手机号', {
          reason: 'PHONE_CODE_EXPIRED',
        });
      }

      const expected = hashLoginCode(self.pending_phone, code, ctx.config.loginCodePepper);
      if (!safeEqualHex(expected, self.pending_phone_code_hash)) {
        throw new AppError('VALIDATION_FAILED', '验证码不正确', {
          reason: 'PHONE_CODE_MISMATCH',
        });
      }

      try {
        // 一次性消费：改号与清空暂存列同一条语句，成功后不可能再被用一次。
        await tx.query(
          `UPDATE employee
              SET phone = $3,
                  pending_phone = NULL,
                  pending_phone_code_hash = NULL,
                  pending_phone_expires_at = NULL,
                  version = version + 1
            WHERE id = $1 AND tenant_id = $2`,
          [principal.employeeId, principal.tenantId, self.pending_phone],
        );
      } catch (error) {
        // 申请与确认之间新号被别人抢走（唯一索引兜底）：按入参不合法报，
        // 不要回 500，用户重新申请即可。
        if (isUniqueViolation(error)) {
          throw new AppError('VALIDATION_FAILED', '该手机号刚被其他账号占用，请重新申请', {
            field: 'phone',
            reason: 'PHONE_TAKEN',
          });
        }
        throw error;
      }

      // 吊销本人**全部**有效会话（含当前这条）：旧 token 必须立刻失效，
      // 否则「换号」只换了显示，旧设备照样能用。
      const revoked = await tx.query<{ id: string }>(
        `UPDATE session
            SET revoked_at = now()
          WHERE tenant_id = $1 AND employee_id = $2 AND revoked_at IS NULL
          RETURNING id`,
        [principal.tenantId, principal.employeeId],
      );

      summary.phoneMaskedBefore = maskPhone(self.phone);
      summary.phoneMaskedAfter = maskPhone(self.pending_phone);
      summary.sessionsRevoked = revoked.rows.length;

      return {
        phoneMasked: maskPhone(self.pending_phone),
        sessionsRevoked: revoked.rows.length,
      } satisfies SettingsPhoneChangeResult;
    },
  );
}
