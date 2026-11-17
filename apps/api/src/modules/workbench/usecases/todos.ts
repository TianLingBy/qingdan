import {
  AppError,
  TODO_KINDS,
  allowsScope,
  type Action,
  type DomainKey,
  type TodoItem,
  type TodoKind,
  type TodoList,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';

/**
 * 工作台待办聚合（D89 / #289）。
 *
 * 口径（每条都先核实过「单据有明确待处理状态 + 存在推进它的端点」）：
 *
 * | kind | 表 | 待处理状态 | 推进端点 | 权限点 | 本人负责 |
 * | --- | --- | --- | --- | --- | --- |
 * | settlement_pending | settlement_order | 待确认 | `settlement.order.confirm` | settlement.approve | commission_owner_id |
 * | stocktake_pending | inventory_stocktake | 待审批 | `stocktake.approve` | stocktake.approve | applicant_id |
 * | cost_adjustment_pending | inventory_cost_adjustment | pending_approval | `inventory.cost.adjustment.approve` | inventory_qty.approve | requested_by |
 * | customer_return_pending | customer_return | 进行中 | `customer_return.complete` | customer_return.approve | 无（可见公司内全部） |
 * | supplier_return_pending | supplier_return | 进行中 | `supplier_return.complete` | supplier_return.approve | 无（可见公司内全部） |
 * | processing_pending | processing_order | 进行中 | `processing.order.complete` | processing.approve | handler_id |
 *
 * 明确不返回：采购单 / 销售单。采购完成的权限点已改为 `purchase.update`（D81），
 * 销售出库是 `sales.ship`（D85），两者都没有 `approve` 的「待审核」中途状态；
 * 设计稿 `TODO_RULES` 里的「采购单待审核 / 销售单待审核」是过期口径。
 *
 * 金额一律不出现：本端点只给笔数，避免绕过 `view_price`（D27 / D78 / D82）。
 */

export interface WorkbenchTodoContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

interface TodoDefinition {
  readonly kind: TodoKind;
  readonly title: string;
  readonly hint: string;
  readonly routeId: string;
  /** 该待办要求的权限域；调用者须持有该域的 `action`。 */
  readonly domain: DomainKey;
  /**
   * 该条目要求哪个动作；**不写等于 `approve`**。
   *
   * 只有 `inventory_alert` 显式写 `read`：前 6 条是「有一张单等你批」，
   * 第 7 条是「有一批货快断了，你该知道」。仓管没有审批权，但他恰恰是最需要
   * 看见这个数字的人；挂 `approve` 等于把预警从最该看见的人屏幕上拿掉。
   */
  readonly action?: Action;
  /** 计数 SQL；参数固定为 $1=tenantId、$2=companyIds、$3=employeeId（公司内全部的查询不用 $3）。 */
  readonly sql: string;
  /** 是否用 `$3` 按本人过滤。 */
  readonly ownedByCaller: boolean;
}

/**
 * 待办定义（顺序 = 响应顺序）。
 *
 * 所有查询都按 `tenant_id` + 调用者可见 `company_id` 收窄；禁止跨公司。
 * `count = 0` 的条目也返回（含无权限 / 一个候选域 `approve` 都没有的调用者），
 * 永远返回 `TODO_KINDS` 全 6 条，前端只需处理一种形状。
 */
const TODO_DEFINITIONS: readonly TodoDefinition[] = [
  {
    kind: 'settlement_pending',
    title: '结算单待确认',
    hint: '你作为提成归属人的结算单待确认',
    routeId: 'settlements',
    domain: 'settlement',
    ownedByCaller: true,
    sql: `SELECT count(*)::int AS count
            FROM settlement_order
           WHERE tenant_id = $1
             AND company_id = ANY($2::uuid[])
             AND status = '待确认'
             AND commission_owner_id = $3::uuid`,
  },
  {
    kind: 'stocktake_pending',
    title: '盘点单待审批',
    hint: '你发起的盘点单待审批',
    routeId: 'stocktakes',
    domain: 'stocktake',
    ownedByCaller: true,
    sql: `SELECT count(*)::int AS count
            FROM inventory_stocktake
           WHERE tenant_id = $1
             AND company_id = ANY($2::uuid[])
             AND status = '待审批'
             AND applicant_id = $3::uuid`,
  },
  {
    kind: 'cost_adjustment_pending',
    title: '成本更正待审批',
    hint: '你发起的成本更正待审批',
    routeId: 'inventory',
    domain: 'inventory_qty',
    ownedByCaller: true,
    sql: `SELECT count(*)::int AS count
            FROM inventory_cost_adjustment
           WHERE tenant_id = $1
             AND company_id = ANY($2::uuid[])
             AND status = 'pending_approval'
             AND requested_by = $3::uuid`,
  },
  {
    kind: 'customer_return_pending',
    title: '客户退货待确认',
    hint: '可见公司内在办的客户退货待确认',
    routeId: 'reversals',
    domain: 'customer_return',
    ownedByCaller: false,
    sql: `SELECT count(*)::int AS count
            FROM customer_return
           WHERE tenant_id = $1
             AND company_id = ANY($2::uuid[])
             AND status = '进行中'`,
  },
  {
    kind: 'supplier_return_pending',
    title: '供应商退货待确认',
    hint: '可见公司内在办的供应商退货待确认',
    routeId: 'reversals',
    domain: 'supplier_return',
    ownedByCaller: false,
    sql: `SELECT count(*)::int AS count
            FROM supplier_return
           WHERE tenant_id = $1
             AND company_id = ANY($2::uuid[])
             AND status = '进行中'`,
  },
  {
    kind: 'processing_pending',
    title: '加工单待验收',
    hint: '你经手的加工单待验收',
    routeId: 'processing-orders',
    domain: 'processing',
    ownedByCaller: true,
    sql: `SELECT count(*)::int AS count
            FROM processing_order
           WHERE tenant_id = $1
             AND company_id = ANY($2::uuid[])
             AND status = '进行中'
             AND handler_id = $3::uuid`,
  },
  {
    kind: 'inventory_alert',
    title: '低库存批次',
    hint: '可见公司内按近 30 天出库速度算，撑不到 8 天的批次',
    routeId: 'inventory',
    domain: 'inventory_qty',
    // 预警不是「等你批」，是「你该知道」：仓管没有审批权，却是最该看见的人。
    action: 'read',
    ownedByCaller: false,
    /**
     * 与 `GET /api/v1/inventory/alerts`（D104）同一口径：近 30 天日均出库 × 7 天覆盖
     * ×（1 + 提前量 0.2）。这里写死 `1.2` 而不是读常量，是因为这条 SQL 只是计数，
     * 接不出参数；两个数字若日后要各自可调，应改成把 `thresholdRatio` 作为 `$4` 传进来。
     */
    sql: `SELECT count(*)::int AS count
            FROM inventory_batch b
            JOIN (SELECT batch_id,
                         SUM(-delta)::numeric / 30 AS avg_daily_out
                    FROM inventory_flow
                   WHERE tenant_id = $1
                     AND company_id = ANY($2::uuid[])
                     AND delta < 0
                     AND occurred_at >= now() - interval '30 days'
                   GROUP BY batch_id
                  HAVING SUM(-delta) > 0) f ON f.batch_id = b.id
           WHERE b.tenant_id = $1
             AND b.company_id = ANY($2::uuid[])
             AND b.available_qty < f.avg_daily_out * 7 * 1.2`,
  },
];

function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  return principal;
}

