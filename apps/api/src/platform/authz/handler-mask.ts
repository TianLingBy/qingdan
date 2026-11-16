import type { Principal } from '../auth/principal.js';

/**
 * 单据「负责人」字段脱敏（Issue #227 第 3 点）：
 * 持有任一单据域 `view_handler` 权限点的账号可见 `handlerId`；其余身份不下发（置 null）。
 *
 * 与 D79 金额脱敏同一原则：无权的数据不要发到响应体里。判定依据是 principal 上的
 * `canViewHandler`（由权限引擎按 sales / purchase / processing / internal_trade 的
 * `view_handler` 现算）；岗位 preset_key 只负责默认授权，不参与运行时判断（D90）。
 */

export function canViewHandlerOf(principal: Principal | null | undefined): boolean {
  return principal?.canViewHandler ?? false;
}

/** 单实体脱敏：无权时 handlerId 置 null，其余字段原样。 */
export function maskHandlerId<T extends { handlerId: string | null }>(
  value: T,
  principal: Principal | null | undefined,
): T {
  if (canViewHandlerOf(principal)) return value;
  return { ...value, handlerId: null };
}

/** 分页列表脱敏：对 `items` 逐条置 null。 */
export function maskHandlerIdInPage<T extends { handlerId: string | null }>(
  page: { items: readonly T[]; nextCursor: string | null },
  principal: Principal | null | undefined,
): { items: T[]; nextCursor: string | null } {
  return {
    ...page,
    items: page.items.map((item) => maskHandlerId(item, principal)),
  };
}
