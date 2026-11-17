import {
  AppError,
  PaymentRequestCreateInputSchema,
  type PaymentRequest,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import { randomInt } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { withAudit } from '../../../platform/audit/writer.js';
import type { Principal } from '../../../platform/auth/principal.js';
import type { SqlClient } from '../../../platform/db/client.js';
import { requestIdFor } from '../../../platform/http/request-id.js';
import {
  salesReceiptPort,
  type SalesOrderForPayment,
} from '../../../platform/services/registry.js';
import * as repo from '../repo.js';
import { paymentProvider } from '../services/provider.js';
import {
  requireDatabase,
  requirePaymentScope,
  requirePrincipal,
  type PaymentContext,
} from './guards.js';

/**
 * 发起客户扫码收款（#101）。
 *
 * 做的事：校验权限 → 按**应收余额**算金额 → 复用同渠道未过期的待支付单 →
 * 让 provider 出二维码 → 落 `payment_request`。
 *
 * 口径：
 * - **金额由服务端算**，body 里只有渠道：允许客户端传金额就等于允许把 100 元单子
 *   改成 0.01 元支付，而收多少是账的事；
 * - **同单同渠道未过期的 pending 单直接复用**：客户反复点「收款」不该生成一堆二维码，
 *   否则同一笔钱会有 N 个待支付入口，对账时说不清哪张作数；
 * - 金额比较走 micros（十进制字符串 → 10^-6 整数），不经过浮点；
 * - 商户订单号 `QD + 公司编号 + 时间戳 + 6 位随机`，总长 26 ≤ 32（微信对
 *   `out_trade_no` 的上限是 32 个字符，且要求在商户内唯一）。
 */

export type PaymentRequestContext = PaymentContext;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 待支付有效期：15 分钟。够客户走到收银台，又不至于让一张二维码一辈子有效。 */
const REQUEST_TTL_MS = 15 * 60 * 1000;

const DECIMAL_RE = /^([+-]?)(\d{1,12})(?:\.(\d{1,6}))?$/;

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/**
 * 发起收款用 `payment.create`：`payment` 域在契约里只有 `create` 与 `read` 两个动作
 * （回调与 mock 确认也用 `create`），收款入口属于「建一笔收款意图」，不是改单。
 * 不复用 `sales.update`：能改销售单不等于能把二维码给客户去扫码付款（同 D85 / D86 的拆分口径）。
 */
function assertHumanCreation(principal: Principal): void {
  // 契约 payment.request.create 为 `ai.policy=forbid`（D52①）：动钱的动作 AI 一律不许。
  if (principal.actorType === 'ai') {
    throw new AppError('AI_ACTION_FORBIDDEN', 'AI 不得发起收款，需人类操作');
  }
}

function issuesOf(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseOrderId(request: FastifyRequest): string {
  const params = request.params as { orderId?: unknown };
  const id = typeof params.orderId === 'string' ? params.orderId : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'orderId 必须是合法 uuid', {
      field: 'orderId',
    });
  }
  return id;
}