function requireDatabase(ctx: WorkbenchTodoContext): Database {
  if (!ctx.database) {
    throw new AppError('NOT_IMPLEMENTED', '工作台待办数据库未配置', {
      operationId: 'workbench.todos.read',
    });
  }
  return ctx.database;
}

/** 端点自身权限点 `workbench.read`（与路由 `x-scope` 一致）。 */
function requireWorkbenchRead(principal: Principal): void {
  if (!allowsScope(principal.scope, 'workbench', 'read')) {
    throw new AppError('FORBIDDEN', '缺少 workbench.read 权限');
  }
}

/**
 * 这个条目该不该为这个调用者查库。
 *
 * 按定义里声明的动作判（不写 = `approve`）。以前是「有没有任何域的 approve」一刀切，
 * 加了 `inventory_alert`（要 `read`）之后不再成立 —— 必须逐条判，否则仓管什么都看不到。
 */
function canQuery(principal: Principal, definition: TodoDefinition): boolean {
  return allowsScope(principal.scope, definition.domain, definition.action ?? 'approve');
}

async function countPending(
  tx: SqlClient,
  principal: Principal,
  definition: TodoDefinition,
): Promise<number> {
  const params: unknown[] = [principal.tenantId, [...principal.companyIds]];
  if (definition.ownedByCaller) params.push(principal.employeeId);
  const result = await tx.query<{ count: number }>(definition.sql, params);
  return result.rows[0]?.count ?? 0;
}

/**
 * GET /api/v1/todos：按权限点 × 动作 + 本人负责聚合待处理笔数。
 *
 * - 没有 `workbench.read` → 403；
 * - 永远固定返回 `TODO_KINDS` 全部 6 条（顺序一致），无权限/无数据的 count=0，
 *   前端不必兼容「空 items」与「6 条」两套形状；
 * - 没有任何候选域的 `approve` → 全部 count=0，不查库；
 * - 所有计数查询在同一个 `withTenant` 事务里执行，按 `companyId` 收窄。
 *
 * 查询次数上限：有 n 个候选域 `approve` 时，最多 n（≤ 6）条 `count` 串行执行，
 * 与可见公司数、单据行数无关。一期数据量小可接受；表大了改成 `Promise.all`
 * 并发，或把 6 条合并成单条 `UNION ALL`（届时同步调整本注释与用例断言）。
 */
export async function getWorkbenchTodos(
  ctx: WorkbenchTodoContext,
): Promise<TodoList> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);
  requireWorkbenchRead(principal);

  const counts = new Map<TodoKind, number>(
    TODO_DEFINITIONS.map((definition) => [definition.kind, 0] as const),
  );
  const eligible = TODO_DEFINITIONS.filter((definition) => canQuery(principal, definition));

  if (eligible.length > 0) {
    const queried = await withTenant(database, principal.tenantId, async (tx) => {
      const byKind = new Map<TodoKind, number>();
      for (const definition of eligible) {
        byKind.set(definition.kind, await countPending(tx, principal, definition));
      }
      return byKind;
    });
    for (const [kind, count] of queried) counts.set(kind, count);
  }

  const definitionsByKind = new Map(
    TODO_DEFINITIONS.map((definition) => [definition.kind, definition] as const),
  );
  const items: TodoItem[] = TODO_KINDS.map((kind) => {
    const definition = definitionsByKind.get(kind);
    if (!definition) {
      throw new AppError('INTERNAL_ERROR', `待办定义缺少 kind：${kind}`);
    }
    return {
      kind: definition.kind,
      title: definition.title,
      count: counts.get(definition.kind) ?? 0,
      hint: definition.hint,
      routeId: definition.routeId,
    };
  });

  return { items };
}
