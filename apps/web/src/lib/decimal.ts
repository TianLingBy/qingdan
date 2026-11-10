/**
 * 金额 / 数量的定点运算与展示口径（D54 `numeric(18,6)` / D27 看价 / D21 取消）。
 *
 * 为什么单独一层：A 采购单与 B 加工单都要算钱，抽一份比复制两份靠谱——
 * 复制出去的第二份一旦改了 scale 或负数处理，两个页面的合计就会对不上。
 *
 * 口径（别在这里发明）：
 * - 金额与数量在**传输层是 decimal 字符串**，不用 `number`：
 *   `0.1 × 3` 用浮点会得 `0.30000000000000004`，合计会漂（D54）；
 * - 运算走 BigInt 定点（scale = 6，与数据库 `numeric(18,6)` 对齐），
 *   **负数必须先摘符号再拼小数位**，否则 `-1.5` 会被算成 `-0.5`；
 * - 无看价权限时金额是 `null`（D79）：显示为破折号，**绝不用 0 顶替**——
 *   0 也是价格信息，会让人误判成「免费」。
 */

const SCALE = 6;
const SCALE_FACTOR = 10n ** 6n;
/** 非负 decimal（数量 / 单价 / B 单费用金额，D39）。 */
const DECIMAL_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;
/** 可负 decimal（A 单费用金额可为负：供应商返利，D39）。 */
const SIGNED_DECIMAL_PATTERN = /^-?\d{1,12}(\.\d{1,6})?$/;

/** 是否是非负 decimal 字符串（最多 6 位小数）。 */
export function isPositiveDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value.trim());
}

/** 是否是可负 decimal 字符串。 */
export function isSignedDecimal(value: string): boolean {
  return SIGNED_DECIMAL_PATTERN.test(value.trim());
}

function toScaled(value: string): bigint {
  const text = value.trim();
  if (!SIGNED_DECIMAL_PATTERN.test(text)) {
    throw new Error(`不是合法的 decimal 字符串：${value}`);
  }
  // 负号必须先摘掉再拼小数部分，否则 -1.5 会算成 -1000000 + 500000。
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [integer, fraction = ''] = body.split('.');
  const scaled = BigInt(integer!) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
}

function fromScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const integer = abs / SCALE_FACTOR;
  const fraction = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const body = fraction.length > 0 ? `${integer}.${fraction}` : `${integer}`;
  return negative ? `-${body}` : body;
}

/** 数量 × 单价 = 金额（精确到 6 位小数，去尾零）。 */
export function multiplyDecimal(left: string, right: string): string {
  return fromScaled((toScaled(left) * toScaled(right)) / SCALE_FACTOR);
}

/** 同列合计（费用行可为负）。空数组返回 `0`。 */
export function sumDecimal(values: readonly string[]): string {
  return fromScaled(values.reduce((total, value) => total + toScaled(value), 0n));
}

/** 左 − 右（结果可为负，例如「投入量 − 损耗量 = 可售量」，D5）。 */
export function subtractDecimal(left: string, right: string): string {
  return fromScaled(toScaled(left) - toScaled(right));
}

/** 比较两个 decimal：左小返回 -1、相等 0、左大 1（定点比较，不走浮点）。 */
export function compareDecimal(left: string, right: string): number {
  const a = toScaled(left);
  const b = toScaled(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 这笔金额是否真的是负数（`-0` / `-0.000` 不算）。 */
export function isNegativeDecimal(value: string): boolean {
  return value.trim().startsWith('-') && !/^-0(\.0+)?$/.test(value.trim());
}

/** 正数且不为 0（「数量必须大于 0」这类校验用）。 */
export function isPositiveNonZeroDecimal(value: string): boolean {
  return isPositiveDecimal(value) && toScaled(value) > 0n;
}

// ============ 展示 ============

/** 无看价权限时服务端金额为 null（D79）；显示为破折号，**不显示 0**。 */
export const MASKED_AMOUNT = '—';

/** 金额展示：`¥1,234.50`；`null` → 破折号（D79）。 */
export function formatMoney(value: string | null, currency = '¥'): string {
  if (value === null) return MASKED_AMOUNT;
  const negative = value.trim().startsWith('-');
  const abs = negative ? value.trim().slice(1) : value.trim();
  const [integer = '0', fraction = ''] = abs.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimals = fraction.padEnd(2, '0').slice(0, 2);
  return `${negative ? '-' : ''}${currency}${grouped}.${decimals}`;
}

/** 数量展示：整数不带小数点，带小数保留原样（去尾零）。 */
export function formatQty(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

// ============ 取消判定（D21：只渲染服务端结论，前端不重算） ============

export const CANCEL_REASON_TEXT: Readonly<Record<string, string>> = {
  already_completed: '单据已完成，不能取消（错账请走冲正 R / S / I）',
  already_cancelled: '单据已取消',
  has_downstream: '存在下游单据，需先取消下游',
};

/** 服务端 `cancelable.reason` → 人话；`null` 表示「可以取消」。 */
export function cancelDisabledReason(reason: string | null): string | null {
  if (reason === null) return null;
  return CANCEL_REASON_TEXT[reason] ?? '当前状态不可取消';
}
