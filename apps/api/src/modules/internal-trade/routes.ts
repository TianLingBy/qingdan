import { ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';

/**
 * internal-trade 模块骨架（契约第二批 §1 / §3 N 内部交易单首批 5 条）。
 *
 * 本批只接线挂载、不实现用例：`handlers` 为空，五条端点统一由 `mountRoutes` 返回
 * 501 `NOT_IMPLEMENTED`（与 inventory / sales / purchase / processing 首切前的骨架同款）。
 *
 * 实现由 internal-trade 负责人接 `usecases/` 后按 operationId 注入；注意：
 * - N 单是**独立四态** `进行中 / 在途 / 已完成 / 已取消`（D68②），不复用 `HEADER_STATES`；
 * - 取消按四态映射后复用 `assertCancelable`（D21）：`internalTradeHeaderState(status)`；
 * - 内部价由制单人手填、系统不自动算（D68①）；一期不做内部定价规则表（D45）；
 * - 明细只能引用**发出公司**批次（D22），`batchIds` 至少 1 条；
 * - 本批**不登记**「发货 / 在途」「到货确认 / 转司」端点：
 *   转司要改批次 `company_id` 并解锁在途占用（D22 / D31 / D68③），依赖 inventory 写能力；
 * - 本批**不登记** N 单完成自动生成 C 单草稿（D29，等结算模块）。
 */
export function registerInternalTradeRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {};

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'internal-trade'),
    handlers,
  });
}