function parseBody(request: FastifyRequest): { channel: 'wechat' | 'alipay' } {
  // `.strict()`：传了 amount 等多余字段直接 422（金额不接受客户端输入）。
  const parsed = PaymentRequestCreateInputSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '请求体不合法', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

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

/** 未收金额 = 单头合计 − 已收款合计（退款以负数行进入已收合计，D24 / D34）。 */
function receivableMicros(order: SalesOrderForPayment): bigint {
  return decimalToMicros(order.totalAmount) - decimalToMicros(order.receivedAmount);
}

/**
 * micros → 两位小数的 decimal 字符串（线上支付以分为单位）。
 *
 * 四舍五入到「分」而不是直接截断：截断会让 0.019 变成 0.01，
 * 客户付完仍然差一分钱，订单永远收不平。全程 BigInt，不经过浮点。
 */
function microsToAmount(micros: bigint): string {
  const cents = (micros + 5_000n) / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** 发起收款只有 `payment_request` 一张表，审计对象就是它自己。 */
const OBJECT_TYPE = 'payment_request';

function auditEventOf(
  request: FastifyRequest,
  principal: Principal,
  objectId: string,
  changeSummary: Record<string, unknown>,
) {
  return {
    tenantId: principal.tenantId,
    companyId: null,
    actorType: principal.actorType,
    actorId: principal.actorId,
    credentialId: principal.credentialId,
    source: request.auditSource,
    action: 'payment.request.create',
    objectType: OBJECT_TYPE,
    objectId,
    changeSummary,
    result: 'success' as const,
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: headerValue(request, 'user-agent') ?? null,
    reason: request.auditReason,
  };
}

/** 公司编号（`company.code`）进商户单号，方便在支付平台后台按公司筛单。 */
async function companyCodeOf(tx: SqlClient, companyId: string): Promise<string> {
  const result = await tx.query<{ code: string }>(
    `SELECT code FROM company WHERE id = $1::uuid`,
    [companyId],
  );
  return result.rows[0]?.code ?? '';
}

async function buildProviderOrderNo(tx: SqlClient, companyId: string): Promise<string> {
  const code = await companyCodeOf(tx, companyId);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const random = randomInt(0, 1_000_000).toString().padStart(6, '0');
  return `QD${code}${stamp}${random}`.slice(0, 32);
}

/** 记录 → 契约形状；过期判定只在这里做（读路径不写库，见 read-request.ts）。 */
export function toPaymentRequest(record: repo.PaymentRequestRecord): PaymentRequest {
  const expired = record.status === 'pending' && Date.parse(record.expiresAt) <= Date.now();
  return {
    id: record.id,
    salesOrderId: record.salesOrderId,
    channel: record.channel,
    amount: record.amount,
    status: expired ? 'expired' : record.status,
    qrContent: record.qrContent,
    payUrl: record.payUrl,
    expiresAt: record.expiresAt,
    paidAt: record.paidAt,
  };
}

export async function createPaymentRequest(
  ctx: PaymentRequestContext,
): Promise<PaymentRequest> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'payment.request.create');
  requirePaymentScope(principal, 'create');
  assertHumanCreation(principal);

  const orderId = parseOrderId(ctx.request);
  const { channel } = parseBody(ctx.request);

  const id = uuidv7();
  const createdAt = new Date();

  const request = await withAudit(
    database,
    auditEventOf(ctx.request, principal, id, { salesOrderId: orderId, channel }),
    async (tx) => {
      const order = await salesReceiptPort().findOrderById(tx, {
        companyIds: principal.companyIds,
        orderId,
      });
      // 不在可见公司内 → 与不存在同样处理：发起收款不该变成探测别家公司单据的通道。
      if (!order) {
        throw new AppError('NOT_FOUND', '销售单不存在或不在你可访问的公司内', { orderId });
      }

      const receivable = receivableMicros(order);
      if (receivable <= 0n) {
        // details 一律字符串：BigInt 进不了 JSON，序列化失败会盖掉真正的错因。
        throw new AppError('VALIDATION_FAILED', '该单已收齐，无需再收款', {
          orderId,
          receivable: receivable.toString(),
        });
      }

      const pending = await repo.findPendingPaymentRequest(tx, {
        companyId: order.companyId,
        salesOrderId: order.id,
        channel,
      });
      if (pending) return toPaymentRequest(pending);

      const providerOrderNo = await buildProviderOrderNo(tx, order.companyId);
      // 金额入库是 numeric(14,2)：线上支付以分为单位；入账时会按这张单的金额与
      // 应收余额比对，对不上的（例如应收余额本身有 3 位小数）会被回调拒绝。
      const amount = microsToAmount(receivable);
      const expiresAt = new Date(createdAt.getTime() + REQUEST_TTL_MS).toISOString();
      const paymentRequestId = id;

      const provider = paymentProvider();
      const { qrContent, payUrl } = await provider.createRequest({
        paymentRequestId,
        providerOrderNo,
        amount,
        channel,
        subject: `销售单 ${order.id}`,
      });

      const record = await repo.insertPaymentRequest(tx, {
        id: paymentRequestId,
        tenantId: order.tenantId,
        companyId: order.companyId,
        salesOrderId: order.id,
        channel,
        amount,
        providerOrderNo,
        qrContent,
        payUrl,
        expiresAt,
      });

      return toPaymentRequest(record);
    },
  );

  return request;
}
