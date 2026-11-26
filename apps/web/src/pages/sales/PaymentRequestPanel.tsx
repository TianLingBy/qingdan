/**
 * 发起收款面板（#101 / #386）：选渠道 → 出二维码 → 客户扫码付款。
 *
 * 放在销售单详情的「收款记录」块里 —— 与收款台账同一处，操作员不会在两个地方找。
 *
 * 三条设计取舍：
 *
 * 1. **金额只显示、不可编辑。** 服务端按「总额 − 已收」算，前端连传都不传（契约
 *    `.strict()` 会把多余字段当 422）。让人改金额就等于允许把 100 元的单子收 0.01 元，
 *    而收多少是账的事，不是表单的事。
 *
 * 2. **二维码过期就地重发，不自动续。** 15 分钟有效期是给「客户走到收银台」的窗口，
 *    自动续期会让一张截图永久可用。过期后按钮变成「重新发起」，由人决定。
 *
 * 3. **mock 模式给一个显式的「模拟客户已付款」。** 这个按钮走的是真实回调的入账路径
 *    （`applyPaymentCallback`），所以点了以后账、库存、结算与真付一模一样。它只出现在
 *    `qrContent` 以 `qingdan-mock://` 开头时 —— 那是 MockProvider 的产物，live 模式
 *    下永远不会有这段前缀。**不靠环境变量猜模式**：前端看不到服务端的
 *    `QINGDAN_PAYMENT_MODE`，硬猜会出现「以为在 mock、其实在收真钱」。
 */

import type { PaymentChannel, PaymentRequest } from '@qingdan/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { formatMoney } from '../../lib/decimal';
import { describeWriteError } from '../../lib/write-error';
import { paymentQueryKeys, paymentsApi } from './payments-api';

/** MockProvider 的二维码前缀（`apps/api/src/modules/payment/services/provider.ts`）。 */
const MOCK_QR_PREFIX = 'qingdan-mock://';

const CHANNEL_LABEL: Record<PaymentChannel, string> = {
  wechat: '微信',
  alipay: '支付宝',
};

interface PaymentRequestPanelProps {
  readonly orderId: string;
  /** `payment.create`。缺它连「发起收款」都不该画出来 —— 点了必然 403。 */
  readonly canCreate: boolean;
  readonly canViewPrice: boolean;
  readonly onClose: () => void;
  /** 收到款之后调用：让详情面板重拉（余额、收款记录、状态都可能变）。 */
  readonly onPaid: () => void;
  readonly onError: (message: string) => void;
}

/** 剩余秒数；已过期返回 0。每秒重算一次，不缓存在 state 里。 */
function secondsLeft(expiresAt: string, now: number): number {
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.floor((end - now) / 1000));
}

function countdownText(seconds: number): string {
  if (seconds <= 0) return '二维码已过期';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `剩余 ${minutes}:${rest.toString().padStart(2, '0')}`;
}

