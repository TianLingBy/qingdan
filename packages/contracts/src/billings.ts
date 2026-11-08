import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 订阅与计费契约（一期只登记端点签名，不做页面、不做支付）。
 *
 * 口径约束：
 * - 平台向商家收取订阅费，`expiresAt = null` 表示永久；
 * - 调整套餐 / 到期日属运营写操作，必记审计并强制 X-Reason；
 * - handler 允许先返 501（D54 缺口 10）。
 */

export const CompanySubscriptionSchema = z.object({
  companyId: z.string().uuid(),
  plan: z.string().min(1),
  expiresAt: z.iso.date().nullable(),
  status: z.enum(['启用', '停用']),
  daysRemaining: z.number().int().nullable(),
  dueSoon: z.boolean(),
});
export type CompanySubscription = z.infer<typeof CompanySubscriptionSchema>;

export const CompanySubscriptionUpdateSchema = z
  .object({
    plan: z.string().min(1).optional(),
    expiresAt: z.iso.date().nullable().optional(),
  })
  .refine((value) => value.plan !== undefined || value.expiresAt !== undefined, {
    message: 'plan 与 expiresAt 至少修改一个',
  });
export type CompanySubscriptionUpdate = z.infer<typeof CompanySubscriptionUpdateSchema>;

export const BILLING_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'platform',
    domain: 'billing',
    action: 'read',
    operationId: 'billing.subscription.read',
    method: 'GET',
    path: '/api/v1/billing/subscription',
    summary: '读取当前公司的订阅套餐与到期情况',
    audit: { kind: 'none' },
    response: { status: 200, schema: CompanySubscriptionSchema },
  }),
  defineRoute({
    module: 'platform',
    domain: 'billing',
    action: 'update',
    operationId: 'billing.subscription.update',
    method: 'PATCH',
    path: '/api/v1/billing/subscription',
    summary: '运营端手动调整套餐与到期日（写审计，需 X-Reason）',
    audit: { kind: 'write' },
    ai: { policy: 'allow', reasonRequired: true },
    request: { body: CompanySubscriptionUpdateSchema },
    response: { status: 200, schema: CompanySubscriptionSchema },
  }),
];
