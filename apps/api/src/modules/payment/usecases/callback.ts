import {
  AppError,
  type PaymentCallbackResult,
  type PaymentChannel,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import { flushAuditOutbox } from '../../../platform/audit/writer.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database } from '../../../platform/db/client.js';
import { salesReceiptPort } from '../../../platform/services/registry.js';
import * as repo from '../repo.js';
import {
  verifyAlipayCallback,
  type AlipayCallbackForm,
} from '../services/alipay-signature.js';
import {
  readMerchantConfig,
  type AlipayMerchantConfig,
  type WechatMerchantConfig,
} from '../services/merchant-config.js';
import { verifyWechatCallback } from '../services/wechat-signature.js';

/**
 * 支付回调用例（#101）。
 *
 * 流程：
 *   1. path `:channel` → 渠道；
 *   2. 用商户号 / 应用号反查公司（遍历商户配置，不解析 E 单单号前缀）；
 *   3. 验签 / 解密（失败 401）；
 *   4. 经 sales 端口按 `out_trade_no` 找 E 单 → 金额必须等于应收余额（否则 422）；
 *   5. `recordCallback` 幂等闸门：重复投递直接返回原 receiptId；
 *   6. 首次入账：端口写收款行 + 审计 → `attachReceipt` → 返回。
 *
 * 全程同一业务事务；事务提交后搬审计 outbox（D55⑤）。
 */

export interface PaymentCallbackContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

interface ResolvedCallback {
  readonly companyId: string;
  readonly channel: PaymentChannel;
  readonly outTradeNo: string;
  readonly transactionId: string;
  /** decimal 字符串（D54）。 */
  readonly amount: string;
}

const CHANNELS: ReadonlySet<string> = new Set(['wechat', 'alipay']);
const CONFIG_ENV = 'QINGDAN_PAYMENT_CONFIG';

const WECHAT_SIGNATURE_ERROR = '微信回调验签失败';
const ALIPAY_SIGNATURE_ERROR = '支付宝回调验签失败';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseChannel(params: unknown): PaymentChannel {
  const channel = isRecord(params) ? params.channel : undefined;
  if (typeof channel === 'string' && CHANNELS.has(channel)) {
    return channel as PaymentChannel;
  }
  throw new AppError('VALIDATION_FAILED', `未知支付渠道：${String(channel)}`, {
    field: 'channel',
  });
}

/** 配置按 companyId 分渠道存放；这里只枚举公司键，不读取 / 回显密钥。 */
function configCompanyIds(): string[] {
  const raw = process.env[CONFIG_ENV];
  if (raw === undefined || raw.trim() === '') {
    throw new AppError('VALIDATION_FAILED', `缺少支付商户配置：环境变量 ${CONFIG_ENV} 未设置`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError('VALIDATION_FAILED', `环境变量 ${CONFIG_ENV} 不是合法 JSON`);
  }
  if (!isRecord(parsed)) {
    throw new AppError('VALIDATION_FAILED', `环境变量 ${CONFIG_ENV} 必须是 JSON 对象`);
  }
  return Object.keys(parsed);
}

/** 微信：先按配置遍历试签 / 解密，成功者即回调所属公司（不解单号前缀）。 */
function resolveWechatCallback(
  headers: FastifyRequest['headers'],
  rawBody: string,
): ResolvedCallback {
  const configs: Array<{ companyId: string; config: WechatMerchantConfig }> = [];
  for (const companyId of configCompanyIds()) {
    try {
      configs.push({ companyId, config: readMerchantConfig(companyId, 'wechat') });
    } catch {
      // 其它公司配置不全不影响本回调；全部不匹配时再统一报错。
    }
  }
  if (configs.length === 0) {
    throw new AppError('VALIDATION_FAILED', '未配置任何完整的微信支付商户信息');
  }

  for (const { companyId, config } of configs) {
    let result;
    try {
      result = verifyWechatCallback({ headers, rawBody, config });
    } catch (error) {
      // 验签 / 解密失败 → 换下一家；解密成功后的字段 / 金额错误直接上抛。
      if (error instanceof AppError && error.code === 'UNAUTHENTICATED') continue;
      throw error;
    }

    if (result.tradeState !== 'SUCCESS') {
      throw new AppError('VALIDATION_FAILED', '微信回调交易状态非成功，不入账', {
        tradeState: result.tradeState,
      });
    }

    return {
      companyId,
      channel: 'wechat',
      outTradeNo: result.outTradeNo,
      transactionId: result.transactionId,
      amount: fenToDecimal(result.amountTotalFen),
    };
  }

  throw new AppError('UNAUTHENTICATED', WECHAT_SIGNATURE_ERROR);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/**
 * 支付宝回调是 form 编码；同时兼容 `application/json` 与 `text/plain`。
 * 表单值由 URLSearchParams 解码后参与验签（与支付宝服务端一致）。
 */
function parseAlipayForm(body: unknown): AlipayCallbackForm {
  const form: Record<string, string> = {};

  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            const text = stringValue(value);
            if (text !== undefined) form[key] = text;
          }
          return form;
        }
      } catch {
        // 不是 JSON：回退按 form 解析。
      }
    }
    for (const [key, value] of new URLSearchParams(trimmed)) {
      form[key] = value;
    }
    return form;
  }

  if (isRecord(body)) {
    for (const [key, value] of Object.entries(body)) {
      const text = stringValue(value);
      if (text !== undefined) form[key] = text;
    }
    return form;
  }

  throw new AppError('UNAUTHENTICATED', ALIPAY_SIGNATURE_ERROR);
}

