/**
 * A 单完成建批次：把费用摊进行锁价（D83；配套 D5 / D54）。
 *
 * 口径（#272）：
 * - `feeTotal = SUM(purchase_order_fee.amount)`，费用最低 0（D39 负数冲减口径另行删除）；
 * - 按明细行金额（`qty × unitPrice`）占比分摊：前 n-1 行四舍五入到 6 位小数（`amount` 域，D54），
 *   **最后一行承接全部余数**，保证 `SUM(feeShare) === feeTotal`；
 * - 行金额合计为 0 时退化为按数量占比分摊，同样最后由末行承接余数；
 * - 摊后单价 = `(行金额 + 费用份额) ÷ 数量`，四舍五入到 6 位小数；
 * - 数量为 0 的行不建批次、不参与分摊，直接跳过。
 *
 * 精度：全程 bigint 定点运算（6 位小数微单位），不出现 `Number()` / 浮点。
 * 行金额用 `qty × unitPrice` 的 12 位精确乘积，而不是先取 6 位的 `purchase_order_line.amount`，
 * 这样无费用时 `(行金额 + 0) ÷ 数量` 严格等于明细单价，不会因为先落库 6 位再反算而漂移。
 */

const SCALE = 1_000_000n;

/** 分摊口径：`byAmount` = 按明细金额占比；`byQty` = 行金额合计为 0 时按数量占比。 */
export type FeeAllocationBasis = 'byAmount' | 'byQty';

export interface FeeAllocationInputLine {
  /** 明细行号（1 起，与 `purchase_order_line.line_no` / 审计口径一致）。 */
  readonly lineNo: number;
  readonly qty: string;
  readonly unitPrice: string;
}

export interface FeeAllocationLine {
  readonly lineNo: number;
  readonly qty: string;
  readonly unitPrice: string;
  /** 该行分到的费用（decimal 字符串，可 0；正负与 feeTotal 一致）。 */
  readonly feeShare: string;
  /** 锁进批次的单价 = (行金额 + feeShare) ÷ 数量。 */
  readonly adjustedUnitCost: string;
}

export interface FeeAllocation {
  readonly basis: FeeAllocationBasis;
  readonly feeTotal: string;
  /** 只含数量 > 0 的行；数量为 0 的行没有批次，也就不参与分摊。 */
  readonly lines: readonly FeeAllocationLine[];
}

/** decimal 字符串 → 6 位定点微单位。调用方保证最多 6 位小数（D54）。 */
function toMicro(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const micro = BigInt(whole || '0') * SCALE + BigInt(fraction.padEnd(6, '0'));
  return negative ? -micro : micro;
}

/** 6 位定点微单位 → 最短 decimal 字符串（与 `trim_scale` 输出一致，不带尾零）。 */
function fromMicro(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * 四舍五入（远离 0），返回整数商：`round(numerator / denominator)`。
 * `numerator / denominator` 本身就是目标定点值（同尺度相除），不需要再乘 SCALE。
 */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = (2n * absNumerator + absDenominator) / (2n * absDenominator);
  return negative ? -quotient : quotient;
}

/**
 * 计算每行应摊费用与摊后锁价。
 *
 * 调用方把单头全部明细与费用金额传进来；函数自己跳过 `qty = 0` 的行。
 * 返回的 `lines` 与传入顺序一致（已去掉 0 数量行），可直接逐行建批次。
 */
export function allocatePurchaseFees(
  lines: readonly FeeAllocationInputLine[],
  feeAmounts: readonly string[],
): FeeAllocation {
  const eligible = lines
    .map((line) => {
      const qtyMicro = toMicro(line.qty);
      const unitPriceMicro = toMicro(line.unitPrice);
      return { line, qtyMicro, unitPriceMicro, amount12: qtyMicro * unitPriceMicro };
    })
    .filter((entry) => entry.qtyMicro > 0n);

  const feeTotalMicro = feeAmounts.reduce((sum, amount) => sum + toMicro(amount), 0n);
  const amountTotal12 = eligible.reduce((sum, entry) => sum + entry.amount12, 0n);
  const qtyTotalMicro = eligible.reduce((sum, entry) => sum + entry.qtyMicro, 0n);
  const basis: FeeAllocationBasis = amountTotal12 > 0n ? 'byAmount' : 'byQty';

  const shares: bigint[] = [];
  let allocated = 0n;
  eligible.forEach((entry, index) => {
    // 余数一律由最后一行承接：前面的行各自四舍五入，末行 = 总额 − 已分。
    const share =
      index === eligible.length - 1
        ? feeTotalMicro - allocated
        : basis === 'byAmount'
          ? roundDiv(feeTotalMicro * entry.amount12, amountTotal12)
          : roundDiv(feeTotalMicro * entry.qtyMicro, qtyTotalMicro);
    allocated += share;
    shares.push(share);
  });

  const allocatedLines = eligible.map((entry, index) => {
    const shareMicro = shares[index] ?? 0n;
    // (金额12 + 份额6) ÷ 数量6，结果乘回 6 位：lineAmount12 + share6 * SCALE 后再除以 qtyMicro。
    const adjustedMicro = roundDiv(entry.amount12 + shareMicro * SCALE, entry.qtyMicro);
    return {
      lineNo: entry.line.lineNo,
      qty: entry.line.qty,
      unitPrice: entry.line.unitPrice,
      feeShare: fromMicro(shareMicro),
      adjustedUnitCost: fromMicro(adjustedMicro),
    };
  });

  return { basis, feeTotal: fromMicro(feeTotalMicro), lines: allocatedLines };
}
