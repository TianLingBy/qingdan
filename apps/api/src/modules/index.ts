import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../platform/config.js';
import { registerInternalTradeRoutes } from './internal-trade/routes.js';
import { registerInventoryRoutes } from './inventory/routes.js';
import { registerMasterdataRoutes } from './masterdata/routes.js';
import { registerPlatformRoutes } from './platform/routes.js';
import { registerProcessingRoutes } from './processing/routes.js';
import { registerPurchaseRoutes } from './purchase/routes.js';
import { registerSalesRoutes } from './sales/routes.js';

/**
 * 业务模块挂载登记（D62 / Issue #15）。
 *
 * 这里只列出**已经接线**的模块；`route-boundary.test.ts` 会断言注册表里出现的每个
 * `route.module` 都在此表内，防止新增业务路由被静默漏挂（或又被 platform 接管）。
 */
export const MOUNTED_MODULE_KEYS = [
  'platform',
  'masterdata',
  'inventory',
  'sales',
  'purchase',
  'processing',
  'internal-trade',
] as const;

export interface RegisterModulesOptions {
  /** 健康检查回显的 API 版本。 */
  readonly version: string;
  /** 应用配置（登录验证码 / 会话 TTL / 环境）。 */
  readonly config: AppConfig;
}

/** 依次注册已接线模块；顺序与 `MOUNTED_MODULE_KEYS` 一致。 */
export function registerModules(app: FastifyInstance, options: RegisterModulesOptions): void {
  registerPlatformRoutes(app, { version: options.version, config: options.config });
  registerMasterdataRoutes(app);
  registerInventoryRoutes(app);
  registerSalesRoutes(app);
  registerPurchaseRoutes(app);
  registerProcessingRoutes(app);
  registerInternalTradeRoutes(app);
}
