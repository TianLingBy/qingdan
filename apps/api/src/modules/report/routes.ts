import { ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes } from '../../platform/http/route-mount.js';

/**
 * report 模块骨架（D43 / Issue #164）。
 *
 * 两条利润报表端点本批**只登记签名**：不注入 handler → `mountRoutes` 默认回
 * 501 `NOT_IMPLEMENTED`（message 含 operationId，details 带 `{ operationId }`）。
 *
 * 真实聚合由 owner 实现，且**只能经端口**取数（D70）：
 * - 已结算 C 单毛利 → `settlementProfitAggregatePort()`（settlement 注册）；
 * - B 单全损耗 → `processingLossAggregatePort()`（processing 注册）。
 * 本模块不写 SQL、不直读对方表；金额脱敏按 `profit_report.view_price` 判定
 * （范式见 `purchase/services/masking.ts`），实现留给 owner。
 */
export function registerReportRoutes(app: FastifyInstance): void {
  mountRoutes(app, { routes: routesOfModule(ROUTES, 'report'), handlers: {} });
}
