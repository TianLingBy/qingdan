import { AppError } from '@qingdan/contracts';

/**
 * 支付运行模式（#101）。
 *
 * - `mock`：二维码指向本地假支付页，用 `POST /api/v1/payments/mock/{providerOrderNo}/confirm`
 *   模拟第三方「已付款」，本地与测试机零配置即可跑通「发起 → 付款 → 入账 → 对账」整条链路；
 * - `live`：走真实商户下单（当前版本对接真实商户的部分未实现，见 `provider.ts`）。
 *
 * **默认 mock 的理由**：开发、测试机、验收环境都不该先拿到商户资质才能验证业务；
 * 但这也意味着「什么都不配」时系统看起来能收钱、实际一分钱没进账，
 * 所以上线必须显式设 `QINGDAN_PAYMENT_MODE=live`——让「在收真钱」成为一次明确的动作，
 * 而不是一条默认值。
 */

export type PaymentMode = 'mock' | 'live';

const MODE_ENV = 'QINGDAN_PAYMENT_MODE';
const MODES: ReadonlySet<string> = new Set(['mock', 'live']);

export function paymentMode(): PaymentMode {
  const raw = process.env[MODE_ENV];
  if (raw === undefined || raw.trim() === '') return 'mock';

  const value = raw.trim().toLowerCase();
  if (!MODES.has(value)) {
    // 拼错（`Live` / `production` / `real`）时不回退默认值：静默按 mock 跑
    // 会让人以为在收钱，实际只是本地假支付页。
    throw new AppError('VALIDATION_FAILED', `环境变量 ${MODE_ENV} 只能是 mock 或 live`, {
      env: MODE_ENV,
    });
  }
  return value as PaymentMode;
}
