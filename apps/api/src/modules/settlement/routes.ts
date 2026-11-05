import { ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';

/**
 * settlement 模块骨架（契约第一批 §3.4 C 结算单首批 3 条）。
 *
 * 本批只接线挂载、不实现用例：`handlers` 为空，三条端点统一由 `mountRoutes` 返回
 * 501 `NOT_IMPLEMENTED`（与 inventory / sales / purchase / processing / internal-trade
 * 首切前的骨架同款）。
 *
 * 实现由 settlement 负责人接 `usecases/` 后按 operationId 注入；注意：
 * - C 单状态是**独立两态** `待确认 / 已结算`（D19），不复用 `HEADER_STATES`；
 * - **一期一单一次结算**，不支持部分 / 多次（D19）；草稿由 E/N 单「已完成」时系统自动生成，
 *   本模块**不提供创建端点**（D19 / D29）；
 * - **结算后不可冲正**，错账走 R 退货（D2③）；
 * - 毛利 / 毛利率按 D5 服务端计算；净毛利 = 毛利 − 本单相关损失（D26 / D33）；
 *   本单相关损失按 D35 的归属单聚合，并在结算时快照（§11-5）；
 * - 提成以 C 单为单位结算（D36），`commissionRateSnapshot` 结算时快照，改比例不重算历史单；
 * - 确认结算属审批动作：scope `settlement.approve`、AI 禁止且必须给原因（D52）、强 ETag；
 * - 金额一律 decimal 字符串（D54）。
 */
export function registerSettlementRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {};

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'settlement'),
    handlers,
  });
}
