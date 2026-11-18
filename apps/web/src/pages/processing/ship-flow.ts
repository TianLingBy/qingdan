/**
 * 加工单「发货 / 撤销发货 / 到货确认」的口径（D94 ②）。
 *
 * 为什么单独成文件：本仓 Web 测试不带 jsdom（`renderToStaticMarkup` 做静态断言），
 * 交互路径只能靠纯函数覆盖。页面里只留接线，不留规则——照 `purchase/ship-flow.ts`
 * 的做法，两个模块的口径才能一眼对比。
 *
 * 权限口径（契约 `packages/contracts/src/processing-orders.ts`）：
 * - 发货 `processing.ship`、撤销发货 `processing.ship`（同一个动作的两端）
 * - 到货确认 `processing.approve`（验收动作，不是改单、也不是发货）
 *
 * 为什么发货与到货确认是**两个权限点**：发货是「把货交出去」，到货确认是「验收并
 * 落产出批次、认损耗」。同一个人既发货又验收，损耗就没人复核了——这正是 D94 拆
 * 两步的目的，所以权限也拆开。
 */

import type {
  ProcessingOrderDetail,
  ProcessingOrderShipInput,
  ProcessingOrderStatus,
} from '@qingdan/contracts';
import { compareDecimal } from '../../lib/decimal';

/** 在途分段（D94 ②）：`materials` 料在路上 / `finished` 成品在路上。 */
export type TransitStage = 'materials' | 'finished';

/** 在途去向：`warehouse` 回仓 / `customer` 直发客户。 */
export type TransitTo = 'warehouse' | 'customer';

export const STAGE_LABEL: Readonly<Record<TransitStage, string>> = {
  materials: '料（材料段）',
  finished: '成品（成品段）',
};

export const TRANSIT_LABEL: Readonly<Record<TransitTo, string>> = {
  warehouse: '回仓',
  customer: '直发客户',
};

/** 发货弹层的一份草稿（`lossQty` 用字符串：数字输入框给的本来就是字符串）。 */
export interface ShipDraft {
  readonly transitStage: TransitStage;
  readonly transitTo: TransitTo;
  readonly lossQty: string;
  readonly custodianId: string;
  readonly confirmFullLoss: boolean;
}

const IN_TRANSIT_HINT = '在途的单只能「到货确认」或「撤销发货」，不能改、不能取消。';

/**
 * 「发货」能不能点：先权限后状态，只出一句。
 *
 * 顺序是刻意的——没权限的人看到「状态不对」会以为换张单就能发，实际他连发货动作
 * 都没有。缺权限时永远先说权限。
 */
export function shipBlockedText(input: {
  readonly canShip: boolean;
  readonly status: ProcessingOrderStatus;
}): string | null {
  if (!input.canShip) {
    return '当前身份没有 processing.ship 权限（发货是独立动作，能改单不等于能发货）';
  }
  if (input.status === '进行中') return null;
  if (input.status === '在途') return `这张单已经在途了，无需重复发货。${IN_TRANSIT_HINT}`;
  return `只有「进行中」的加工单能发货，当前是「${input.status}」`;
}

/** 「撤销发货」能不能点：权限同为 `processing.ship`，状态必须是「在途」。 */
export function revokeShipBlockedText(input: {
  readonly canShip: boolean;
  readonly status: ProcessingOrderStatus;
}): string | null {
  if (!input.canShip) {
    return '当前身份没有 processing.ship 权限（撤销发货与发货是同一个权限点）';
  }
  if (input.status === '在途') return null;
  return `只有「在途」的加工单能撤销发货，当前是「${input.status}」`;
}

/** 「到货确认」能不能点：`processing.approve` + 状态「在途」。 */
export function receiveBlockedText(input: {
  readonly canApprove: boolean;
  readonly status: ProcessingOrderStatus;
}): string | null {
  if (!input.canApprove) {
    return '当前身份没有 processing.approve 权限（到货确认是验收动作，要落产出批次、认损耗）';
  }
  if (input.status === '在途') return null;
  if (input.status === '进行中') {
    return '还没发货，没有可确认的到货；要直接完工请点「完成 / 验收」。';
  }
  return `只有「在途」的加工单能到货确认，当前是「${input.status}」`;
}

