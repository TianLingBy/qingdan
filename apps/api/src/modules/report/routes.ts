import { AppError, ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes } from '../../platform/http/route-mount.js';
import { getProfitReport, listProfitLosses } from './usecases/profit-report.js';

/**
 * report 模块骨架（D43 / Issue #164）。
 *
 * 真实聚合**只能经端口**取数（D70）：
 * - 已结算 C 单毛利 → `settlementProfitAggregatePort()`（settlement 注册）；
 * - B 单全损耗 → `processingLossAggregatePort()`（processing 注册）。
 * 本模块不写 SQL、不直读对方表；金额脱敏按 `profit_report.view_price` 判定
 * （范式见 `purchase/services/masking.ts`）。
 */
function assertDatabaseConfigured(app: FastifyInstance, route: { operationId: string }): void {
  if (app.database) return;
  throw new AppError('NOT_IMPLEMENTED', `${route.operationId} 尚未实现（数据库未配置）`, {
    operationId: route.operationId,
  });
}

export function registerReportRoutes(app: FastifyInstance): void {
  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'report'),
    handlers: {
      'profit_report.read': async ({ app: instance, request, route }) => {
        assertDatabaseConfigured(instance, route);
        return await getProfitReport({ database: instance.database, request });
      },
      'profit_report.loss.read': async ({ app: instance, request, route }) => {
        assertDatabaseConfigured(instance, route);
        return await listProfitLosses({ database: instance.database, request });
      },
    },
  });
}
