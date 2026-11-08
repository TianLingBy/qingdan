import type { ServiceRegistry } from '../../../platform/services/registry.js';
import { getCompanySubscription } from '../usecases/subscription.js';

/**
 * 订阅端口实现（D70）。
 *
 * 一期只提供查询，**不拦任何请求**：到期只提示续费（D1/D12）。
 * 调用方必须传入已设置 `app.tenant_id` 的事务（company 表 FORCE RLS）。
 */
export const billingEntitlementService: Pick<ServiceRegistry, 'billingEntitlement'> = {
  billingEntitlement: {
    getEntitlement: async (tx, query) => {
      const subscription = await getCompanySubscription(tx, query.companyId);
      return {
        plan: subscription.plan,
        expiresAt: subscription.expiresAt,
        expired: subscription.daysRemaining !== null && subscription.daysRemaining < 0,
        dueSoon: subscription.dueSoon,
      };
    },
  },
};
