import type { ScopeDomain } from '../../lib/access';
import type { RouteEntry } from '../../router/routes';

/**
 * 业务全流程图的数据层（22 页 IA 第 19 页，D7 / D19 / D40 / D44）。
 *
 * 为什么把图做成数据而不是直接写 JSX：
 *   - 图上每个节点都要能点进对应页面（#141 验收第 2 条），节点 ↔ 路由 id 必须可测；
 *   - 「已通 / 缺动作 / 页未做」是事实性描述，写在一处才好被测试盯住，
 *     避免代码改了、图上的话还停在上一版（#141 验收第 1 条：不画未落地的流程）。
 *
 * 三条自我约束：
 *   1. `done` 只写**已在 contracts 注册表里存在**的 operationId，测试会断言；
 *   2. `pendingOperationIds` 只写「签名已登记、handler 还没接」的 operationId
 *      （当前是 B 单完成），同样断言存在，防止把不存在的接口名写进图里；
 *   3. `gaps` / `limits` 分开：`gaps` 是还没做的，`limits` 是**有意不做**的
 *      （如 C 单没有创建端点），两者混在一起会让人误以为都欠着。
 *
 * 图只描述「单据之间怎么流转、对批次有什么影响」，不介绍字段级校验——
 * 那些以接口与页面为准，图上写多了反而容易过期。
 */

/** 卡片配色键；具体类名在 `FlowPage.tsx` 里以完整字面量给出，便于 Tailwind 静态扫描。 */
export type FlowTone =
  | 'sky'
  | 'violet'
  | 'emerald'
  | 'amber'
  | 'indigo'
  | 'rose'
  | 'orange'
  | 'teal';

export interface FlowDocStep {
  readonly kind: 'doc';
  /** 稳定 id，测试与 React key 共用 */
  readonly id: string;
  /** 单据代号：A / B / E / N / C / R / S / I */
  readonly code: string;
  /** 单据名（与导航标题一致，不加代号） */
  readonly name: string;
  /** 点击跳转的页面 */
  readonly routeId: RouteEntry['id'];
  /**
   * 读权限落在哪些功能域（命中任一即可点）。多数单据是单域，
   * 结算单例外：提成并入 C 单页，只有提成权限的人也该能进。
   */
  readonly domains: readonly ScopeDomain[];
  readonly tone: FlowTone;
  /** 这张单是干什么的 */
  readonly summary: string;
  /** 对批次 / 可用量的影响（图上最容易误解的部分，单独一行） */
  readonly stock: string;
  /** 已接通的 operationId（必须存在于 contracts 注册表） */
  readonly done: readonly string[];
  /** 还没落地的能力，人话描述 */
  readonly gaps: readonly string[];
  /** 契约已登记、handler 未接的 operationId */
  readonly pendingOperationIds?: readonly string[];
  /** 有意不支持的能力（不是欠账） */
  readonly limits?: readonly string[];
  /** 补充说明：不算这张单自己的缺口，但读图时该知道 */
  readonly note?: string;
}

/**
 * 主线上的连接带：两张单据之间那一步。
 *
 * `gap` 表示「这一步还没人做」——它不是单据，也没有接口，所以只能挂在连接带上，
 * 不能画成卡片（画成卡片会让人以为它是一个能打开的东西）。
 */
export interface FlowLink {
  readonly from: string;
  readonly to: string;
  /** 正常情况下这一步是什么 */
  readonly label: string;
  readonly gap?: {
    readonly label: string;
    readonly detail: string;
  };
}

/* --------------------------------- 主线 --------------------------------- */

const PURCHASE: FlowDocStep = {
  kind: 'doc',
  id: 'purchase',
  code: 'A',
  name: '采购单',
  routeId: 'purchase-orders',
  domains: ['purchase'],
  tone: 'sky',
  summary: '向供应商采购原料：商品明细 + 费用行，费用可为负（D39）。单据本身不引用批次。',
  stock: '不产生批次。原料要变成可引用的批次，得先走「原料入库」（D5）。',
  done: [
    'purchase.order.list.read',
    'purchase.order.create',
    'purchase.order.detail.read',
    'purchase.order.update',
    'purchase.order.cancel',
  ],
  gaps: ['原料入库：生成批次并把数量写进可用量'],
};

