import type { ScopeMatrix } from '@qingdan/contracts';
import { allows, type ScopeDomain } from '../../lib/access';
import type { RouteEntry } from '../../router/routes';

/**
 * 工作台占位数据（#5：待办接口未做，先用假数据把版式与交互定下来）。
 *
 * 替换清单（接口好了逐个换掉本文件，页面组件不用动）：
 *   TODO(接口待做): GET /api/v1/todos —— 待办列表（按权限 × 动作 + 「本人负责」过滤，含单据类型/名称/笔数）
 *   TODO(接口待做): GET /api/v1/sales-orders?handlerId=me&status=进行中 等 —— 我负责的进行中单据
 *   TODO(接口待做): GET /api/v1/inventory/alerts —— 库存低于安全库存预警（D7/D45 二期看板一起上）
 *   TODO(接口待做): GET /api/v1/companies —— 公司切换下拉（当前只有 me.companyIds 的数量）
 *
 * 假数据也必须**按 scope 生成**，否则「老板 vs 销售卡片数不同」这条验收会退化成写死数字。
 */

export interface WorkbenchTodo {
  readonly id: string;
  /** 待办名称，如「采购单待审核」。 */
  readonly title: string;
  /** 待处理笔数（> 0 才显示）。 */
  readonly count: number;
  /** 一句话说明，说明「为什么是我的事」。 */
  readonly hint: string;
  /** 点进去落在哪一页。 */
  readonly routeId: RouteEntry['id'];
}

export interface WorkbenchDoc {
  readonly id: string;
  readonly orderNo: string;
  readonly kind: string;
  readonly partner: string;
  readonly summary: string;
  readonly status: string;
  readonly routeId: RouteEntry['id'];
}

export interface WorkbenchOverview {
  readonly todos: readonly WorkbenchTodo[];
  readonly docs: readonly WorkbenchDoc[];
}

export const workbenchKeys = {
  /** 按人取：换账号（或换人登录）不能复用上一个人的占位数字。 */
  overview: (employeeId: string) => ['workbench', 'overview', employeeId] as const,
};

interface TodoRule {
  readonly id: string;
  readonly domain: ScopeDomain;
  readonly title: string;
  readonly count: number;
  readonly hint: string;
  readonly routeId: RouteEntry['id'];
}

/** 只有持「审批」动作的域才会冒出待办——和原型 `todos.push` 的判定同一口径。 */
const TODO_RULES: readonly TodoRule[] = [
  { id: 'todo-purchase', domain: 'purchase', title: '采购单待审核', count: 3, hint: '张明提交的采购单等你确认', routeId: 'purchase-orders' },
  { id: 'todo-processing', domain: 'processing', title: '加工单待确认', count: 2, hint: '加工厂回传的产出与损耗待核对', routeId: 'processing-orders' },
  { id: 'todo-sales', domain: 'sales', title: '销售单待审核', count: 1, hint: '破成本下限的销售单需要你放行（D20）', routeId: 'sales-orders' },
  { id: 'todo-settlement', domain: 'settlement', title: '结算单待确认', count: 4, hint: '本月结算单草稿等你确认（D72）', routeId: 'settlements' },
  { id: 'todo-customer-return', domain: 'customer_return', title: '客户退货待审批', count: 1, hint: '退货单会影响批次可用量，请先核数量', routeId: 'reversals' },
  { id: 'todo-supplier-return', domain: 'supplier_return', title: '供应商退货待审批', count: 1, hint: '退货后成本按 T1/T2/T3 更正（D37）', routeId: 'reversals' },
  { id: 'todo-stocktake', domain: 'stocktake', title: '盘点盈亏待审批', count: 2, hint: '盘盈盘亏需老板或经理审批（D47/D71）', routeId: 'stocktakes' },
];

interface DocRule extends WorkbenchDoc {
  readonly domain: ScopeDomain;
}

const DOC_RULES: readonly DocRule[] = [
  {
    domain: 'sales',
    id: 'doc-e-1',
    orderNo: 'E-0001-20261109-0002',
    kind: '销售单',
    partner: '王记五金',
    summary: '12 件 · 2 个批次',
    status: '进行中',
    routeId: 'sales-orders',
  },
  {
    domain: 'purchase',
    id: 'doc-a-1',
    orderNo: 'A-0001-20261109-0003',
    kind: '采购单',
    partner: '恒昌钢材',
    summary: '200 箱 · 待入库',
    status: '进行中',
    routeId: 'purchase-orders',
  },
  {
    domain: 'processing',
    id: 'doc-b-1',
    orderNo: 'B-0001-20261109-0001',
    kind: '加工单',
    partner: '鑫达加工厂',
    summary: '投入 100 → 待验收',
    status: '进行中',
    routeId: 'processing-orders',
  },
  {
    domain: 'internal_trade',
    id: 'doc-n-1',
    orderNo: 'N-0001-20261109-0001',
    kind: '内部交易单',
    partner: '轻单贸易（二公司）',
    summary: '集团内调拨 · 待确认',
    status: '进行中',
    routeId: 'internal-trades',
  },
];

/** 纯函数：给定权限算出「我的待办 + 我负责的进行中单据」。 */
export function buildOverview(scope: ScopeMatrix | undefined): WorkbenchOverview {
  const todos = TODO_RULES.filter(
    (rule) => rule.count > 0 && allows(scope, rule.domain, 'approve'),
  ).map(({ domain: _domain, ...todo }) => todo);

  const docs = DOC_RULES.filter((rule) => allows(scope, rule.domain, 'read')).map(
    ({ domain: _domain, ...doc }) => doc,
  );

  return { todos, docs };
}

/** 模拟网络延迟，用于演示加载骨架；接真接口时整个函数换成 `workbenchApi.overview()`。 */
export const FAKE_LATENCY_MS = 400;

export function fetchWorkbenchOverview(
  scope: ScopeMatrix | undefined,
  latencyMs: number = FAKE_LATENCY_MS,
): Promise<WorkbenchOverview> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(buildOverview(scope)), latencyMs);
  });
}