/**
 * 撤销原因校验：trim 后 1–200 字。
 *
 * 契约路由标了 `ai.reasonRequired`，但服务端对人工账号只把原因记进审计
 * （`X-Reason` → `request.auditReason`）。撤销发货会清空在途分段、把单据打回
 * 「进行中」，事后没人知道为什么——所以「必须给原因」这道门只能在前端有。
 */
export function revokeReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed === '') return '撤销发货必须填写原因，本次未提交。';
  if (trimmed.length > 200) return '撤销原因不能超过 200 字，本次未提交。';
  return null;
}

/**
 * 打开发货弹层时的初始草稿：默认「成品段 · 回仓」，损耗量留空。
 *
 * 为什么不预填 `order.lossQty`：开单时那边本来就是空的（F3 只在验收时填），
 * 而且在途阶段的实际损耗还没发生，预填一个数会被当成"已经知道损耗多少"。
 */
export function emptyShipDraft(): ShipDraft {
  return { transitStage: 'finished', transitTo: 'warehouse', lossQty: '', custodianId: '', confirmFullLoss: false };
}

function isNonNegativeDecimal(value: string): boolean {
  return /^\d+(\.\d{1,6})?$/.test(value.trim());
}

/**
 * 提交前校验（服务端仍会再校一遍，契约 `superRefine` 是最后一道）：
 * 1. `finished` 段必须填损耗量，且不能超过投入量——否则「可售量 = 投入 − 损耗」为负；
 * 2. `materials` 段**不许**带损耗量 / 保管人 / 全损耗确认（契约明确报错）；
 * 3. 全损耗要二次确认（G2）。
 *
 * 第 2 条在 UI 上表现为"料段根本不显示这些输入"，这里再兜一次是因为草稿可能来自
 * 用户先选成品段填了数、再切回料段——切段时不清空就会把非法字段带进请求。
 */
export function validateShipDraft(draft: ShipDraft, order: ProcessingOrderDetail): string[] {
  const errors: string[] = [];

  if (draft.transitStage === 'materials') {
    if (draft.lossQty.trim() !== '') {
      errors.push('料段不填损耗：货还在去加工厂的路上，实际损耗还没发生，切回料段请清空损耗量。');
    }
    return errors;
  }

  const loss = draft.lossQty.trim();
  if (loss === '') {
    errors.push('成品段必须填损耗量（可售量 = 投入量 − 损耗量，验收要落产出批次）。');
    return errors;
  }
  if (!isNonNegativeDecimal(loss)) {
    errors.push('损耗量必须是非负数字，最多 6 位小数。');
    return errors;
  }
  if (compareDecimal(loss, order.inputQty) > 0) {
    errors.push(`损耗量不能大于投入量 ${order.inputQty}（否则可售量为负）。`);
    return errors;
  }
  if (compareDecimal(loss, order.inputQty) === 0 && !draft.confirmFullLoss) {
    errors.push('损耗量等于投入量（全损耗）：请勾选「确认全损耗」后再提交，全损耗不生成产出批次。');
  }
  return errors;
}

/**
 * 提交入参：**按段裁字段**。
 *
 * - `materials`：只发 `transitStage`。料往加工厂去，去向就是单据上的加工厂，
 *   契约对「料段带 transitTo」现在是报错（#333 复核：原来会写入一个成品去向）。
 * - `finished`：发 `transitTo` + `lossQty`，可选 `custodianId` / `confirmFullLoss`。
 *
 * 契约对多余字段是报错而不是忽略，多带一个就 422，所以这里逐个挑而不是整体展开。
 */
export function buildShipInput(draft: ShipDraft): ProcessingOrderShipInput {
  if (draft.transitStage === 'materials') return { transitStage: 'materials' };
  return {
    transitStage: 'finished',
    transitTo: draft.transitTo,
    lossQty: draft.lossQty.trim(),
    ...(draft.custodianId.trim() === '' ? {} : { custodianId: draft.custodianId.trim() }),
    ...(draft.confirmFullLoss ? { confirmFullLoss: true } : {}),
  };
}
