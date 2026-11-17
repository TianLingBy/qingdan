import { AppError, type PaymentChannel } from '@qingdan/contracts';
import { paymentMode, type PaymentMode } from './payment-mode.js';

/**
 * 支付平台下单端口（#101 发起侧）。
 *
 * 发起收款要的东西两家厂商都一样：商户订单号、金额、渠道、商品描述，换回来的是
 * 「客户扫什么」——一段二维码内容 + 一个收银台地址。差异只在各自的 API 形态，
 * 因此这里按接口隔离，路由 / 用例只依赖 `PaymentProvider`。
 *
 * 回调侧（验签 + 入账）已完整实现且与下单解耦：`LiveProvider.createRequest` 接上
 * 真实商户以后，回调那条路一行都不用改。
 */

export interface CreateProviderRequestInput {
  readonly paymentRequestId: string;
  /** 给支付平台看的商户订单号（微信 `out_trade_no`），回调原样回传。 */
  readonly providerOrderNo: string;
  /** decimal 字符串，单位元。 */
  readonly amount: string;
  readonly channel: PaymentChannel;
  /** 收银台 / 账单上的商品描述。 */
  readonly subject: string;
}

export interface ProviderRequestResult {
  readonly qrContent: string;
  readonly payUrl: string;
}

export interface PaymentProvider {
  createRequest(input: CreateProviderRequestInput): Promise<ProviderRequestResult>;
}

/**
 * 本地 mock：二维码与收银台地址都指向本地假支付页，不碰任何外部网络。
 *
 * `payUrl` 用相对路径是有意的——服务对外的 origin（端口 / 域名 / 反向代理前缀）
 * 只有前端知道，后端拼绝对地址就会在换环境时失效。
 */
export class MockProvider implements PaymentProvider {
  async createRequest(input: CreateProviderRequestInput): Promise<ProviderRequestResult> {
    return {
      qrContent: `qingdan-mock://pay/${input.providerOrderNo}`,
      payUrl: `/mock-pay/${input.providerOrderNo}`,
    };
  }
}

/**
 * 真实商户下单：本版不实现。
 *
 * 回调侧已经能验签入账，发起侧的缺口是**商户资质与证书**，不是代码结构：
 * 微信要商户号 + APIv3 密钥 + 平台证书 + 已备案的支付授权目录，支付宝要应用私钥 +
 * 支付宝公钥 + 已签约的产品。没有这些东西写出来的下单代码无法验证，只会变成
 * 一段「看起来实现了但没人跑通过」的代码。
 */
export class LiveProvider implements PaymentProvider {
  async createRequest(input: CreateProviderRequestInput): Promise<ProviderRequestResult> {
    throw new AppError(
      'NOT_IMPLEMENTED',
      '真实商户下单未接入：需要先拿到微信/支付宝的商户号与证书（#101 待负责人提供）',
      { channel: input.channel },
    );
  }
}

/** 按运行模式取实现；模式只在调用时读，测试可以中途切环境变量。 */
export function paymentProvider(mode: PaymentMode = paymentMode()): PaymentProvider {
  return mode === 'mock' ? new MockProvider() : new LiveProvider();
}
