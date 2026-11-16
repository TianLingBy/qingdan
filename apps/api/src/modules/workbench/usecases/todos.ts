import {
  AppError,
  TODO_KINDS,
  allowsScope,
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
 * | customer_return_pending | customer_return | 进行中 | `customer_return.complete` | customer_return.approve | 无（公司内全部） |
 * | supplier_return_pending | supplier_return | 进行中 | `supplier_return.complete` | supplier_return.approve | 无（公司内全部） |
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
  /** 该待办要求的权限域；调用者须持有该域 `approve`。 */
  readonly domain: DomainKey;
  /** 计数 SQL；参数固定为 $1=tenantId、$2=companyIds、$3=employeeId（公司内全部的查询不用 $3）。 */
  readonly sql: string;
  /** 是否用 `$3` 按本人过滤。 */
  readonly ownedByCaller: boolean;
}

/**
 * 待办定义（顺序 = 响应顺序）。
 *
 * 所有查询都按 `tenant_id` + 调用者可见 `company_id` 收窄；禁止跨公司。
 * `count = 0` 的条目也返回，前端据此决定是否显示。
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
    hint: '本公司在办的客户退货待确认',
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
    hint: '本公司在办的供应商退货待确认',
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

/** 该域的 `approve` 是否存在：没有的条目直接 count=0 且不查库。 */
function canApprove(principal: Principal, domain: DomainKey): boolean {
  return allowsScope(principal.scope, domain, 'approve');
}

/** 至少持有一个候选域的 approve 才去查库；一个都没有 → 空 items。 */
function hasAnyApprove(principal: Principal): boolean {
  return TODO_DEFINITIONS.some((definition) => canApprove(principal, definition.domain));
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
 * - 没有任何候选域的 `approve` → 直接返回空 `items`（不查库）；
 * - 其余情况固定返回全部 kind（无权限/无数据的 count=0），顺序与 `TODO_KINDS` 一致；
 * - 所有计数查询在同一个 `withTenant` 事务里执行，按 `companyId` 收窄。
 */
export async function getWorkbenchTodos(
  ctx: WorkbenchTodoContext,
): Promise<TodoList> {
  const principal = requirePrincipal(ctx.request);
  const database = requireDatabase(ctx);
  requireWorkbenchRead(principal);

  if (!hasAnyApprove(principal)) return { items: [] };

  const counts = await withTenant(database, principal.tenantId, async (tx) => {
    const byKind = new Map<TodoKind, number>();
    for (const definition of TODO_DEFINITIONS) {
      if (!canApprove(principal, definition.domain)) {
        byKind.set(definition.kind, 0);
        continue;
      }
      byKind.set(definition.kind, await countPending(tx, principal, definition));
    }
    return byKind;
  });

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
