import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 工作台待办（D89 / #289）。
 *
 * 后端按「调用者的权限点 × 动作」与「本人负责」聚合真实单据的待处理笔数，
 * 前端不再写死数字。`kind` 是稳定英文键，`title` / `hint` 的中文文案由后端给，
 * 前端只按 `kind` / `routeId` 决定展示与跳转，避免两端各自维护一份规则。
 *
 * 口径：
 * - 只聚合**有明确待处理状态、且存在能推进它的端点**的单据（采购 / 销售没有
 *   `approve` 语义的中途状态，不进入本端点，见 D85 / D89）。
 * - 权限过滤：调用者没有该条目要求的权限点的，`count=0` 且不查库；一条都够不上时
 *   也返回全部 `TODO_KINDS`（统一形状，前端只兼容一种）。
 * - **前 6 条要的是 `approve`，第 7 条 `inventory_alert` 要的是 `read`**：前 6 条是
 *   「有一张单等你批」，第 7 条是「有一批货快断了，你该知道」。仓管没有审批权，
 *   但他恰恰是最需要知道哪批货撑不到下周的人；挂 `approve` 会把预警从最该看见的人
 *   的屏幕上拿掉（D89 补记 / D104）。
 * - 「本人负责」：单据有 `handler_id` / `applicant_id` / `requested_by` /
 *   `commission_owner_id` 等负责人字段的按本人过滤；没有负责人字段的按调用者
 *   **可见公司内全部**计，并在 `hint` 里写明「可见公司内在办」。
 * - `count = 0` 的条目也返回（前端决定是否显示），方便一次拿全。
 * - 本端点只给笔数，不返回任何金额字段，避免绕过 `view_price`。
 */

/**
 * 稳定的待办 kind 词表；返回顺序固定按本数组顺序（D89）。
 *
 * 不把中文当 key：中文只出现在 `title` / `hint` 文案里，键空间保持可编程。
 */
export const TODO_KINDS = [
  'settlement_pending',
  'stocktake_pending',
  'cost_adjustment_pending',
  'customer_return_pending',
  'supplier_return_pending',
  'processing_pending',
  'inventory_alert',
] as const;

export type TodoKind = (typeof TODO_KINDS)[number];

export const TodoItemSchema = z.object({
  /** 稳定英文键，见 `TODO_KINDS`。 */
  kind: z.string(),
  /** 待办名称（中文，由后端给）。 */
  title: z.string(),
  /** 待处理笔数；`0` 也会返回，由前端决定是否显示。 */
  count: z.number().int().nonnegative(),
  /** 一句话说明「为什么是我的事」/ 统计口径。 */
  hint: z.string(),
  /** 前端路由稳定 id（`apps/web/src/router/routes.ts` 的 `RouteEntry['id']`）。 */
  routeId: z.string(),
});

export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoListSchema = z.object({
  items: z.array(TodoItemSchema),
});

export type TodoList = z.infer<typeof TodoListSchema>;

/**
 * GET /api/v1/todos 契约（D52 / D89）。
 *
 * 归 `platform` 模块（工作台待办是平台内核的跨模块只读聚合，D62 / OWNERSHIP）；
 * 功能域是新增的 `workbench`，普通读不记审计（D51）。
 */
export const WORKBENCH_TODO_ROUTES: readonly RouteDef[] = [
  defineRoute({
    operationId: 'workbench.todos.read',
    method: 'GET',
    path: '/api/v1/todos',
    module: 'platform',
    domain: 'workbench',
    action: 'read',
    summary: '工作台待办：按权限点 × 动作与本人负责聚合真实单据笔数（普通读不记审计）',
    audit: { kind: 'none' },
    response: { status: 200, schema: TodoListSchema },
  }),
];
