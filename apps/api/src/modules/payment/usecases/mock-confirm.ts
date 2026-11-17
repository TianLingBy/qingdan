import { AppError, type PaymentCallbackResult } from '@qingdan/contracts';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import * as repo from '../repo.js';
import { paymentMode } from '../services/payment-mode.js';
import { applyPaymentCallback } from './callback.js';
import { requireDatabase, type PaymentContext } from './guards.js';

/**
 * mock 模式下「客户已付款」的模拟投递（#101）。
 *
 * **复用回调入账路径**：这里只伪造「报文是真的」这一步，入账逻辑（金额校验、幂等、
 * 写 `payment_transaction`、生成收款行、回填 `receipt_id`）全部走 `applyPaymentCallback`。
 * mock 与真实回调走进账的两套代码会让「mock 通了、真实回调动不动」成为常态，
 * 而这个模块的验收标准恰恰是两条路产出同一份账。
 *
 * 匿名端点（`publicAccess: true`）：它模拟的是第三方平台，本来就不带本系统会话。
 * 因此这里按商户订单号反查待支付单——与回调按商户号反查公司同一套「先定位再说」的方式。
 * **生产是 live 模式，本端点返回 404**（不是 403：存在性本身不该暴露）。
 */

const PAID_REMARK = 'mock 支付确认';

function parseProviderOrderNo(params: unknown): string {
  const value = (params as { providerOrderNo?: unknown })?.providerOrderNo;
  const orderNo = typeof value === 'string' ? value.trim() : '';
  if (orderNo === '' || orderNo.length > 64) {
    throw new AppError('VALIDATION_FAILED', 'providerOrderNo 不合法', {
      field: 'providerOrderNo',
    });
  }
  return orderNo;
}

export async function confirmMockPayment(ctx: PaymentContext): Promise<PaymentCallbackResult> {
  // 模式检查放在最前面：live 模式下这个端点必须像不存在一样，不能先查库再回 403。
  if (paymentMode() !== 'mock') {
    throw new AppError('NOT_FOUND', '接口不存在', {
      operationId: 'payment.mock.confirm',
    });
  }

  const database = requireDatabase(ctx, 'payment.mock.confirm');
  const providerOrderNo = parseProviderOrderNo(ctx.request.params);

  const record = await repo.findPaymentRequestByProviderOrderNo(database, providerOrderNo);
  if (!record) {
    throw new AppError('NOT_FOUND', '待支付单不存在', { providerOrderNo });
  }

  const paidAt = new Date().toISOString();
  const result = await applyPaymentCallback(database, {
    companyId: record.companyId,
    channel: record.channel,
    // 商户订单号就是回调里的 `out_trade_no`，两边用它对齐幂等键。
    outTradeNo: record.providerOrderNo,
    transactionId: `MOCK${Date.now()}`,
    amount: record.amount,
    salesOrderId: record.salesOrderId,
    afterApply: async (tx, applied) => {
      await repo.markPaymentRequestPaid(tx, {
        id: record.id,
        paidAt,
        transactionId: applied.paymentTransactionId,
      });
    },
  });

  // 重复确认：首笔已把单置 paid（UPDATE 带 status='pending' 守卫），这里再补一次是幂等空操作，
  // 只为覆盖「首笔入账成功但回填没跑到」这种不该发生的半截状态，成本一行。
  if (result.duplicate) {
    await withTenant(database, record.tenantId, async (tx) => {
      const transaction = await repo.findByOutTradeNo(tx, {
        companyId: record.companyId,
        channel: record.channel,
        outTradeNo: record.providerOrderNo,
      });
      if (transaction) {
        await repo.markPaymentRequestPaid(tx, {
          id: record.id,
          paidAt: transaction.createdAt,
          transactionId: transaction.id,
        });
      }
    });
  }

  return result;
}