const PROCESSING: FlowDocStep = {
  kind: 'doc',
  id: 'processing',
  code: 'B',
  name: '加工单',
  routeId: 'processing-orders',
  domains: ['processing'],
  tone: 'violet',
  summary: '委外加工：材料投入 + 辅料 + 费用行，投入量由材料行合计派生且只读（F2b）。',
  stock: '引用原料批次；产出新批次与损耗结转都要等「完成」，而完成还没实现。',
  done: [
    'processing.order.list.read',
    'processing.order.create',
    'processing.order.detail.read',
    'processing.order.update',
    'processing.order.cancel',
    'processing.order.print',
  ],
  gaps: ['完成：产出批次入库、损耗转待验收（端点已登记，调用返回 501）'],
  pendingOperationIds: ['processing.order.complete'],
};

const SALES: FlowDocStep = {
  kind: 'doc',
  id: 'sales',
  code: 'E',
  name: '销售单',
  routeId: 'sales-orders',
  domains: ['sales'],
  tone: 'emerald',
  summary:
    '选批次出售：成本下限取批次锁价，低于下限只如实展示、不在前端拦（D20）；收款记录内嵌本页（D24）。',
  stock: '完成时按行内批次均分扣减可用量，并在同一事务生成 C 单草稿（D72）。',
  done: [
    'sales.order.list.read',
    'sales.order.create',
    'sales.order.detail.read',
    'sales.order.update',
    'sales.order.complete',
    'sales.order.cancel',
    'sales.order.print',
    'sales.order.export',
    'sales.receipt.read',
    'sales.receipt.create',
  ],
  gaps: [],
  note: '收款创建响应的金额还没按看价权限脱敏（写路径回的是真金额），已作为接口层问题报到主线。',
  limits: ['退款只追加负数收款行，不改已有行（D40）'],
};

const SETTLEMENT: FlowDocStep = {
  kind: 'doc',
  id: 'settlement',
  code: 'C',
  name: '结算单',
  routeId: 'settlements',
  domains: ['settlement', 'commission'],
  tone: 'amber',
  summary: '按来源单据归集销售额、成本、费用，算毛利与提成；确认后不可改。',
  stock: '不动库存。只吃 E 单完成时算好的金额。',
  done: [
    'settlement.order.list.read',
    'settlement.order.detail.read',
    'settlement.order.confirm',
    'commission.rate.list.read',
    'commission.rate.create',
    'commission.rate.delete',
  ],
  gaps: [],
  note: 'N 单完成未接，N 来源的草稿还不会自动产生（缺口记在 N 上）。',
  limits: [
    '没有创建端点：草稿只由来源单「完成」时自动生成，一期不提供手工建单（D19 / D29）',
    '一期一单一次结算，不支持部分结算（D19）',
  ],
};

export const MAIN_FLOW: readonly FlowDocStep[] = [PURCHASE, PROCESSING, SALES, SETTLEMENT];

/**
 * 主线的三段连接。前两段都断在「还没人做的动作」上，第三段是系统自动生成。
 * `gap.detail` 写的是为什么断、断了会怎样，不是复述 label。
 */
export const MAIN_LINKS: readonly FlowLink[] = [
  {
    from: 'purchase',
    to: 'processing',
    label: '原料投入',
    gap: {
      label: '原料入库',
      detail:
        'D5 口径是「入库时才生成批次并锁定单位成本」。目前没有批次创建端点，仓库里的批次只来自种子数据与盘点调整，所以 A 单的货还进不了 B 单。',
    },
  },
  {
    from: 'processing',
    to: 'sales',
    label: '成品出售',
    gap: {
      label: '产出结转',
      detail:
        'B 单「完成」没有实现，所以成品批次不会因加工而出现，损耗也没有结转到待验收（F3）。页面上的损耗量 / 可售量因此一直显示「待验收填入」。',
    },
  },
  {
    from: 'sales',
    to: 'settlement',
    label: '自动生成草稿',
  },
];

/* --------------------------------- 辅助 --------------------------------- */

