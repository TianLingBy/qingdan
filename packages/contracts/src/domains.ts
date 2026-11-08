/**
 * 功能域词表（D44 的 20 个功能域 + D52 追加的操作日志/API 与集成 + #101 在线支付 = 23 个）。
 *
 * 这是 scope、审计 action、权限覆盖、tag、MCP 工具名共用的唯一键空间：
 * 任何模块不得自造 domain key，新增功能域必须同时改这里与 docs/decisions.md。
 * （D54 缺口 1 由 Lead 冻结：domain key 见下，审计 action = `domain.资源.动作`。）
 */
export const DOMAINS = {
  purchase: 'A 采购单',
  processing: 'B 加工单',
  sales: 'E 销售单',
  internal_trade: 'N 内部交易',
  settlement: 'C 结算单',
  commission: '提成',
  customer_return: 'R 客户退货',
  supplier_return: 'S 供应商退货',
  stocktake: '盘点调整 I',
  product: '商品',
  customer: '客户',
  supplier: '供应商',
  processor: '加工厂',
  inventory_qty: '库存数量',
  inventory_flow: '库存流水',
  stocktake_page: '盘点',
  employee: '员工',
  permission: '权限设置',
  company: '公司管理',
  profit_report: '利润报表',
  audit: '操作日志',
  api_integration: 'API 与集成',
  payment: '在线支付（客户扫码 / 回调）',
} as const;

export type DomainKey = keyof typeof DOMAINS;

export const DOMAIN_KEYS = Object.keys(DOMAINS) as DomainKey[];

/** 8 动作（D4 底层模型）：查 / 建 / 编 / 审 / 出（出库/发货）/ 删 / 看价 / 导。 */
export const ACTIONS = {
  read: '查',
  create: '建',
  update: '编',
  approve: '审',
  ship: '出',
  delete: '删',
  view_price: '看价',
  export: '导',
} as const;

export type Action = keyof typeof ACTIONS;

export const ACTION_KEYS = Object.keys(ACTIONS) as Action[];

export type Scope = `${DomainKey}.${Action}`;

export function scopeOf(domain: DomainKey, action: Action): Scope {
  return `${domain}.${action}`;
}
