import { AppError, type PaymentRequest } from '@qingdan/contracts';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import * as repo from '../repo.js';
import { toPaymentRequest } from './create-request.js';
import {
  requireDatabase,
  requirePaymentScope,
  requirePrincipal,
  type PaymentContext,
} from './guards.js';

/**
 * 查待支付单（#101 对账查询）。
 *
 * **惰性判过期**：`pending` 且 `expires_at < now()` 时对外返回 `status: 'expired'`，
 * 但**不写库**。理由是过期是时间的事实，不是一次状态迁移——为它写库就得有一个
 * 定时任务、一套权限、一份「谁把这张单标成过期」的审计，而答案永远是「时间到了」。
 * 真需要靠状态删单（例如清理历史二维码）时再加定时任务，届时这里改成读库里的真实状态即可。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePaymentRequestId(params: unknown): string {
  const id = typeof (params as { id?: unknown })?.id === 'string'
    ? ((params as { id: string }).id)
    : '';
  if (!UUID_RE.test(id)) {
    throw new AppError('VALIDATION_FAILED', 'id 必须是合法 uuid', { field: 'id' });
  }
  return id;
}

export async function readPaymentRequest(ctx: PaymentContext): Promise<PaymentRequest> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx, 'payment.request.read');
  requirePaymentScope(principal, 'read');

  const id = parsePaymentRequestId(ctx.request.params);
  const record = await withTenant(database, principal.tenantId, (tx) =>
    repo.findPaymentRequestById(tx, id),
  );

  // 不在可见公司内 → 不存在：待支付单带着金额与二维码，不该用来探测别家公司的单子。
  if (!record || !principal.companyIds.includes(record.companyId)) {
    throw new AppError('NOT_FOUND', '支付请求不存在', { id });
  }
  return toPaymentRequest(record);
}