/** N：跨公司调货，独立成单，不接在 A→B→E 的批次链上。 */
const INTERNAL_TRADE: FlowDocStep = {
  kind: 'doc',
  id: 'internal-trade',
  code: 'N',
  name: '内部交易单',
  routeId: 'internal-trades',
  domains: ['internal_trade'],
  tone: 'indigo',
  summary: '集团内公司间调货：发出公司与接收公司双边记录，成本按约定归集。',
  stock: '不动库存。发出 / 接收没接，所以在途量目前恒为 0。',
  done: [
    'internal_trade.order.list.read',
    'internal_trade.order.create',
    'internal_trade.order.detail.read',
    'internal_trade.order.update',
    'internal_trade.order.cancel',
  ],
  gaps: ['发出 / 接收：契约里没有这两个动作，N 单目前只能开单、改单、取消（D19 标注未接）'],
};

/** R：客户退货，只退钱。 */
const CUSTOMER_RETURN: FlowDocStep = {
  kind: 'doc',
  id: 'customer-return',
  code: 'R',
  name: '客户退货',
  routeId: 'reversals',
  domains: ['customer_return'],
  tone: 'rose',
  summary: '客户退货退款：只追加金额记录，不改历史行（D40）；录入走后端岗位校验（D47）。',
  stock: '不动库存，只退钱。',
  done: ['customer_return.list.read', 'customer_return.create', 'customer_return.detail.read'],
  gaps: ['完成 / 取消：创建后单据一直停在「进行中」，三态里只落地了创建'],
};

/** S：供应商退货，只退钱。 */
const SUPPLIER_RETURN: FlowDocStep = {
  kind: 'doc',
  id: 'supplier-return',
  code: 'S',
  name: '供应商退货',
  routeId: 'reversals',
  domains: ['supplier_return'],
  tone: 'orange',
  summary: '退回供应商并收回货款：只做退钱，没有抵下次货款、换货补发（F4c）。',
  stock: '不动库存，只退钱。',
  done: ['supplier_return.list.read', 'supplier_return.create', 'supplier_return.detail.read'],
  gaps: ['完成 / 取消：同上，创建后停在「进行中」'],
};

/** I：盘点，仓库里唯一「直接对着批次改数字」的单据。 */
const STOCKTAKE: FlowDocStep = {
  kind: 'doc',
  id: 'stocktake',
  code: 'I',
  name: '盘点盈亏',
  routeId: 'stocktakes',
  domains: ['stocktake_page', 'stocktake'],
  tone: 'teal',
  summary: '盘盈 / 盘亏单录入，审批后调批次数量；已批准 / 已驳回都是终态（D71）。',
  stock: '调整批次入库量并追加冲正流水，历史行不改不删；与 E 单完成共用同一个库存写入服务（D67 / D70）。',
  done: [
    'stocktake.list.read',
    'stocktake.increase.create',
    'stocktake.decrease.create',
    'stocktake.detail.read',
    'stocktake.approve',
  ],
  gaps: [],
};

export const SIDE_FLOW: readonly FlowDocStep[] = [
  INTERNAL_TRADE,
  CUSTOMER_RETURN,
  SUPPLIER_RETURN,
  STOCKTAKE,
];

/** 全部单据节点（主线 + 辅助），供表格视图与测试遍历。 */
export const FLOW_DOCS: readonly FlowDocStep[] = MAIN_FLOW.concat(SIDE_FLOW);

/* ------------------------------- 派生状态 ------------------------------- */

export type FlowMaturity = 'ready' | 'partial' | 'blocked';

/**
 * 成熟度由「还缺多少」派生，不单独存一份字段——
 * 手写状态迟早会和 gaps 打架（比如补了接口忘了改徽标）。
 */
export function maturityOf(step: FlowDocStep): FlowMaturity {
  if (step.gaps.length === 0) return 'ready';
  return step.done.length > 0 ? 'partial' : 'blocked';
}

export const MATURITY_TEXT: Record<FlowMaturity, string> = {
  ready: '已通',
  partial: '缺动作',
  blocked: '未接',
};

/** 主线上的单据顺序，用于「A → B → E → C」的一句话说明与测试。 */
export const MAIN_DOC_ORDER: readonly string[] = MAIN_FLOW.map((step) => step.code);