/** 支付宝：`app_id` 明文可达，按配置遍历反查公司后再验签。 */
function resolveAlipayCallback(body: unknown): ResolvedCallback {
  const form = parseAlipayForm(body);
  const appId = form.app_id;
  if (!appId) {
    throw new AppError('UNAUTHENTICATED', ALIPAY_SIGNATURE_ERROR);
  }

  const configs: Array<{ companyId: string; config: AlipayMerchantConfig }> = [];
  for (const companyId of configCompanyIds()) {
    try {
      const config = readMerchantConfig(companyId, 'alipay');
      if (config.appId === appId) configs.push({ companyId, config });
    } catch {
      // 未配置支付宝 / 配置不全的公司跳过。
    }
  }
  if (configs.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      '未找到与回调 app_id 匹配的支付宝支付商户配置',
      { channel: 'alipay' },
    );
  }

  for (const { companyId, config } of configs) {
    const result = verifyAlipayCallback({ form, config });
    if (result.tradeStatus !== 'TRADE_SUCCESS' && result.tradeStatus !== 'TRADE_FINISHED') {
      throw new AppError('VALIDATION_FAILED', '支付宝回调交易状态非成功，不入账', {
        tradeStatus: result.tradeStatus,
      });
    }
    return {
      companyId,
      channel: 'alipay',
      outTradeNo: result.outTradeNo,
      transactionId: result.tradeNo,
      amount: result.totalAmount,
    };
  }

  throw new AppError('UNAUTHENTICATED', ALIPAY_SIGNATURE_ERROR);
}

