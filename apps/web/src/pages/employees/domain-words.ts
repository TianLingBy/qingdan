/**
 * 功能域 × 动作词表（页面本地副本）。
 *
 * 唯一真源是 `packages/contracts/src/domains.ts`（D44：24 个功能域 × 8 动作）；
 * web 不依赖 contracts 包（避免把 zod 全量打进浏览器 bundle），这里按值复刻。
 * **contracts 词表变更时必须同步本文件**——`domain-words.test.ts` 会抽查两边数量
 * 对不上就红（读 contracts 源码文本做断言，不引包）。
 *
 * 「看价 view_price」是数据可见性开关（D4）：不进岗位模板勾选表，
 * 但个人级覆盖（D50）允许显式加减，因此保留在覆盖面板里。
 */

export const DOMAIN_WORDS: readonly { key: string; label: string }[] = [
  { key: 'purchase', label: 'A 采购单' },
  { key: 'processing', label: 'B 加工单' },
  { key: 'sales', label: 'E 销售单' },
  { key: 'internal_trade', label: 'N 内部交易' },
  { key: 'settlement', label: 'C 结算单' },
  { key: 'commission', label: '提成' },
  { key: 'customer_return', label: 'R 客户退货' },
  { key: 'supplier_return', label: 'S 供应商退货' },
  { key: 'stocktake', label: '盘点调整 I' },
  { key: 'product', label: '商品' },
  { key: 'customer', label: '客户' },
  { key: 'supplier', label: '供应商' },
  { key: 'processor', label: '加工厂' },
  { key: 'inventory_qty', label: '库存数量' },
  { key: 'inventory_flow', label: '库存流水' },
  { key: 'stocktake_page', label: '盘点' },
  { key: 'employee', label: '员工' },
  { key: 'permission', label: '权限设置' },
  { key: 'company', label: '公司管理' },
  { key: 'profit_report', label: '利润报表' },
  { key: 'audit', label: '操作日志' },
  { key: 'api_integration', label: 'API 与集成' },
  { key: 'payment', label: '在线支付' },
  { key: 'billing', label: '订阅与计费' },
] as const;

export const ACTION_WORDS: readonly { key: string; label: string }[] = [
  { key: 'read', label: '查' },
  { key: 'create', label: '建' },
  { key: 'update', label: '编' },
  { key: 'approve', label: '审' },
  { key: 'ship', label: '出' },
  { key: 'delete', label: '删' },
  { key: 'view_price', label: '看价' },
  { key: 'export', label: '导' },
] as const;

/** 权限覆盖被 403 拒绝的机器原因 → 人话提示（#6 验收：四种 reason 都要有对应文案）。 */
export const DENY_REASON_MESSAGES: Readonly<Record<string, string>> = {
  TARGET_IS_OWNER: '老板的权限只能由老板自己调整，你不能修改老板的权限。',
  TARGET_IS_MANAGER: '经理岗位持有者的权限受保护，只有老板可以调整。',
  TARGET_IS_FINANCE: '财务岗位持有者的权限受保护，只有老板可以调整。',
  SELF_ESCALATION_DENIED: '不能修改自己的权限（防止自我提权）；如需调整请联系老板。',
} as const;

/**
 * 把 403 响应翻译成人话：优先按 `details.reason` 查表；
 * `details.denied`（超出调用者自身权限的项）列出具体条目。
 */
export function describeDeny(details: unknown): string {
  const d = (details ?? {}) as {
    reason?: unknown;
    denied?: unknown;
  };
  const reason = typeof d.reason === 'string' ? d.reason : undefined;
  if (reason !== undefined && DENY_REASON_MESSAGES[reason] !== undefined) {
    return DENY_REASON_MESSAGES[reason]!;
  }
  if (Array.isArray(d.denied) && d.denied.length > 0) {
    const items = d.denied
      .map((item) => {
        if (typeof item !== 'object' || item === null) return null;
        const e = item as { domain?: unknown; action?: unknown };
        if (typeof e.domain !== 'string' || typeof e.action !== 'string') return null;
        const domainLabel = DOMAIN_WORDS.find((w) => w.key === e.domain)?.label ?? e.domain;
        const actionLabel = ACTION_WORDS.find((w) => w.key === e.action)?.label ?? e.action;
        return `${domainLabel}·${actionLabel}`;
      })
      .filter((v): v is string => v !== null);
    if (items.length > 0) {
      return `以下授权超出你自己的权限范围，已被拒绝：${items.join('、')}。`;
    }
  }
  return '你没有权限执行本次修改（403）。';
}

/**
 * 调用者是否「全量授权」（老板的近似判定，仅用于前端裁剪/禁用按钮）。
 * 服务端仍是唯一判定者（D15：前端隐藏不算数）；这里只为把明显不可用的选项置灰。
 */
export function hasFullScope(scope: readonly { domain: string; actions: readonly string[] }[]): boolean {
  if (scope.length < DOMAIN_WORDS.length) return false;
  return DOMAIN_WORDS.every((d) => {
    const entry = scope.find((s) => s.domain === d.key);
    return entry !== undefined && ACTION_WORDS.every((a) => entry.actions.includes(a.key));
  });
}
