/**
 * 单据「编辑」按钮的禁用原因（#261 在加工单定下的三态口径，这里推广到采购单 / 销售单）。
 *
 * 为什么要单独抽出来：同一张单据页上，「列表行的编辑」和「详情面板的编辑」是两处独立
 * 判定，很容易一处判了权限、另一处只判了状态——结果就是**按钮点得动，点下去保存才 403**。
 * 把判定收成一个纯函数，两处都调它，就不会再漂。
 *
 * 顺序是**先权限后状态**：没有权限的人本来就改不了单，先告诉他缺哪个权限点；
 * 有权限但状态不允许，再说状态。两句话同时给，用户不知道该找谁。
 */

/** 目前用到这套口径的单据域。加工单那页（#261）先保留了自己的实现，合并后再切过来。 */
export type EditableOrderDomain = 'purchase' | 'sales';

const ORDER_WORDS: Readonly<Record<EditableOrderDomain, { readonly domain: string; readonly label: string }>> = {
  purchase: { domain: 'purchase', label: '采购单' },
  sales: { domain: 'sales', label: '销售单' },
};

/** `null` 表示「可以点」；非空字符串既是 `title` 也是按钮旁的灰色说明。 */
export function orderEditBlockedText(input: {
  readonly domain: EditableOrderDomain;
  readonly canUpdate: boolean;
  readonly canViewPrice: boolean;
  readonly status: string;
}): string | null {
  const words = ORDER_WORDS[input.domain];
  if (!input.canUpdate) return `当前身份没有 ${words.domain}.update 权限`;
  if (!input.canViewPrice) {
    return `无看价权限：看不到单价就没法改单（${words.domain}.view_price）`;
  }
  if (input.status !== '进行中') {
    return `只有「进行中」的${words.label}能编辑，当前是「${input.status}」`;
  }
  return null;
}