/** 微信金额单位是「分」；转成 decimal 字符串比较（避免浮点）。 */
function fenToDecimal(fen: number): string {
  const value = BigInt(fen);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

const DECIMAL_RE = /^([+-]?)(\d{1,12})(?:\.(\d{1,6}))?$/;

/** decimal → micros（10^-6），用于精确比较，不经过浮点。 */
function decimalToMicros(value: string): bigint {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) {
    throw new AppError('VALIDATION_FAILED', `金额不是合法 decimal 字符串：${value}`, {
      field: 'amount',
    });
  }
  const [, sign, integer, fraction = ''] = match;
  const micros = BigInt(integer!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return sign === '-' ? -micros : micros;
}

function microsToDecimal(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const integer = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

/** 应收余额 = 单头合计 − 已收款合计（D24）。 */
function receivableBalance(totalAmount: string, receivedAmount: string): string {
  return microsToDecimal(decimalToMicros(totalAmount) - decimalToMicros(receivedAmount));
}

async function tenantIdOfCompany(database: Database, companyId: string): Promise<string> {
  const result = await database.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM company WHERE id = $1::uuid`,
    [companyId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('VALIDATION_FAILED', `支付商户配置指向的公司不存在：${companyId}`, {
      companyId,
    });
  }
  return row.tenant_id;
}

export async function receivePaymentCallback(
  ctx: PaymentCallbackContext,
): Promise<PaymentCallbackResult> {
  const database = ctx.database;
  if (!database) {
    throw new AppError(
      'NOT_IMPLEMENTED',
      'payment.callback.receive 尚未实现（数据库未配置）',
      { operationId: 'payment.callback.receive' },
    );
  }

  const channel = parseChannel(ctx.request.params);
  const resolved =
    channel === 'wechat'
      ? resolveWechatCallback(
          ctx.request.headers,
          typeof ctx.request.body === 'string' ? ctx.request.body : '',
        )
      : resolveAlipayCallback(ctx.request.body);

  const tenantId = await tenantIdOfCompany(database, resolved.companyId);

  const outcome = await withTenant(database, tenantId, async (tx) => {
    const idempotencyKey = {
      companyId: resolved.companyId,
      channel: resolved.channel,
      outTradeNo: resolved.outTradeNo,
    };

    // 先看幂等键：重复投递时不再按「当前应收余额」校验（首笔已把余额收平）。
    const existing = await repo.findByOutTradeNo(tx, idempotencyKey);
    if (existing) {
      return {
        result: {
          received: true,
          duplicate: true,
          receiptId: existing.receiptId,
        } satisfies PaymentCallbackResult,
        auditId: null,
        tenantId,
      };
    }

    const order = await salesReceiptPort().findOrderByNo(tx, {
      companyId: resolved.companyId,
      orderNo: resolved.outTradeNo,
    });
    if (!order) {
      throw new AppError('NOT_FOUND', '支付回调对应的销售单不存在', {
        outTradeNo: resolved.outTradeNo,
      });
    }

    const expected = receivableBalance(order.totalAmount, order.receivedAmount);
    if (decimalToMicros(resolved.amount) !== decimalToMicros(expected)) {
      throw new AppError('VALIDATION_FAILED', '回调金额与应收余额不一致，拒绝入账', {
        outTradeNo: resolved.outTradeNo,
        expected,
        actual: resolved.amount,
      });
    }

    const recorded = await repo.recordCallback(tx, {
      tenantId: order.tenantId,
      companyId: order.companyId,
      channel: resolved.channel,
      outTradeNo: resolved.outTradeNo,
      transactionId: resolved.transactionId,
      amount: resolved.amount,
      status: '已支付',
    });

    // 并发下另一笔同键回调可能先插入：按重复回调返回，不重复入账。
    if (!recorded.inserted) {
      const duplicate = await repo.findByOutTradeNo(tx, idempotencyKey);
      return {
        result: {
          received: true,
          duplicate: true,
          receiptId: duplicate?.receiptId ?? null,
        } satisfies PaymentCallbackResult,
        auditId: null,
        tenantId,
      };
    }

    const { receiptId } = await salesReceiptPort().createReceiptFromPayment(tx, {
      tenantId: order.tenantId,
      companyId: order.companyId,
      orderId: order.id,
      amount: resolved.amount,
      channel: resolved.channel,
      transactionId: resolved.transactionId,
      remark: `${resolved.channel} 支付回调；交易号 ${resolved.transactionId}`,
    });

    await repo.attachReceipt(tx, { id: recorded.id, receiptId });

    return {
      result: {
        received: true,
        duplicate: false,
        receiptId,
      } satisfies PaymentCallbackResult,
      auditId: receiptId,
      tenantId,
    };
  });

  // F2：业务已提交；审计搬运失败必须上抛（D55⑤），不能静默丢日志。
  if (outcome.auditId) {
    await flushAuditOutbox(database, outcome.auditId, outcome.tenantId);
  }

  return outcome.result;
}
