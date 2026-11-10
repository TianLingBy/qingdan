/**
 * 业务模块键（与 `AGENTS.md` 的模块登记表同源，D62）。
 *
 * 用途：**路由归属**。注册表里每条路由必须声明自己属于哪个模块，
 * 各模块只挂自己的路由；`platform` 不得遍历整张 `ROUTES` 表（Issue #15 的根因）。
 */
export const MODULES = {
  platform: '平台内核（认证 / 权限 / 审计 / Token）',
  masterdata: '主数据（商品 / 客户 / 供应商 / 加工厂）',
  inventory: '库存（批次 / 流水 / 盘点）',
  purchase: '采购（A 单）',
  processing: '加工（B 单）',
  sales: '销售（E / N 单）',
  settlement: '结算（C 单）',
  'internal-trade': '内部交易（I / R / S 单）',
  payment: '支付（商户配置 / 回调 / 对账）',
  report: '报表（利润报表 / 跨模块聚合）',
  test: '测试支撑（不承载业务口径）',
} as const;

export type ModuleKey = keyof typeof MODULES;

export const MODULE_KEYS = Object.keys(MODULES) as ModuleKey[];

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as string[]).includes(value);
}