export function PaymentRequestPanel({
  orderId,
  canCreate,
  canViewPrice,
  onClose,
  onPaid,
  onError,
}: PaymentRequestPanelProps) {
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<PaymentChannel>('wechat');
  const [request, setRequest] = useState<PaymentRequest | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // 只在有二维码时开计时器：没有待支付单时每秒重渲染整个面板是白烧。
  useEffect(() => {
    if (!request || request.status !== 'pending') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request]);

  const create = useMutation({
    mutationFn: () => paymentsApi.createRequest(orderId, channel),
    onSuccess: (created) => {
      setRequest(created);
      setNow(Date.now());
    },
    onError: (error) => onError(describeWriteError(error, '发起收款失败，请稍后重试')),
  });

  const confirm = useMutation({
    mutationFn: (providerOrderNo: string) => paymentsApi.mockConfirm(providerOrderNo),
    onSuccess: async (result) => {
      if (result.receiptId) {
        // 真实入账了：让详情重拉，余额与收款记录都要更新。
        await queryClient.invalidateQueries({ queryKey: paymentQueryKeys.request(request?.id ?? null) });
        onPaid();
      }
    },
    onError: (error) => onError(describeWriteError(error, '模拟支付失败，请稍后重试')),
  });

  if (!canViewPrice) {
    // 看不到金额就不该发起收款：屏幕上会是一个「¥ —」的二维码，客户付多少都对不上账。
    return (
      <section className="alert alert-warn">
        <p>
          无「看价」权限，不能发起收款 —— 看不到金额就无法确认客户付的是不是这一单（D27 / D79）。
        </p>
        <div className="detail-acts">
          <button type="button" onClick={onClose} className="btn btn-row">
            收起
          </button>
        </div>
      </section>
    );
  }

  if (!canCreate) {
    return (
      <section className="alert alert-info">
        <p>发起收款需要 payment.create 权限；当前身份只能查看收款台账。</p>
        <div className="detail-acts">
          <button type="button" onClick={onClose} className="btn btn-row">
            收起
          </button>
        </div>
      </section>
    );
  }

  const remaining = request ? secondsLeft(request.expiresAt, now) : 0;
  const isMock = request?.qrContent?.startsWith(MOCK_QR_PREFIX) ?? false;
  const live = request !== null && request.status === 'pending' && remaining > 0;

  return (
    <section className="form-sec">
      <div className="form-sec-h">
        <h3>发起扫码收款</h3>
        <button type="button" onClick={onClose} className="btn btn-row">
          收起
        </button>
      </div>

      {!request && (
        <div className="form-sec-b form-stack">
          <div className="fm c4">
            <label>
              <span>收款渠道</span>
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value as PaymentChannel)}
              >
                <option value="wechat">微信</option>
                <option value="alipay">支付宝</option>
              </select>
            </label>
          </div>
          <div className="detail-acts">
            <button
              type="button"
              disabled={create.isPending}
              onClick={() => create.mutate()}
              className="btn btn-p"
            >
              {create.isPending ? '生成中…' : '生成收款二维码'}
            </button>
          </div>
          <p className="detail-why">
            金额由服务端按「应收余额」算 —— 本单还差多少就收多少，不用手填。
          </p>
        </div>
      )}

      {request && (
        <div className="form-sec-b qr-row">
          <div className="qr-box">
            {live && request.qrContent ? (
              <QRCodeSVG value={request.qrContent} size={168} />
            ) : (
              <div className="qr-empty">
                {request.status === 'paid'
                  ? '已收款'
                  : request.status === 'cancelled'
                    ? '已取消'
                    : '二维码已过期'}
              </div>
            )}
          </div>

          <div className="qr-meta">
            <p>
              应收金额 <b className="mono">{formatMoney(request.amount)}</b>
              <span className="cell-sub">（{CHANNEL_LABEL[request.channel]}）</span>
            </p>
            <p className="cell-muted">
              商户订单号 <span className="mono">{request.providerOrderNo}</span>
            </p>
            <p className={remaining > 0 ? 'cell-muted' : 'text-bad'}>
              {request.status === 'paid' ? '已到账' : countdownText(remaining)}
            </p>

            {isMock && live && (
              <div className="alert alert-warn alert-sm">
                <p>
                  当前是<b>模拟支付</b>模式：这个二维码扫不出真钱。点下面的按钮相当于「客户已付款」，
                  走的是和真实回调完全相同的入账路径。
                </p>
                <div className="detail-acts">
                  <button
                    type="button"
                    disabled={confirm.isPending}
                    onClick={() => confirm.mutate(request.providerOrderNo)}
                    className="btn btn-row"
                  >
                    {confirm.isPending ? '入账中…' : '模拟客户已付款'}
                  </button>
                </div>
              </div>
            )}

            {!live && request.status !== 'paid' && (
              <div className="detail-acts">
                <button
                  type="button"
                  onClick={() => {
                    setRequest(null);
                    create.mutate();
                  }}
                  disabled={create.isPending}
                  className="btn btn-row"
                >
                  {create.isPending ? '重新生成中…' : '重新发起'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
