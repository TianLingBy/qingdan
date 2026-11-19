/**
 * 采购单「发货 / 撤销发货 / 到货确认」的口径（D94 ①/④/⑤）。
 *
 * 为什么单独成文件：这三个动作的**可点判定、禁用原因、提交入参**都要被测，
 * 而本仓 Web 测试不带 jsdom（`renderToStaticMarkup` 做静态断言），
 * 交互路径只能靠纯函数覆盖。页面里只留接线，不留规则。
 *
 * 权限口径（契约 `packages/contracts/src/purchase-orders.ts`）：
 * - 发货 `purchase.ship`、撤销发货 `purchase.ship`（同一个动作的两端）
 * - 到货确认 `purchase.approve`（审批动作，不是改单）
 * - **完成** `purchase.approve`（D94 之前是 `update`；能改单不再自动能入库）
 */

import type {
  PurchaseOrderDetail,
  PurchaseOrderShipInput,
  PurchaseOrderStatus,
} from '@qingdan/contracts';

/** 到货去向（D94 ①）：`warehouse` 回仓库 / `processor` 直发加工厂。 */
export type TransitTo = 'warehouse' | 'processor';

/** 一行的发货草稿：选中转去向与加工厂（只有直发时才用得上加工厂）。 */
export interface ShipDirection {
  readonly transitTo: TransitTo;
  readonly processorId: string;
}

export const TRANSIT_LABEL: Readonly<Record<TransitTo, string>> = {
  warehouse: '回仓库',
  processor: '直发加工厂',
};

const IN_TRANSIT_HINT = '在途的单只能「到货确认」或「撤销发货」，不能改、不能取消。';

/**
 * 「发货」能不能点：先权限后状态，只出一句。
 *
 * 顺序是刻意的——没权限的人看到「状态不对」会以为换张单就能发；
 * 实际上他连发货这个动作都没有。缺权限时永远先说权限。
 */
export function shipBlockedText(input: {
  readonly canShip: boolean;
  readonly status: PurchaseOrderStatus;
}): string | null {
  if (!input.canShip) {
    return '当前身份没有 purchase.ship 权限（发货是独立动作，能改单不等于能发货）';
  }
  if (input.status === '进行中') return null;
  if (input.status === '在途') return `这张单已经在途了，无需重复发货。${IN_TRANSIT_HINT}`;
  return `只有「进行中」的采购单能发货，当前是「${input.status}」`;
}

/** 「撤销发货」能不能点：权限同为 `purchase.ship`，状态必须是「在途」。 */
export function revokeShipBlockedText(input: {
  readonly canShip: boolean;
  readonly status: PurchaseOrderStatus;
}): string | null {
  if (!input.canShip) {
    return '当前身份没有 purchase.ship 权限（撤销发货与发货是同一个权限点）';
  }
  if (input.status === '在途') return null;
  return `只有「在途」的采购单能撤销发货，当前是「${input.status}」`;
}

/** 「到货确认」能不能点：`purchase.approve` + 状态「在途」。 */
export function receiveBlockedText(input: {
  readonly canApprove: boolean;
  readonly status: PurchaseOrderStatus;
}): string | null {
  if (!input.canApprove) {
    return '当前身份没有 purchase.approve 权限（到货确认是审批动作，不是改单）';
  }
  if (input.status === '在途') return null;
  if (input.status === '进行中') {
    return '还没发货，没有可确认的到货；要直接入库请点「完成采购单」。';
  }
  return `只有「在途」的采购单能到货确认，当前是「${input.status}」`;
}

/**
 * 撤销原因校验：trim 后 1–200 字。
 *
 * 服务端目前**只把它记进审计**（`X-Reason` 头 → `request.auditReason`），
 * 对人工账号没有强制校验；契约里写的是「必须给原因」，所以这道门必须在前端有。
 */
export function revokeReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed === '') return '撤销发货必须填写原因，本次未提交。';
  if (trimmed.length > 200) return '撤销原因不能超过 200 字，本次未提交。';
  return null;
}

/**
 * 打开发货弹层时的初始去向：照单据上已有的 `transitTo` 预填，没有就按「回仓库」。
 *
 * 预填而不是一律清空：开单时若已经指定过「直发某厂」，发货时再让人重选一遍很容易选错。
 */
export function defaultDirections(order: PurchaseOrderDetail): ShipDirection[] {
  return order.lines.map((line) => ({
    transitTo: line.transitTo ?? 'warehouse',
    processorId: line.processorId ?? '',
  }));
}

/**
 * 提交前的前端校验（服务端仍会再校一遍）：
 * 直发的行必须选具体加工厂，否则等 422 才知道就白点一次。
 */
export function validateDirections(
  order: PurchaseOrderDetail,
  directions: readonly ShipDirection[],
  options: { readonly processorReadable?: boolean } = {},
): string[] {
  const errors: string[] = [];
  if (order.lines.length === 0) {
    errors.push('这张单没有明细行，无法发货。');
    return errors;
  }
  if (directions.length !== order.lines.length) {
    errors.push('发货明细与单据行数不一致，请刷新后重试（单据可能被别人改过）。');
    return errors;
  }

  const processorLines = directions.filter((item) => item.transitTo === 'processor');
  if (processorLines.length > 0 && options.processorReadable === false) {
    errors.push(
      '当前身份没有 processor.read 权限，看不到加工厂列表：这一单只能整单「回仓库」，或请有权限的人来发货。',
    );
    return errors;
  }

  directions.forEach((direction, index) => {
    if (direction.transitTo === 'processor' && direction.processorId.trim() === '') {
      errors.push(`第 ${index + 1} 行选的是「直发加工厂」，请选具体加工厂。`);
    }
  });
  return errors;
}

/**
 * 提交入参：`lineNo` 取明细行**自带的 `lineNo`**（视图字段，服务端建单时落库的行号）。
 *
 * 曾经只能用 `index + 1`：视图 `PurchaseOrderLineViewSchema` 没有 `lineNo`，而发货入参
 * 是按行号定位的。现在视图补上了这个字段，前端不再自己数 —— 数组下标在并发改单
 * （后端行被删/重排）后会错位，指错行等于把货发到错的地方。
 *
 * **每一行都显式发**（不依赖「未列出按回仓库」的缺省）——少一条隐式约定，少一处错。
 */
export function buildShipInput(
  order: PurchaseOrderDetail,
  directions: readonly ShipDirection[],
): PurchaseOrderShipInput {
  return {
    lines: order.lines.map((line, index) => {
      const direction = directions[index] ?? { transitTo: 'warehouse', processorId: '' };
      return direction.transitTo === 'processor'
        ? {
            lineNo: line.lineNo,
            transitTo: 'processor' as const,
            processorId: direction.processorId.trim(),
          }
        : { lineNo: line.lineNo, transitTo: 'warehouse' as const };
    }),
  };
}
