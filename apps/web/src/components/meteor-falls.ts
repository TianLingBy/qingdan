/**
 * 流星雨的「落法」编排（纯函数，可单测）。
 *
 * 依据真实观测（比利时皇家空间高层大气研究所 BIRA-IASB）：
 * 流星雨成员的轨迹看起来都从天空中同一个点（辐射点 radiant）散开，越靠近辐射点拖尾越短；
 * 英仙座 ZHR≈100/h、双子座 120/h，速度 35–60 km/s，亮度分布指数 ≈2.1–2.6（多数暗、少数亮）。
 *
 * 产品上按负责人的观感要求做成两种落法各占一半：
 *  - `group`  ：同方向斜落的小分队（3–5 颗一组、同一斜角、起点错开、前后错开）；
 *  - `radiant`：从辐射点散开的个体（到达时间按泊松分布铺开）。
 *
 * 这里只产出「什么时候、从哪儿、往哪个方向」的编排；绘制在 `MeteorBackdrop`。
 */

export interface FallPlanEntry {
  /** group = 同方向小分队；radiant = 辐射点散开 */
  readonly kind: 'group' | 'radiant';
  /** 相对起点的触发时间（毫秒） */
  readonly at: number;
  /** 斜角（与水平线夹角，度）—— 只有 group 有 */
  readonly tilt?: number;
  /** 从左往右 / 从右往左 —— 只有 group 有 */
  readonly fromLeft?: boolean;
  /** 速度（px/s）—— 只有 group 有 */
  readonly speed?: number;
  /** 起点 —— 只有 group 有 */
  readonly x?: number;
  readonly y?: number;
  /** 拖尾基准长度（px）—— 只有 group 有（radiant 的拖尾按离辐射点距离实时算） */
  readonly len?: number;
  /** 同一组的编号（只有 group 有），测试与调试按组归并更可靠 */
  readonly groupId?: number;
}

export interface PlanOptions {
  /** 画布宽高（px） */
  readonly width: number;
  readonly height: number;
  /** 大流星雨总颗数，默认 12–20 随机 */
  readonly total?: number;
  /** 随机源，测试可注入 */
  readonly rand?: () => number;
}

const GROUP_MIN = 3;
const GROUP_MAX = 5;
const GROUP_TILT_MIN = 26;
const GROUP_TILT_MAX = 58;
/** 辐射点个体的到达窗口：约 7 秒（真实的流星雨是零星落，不是整队扫过） */
const RADIANT_WINDOW_MS = 7000;

/** 斜角：26°–58°，一组内保持同一条斜线。 */
function pickTilt(rand: () => number): number {
  return GROUP_TILT_MIN + rand() * (GROUP_TILT_MAX - GROUP_TILT_MIN);
}

/**
 * 编排一次大流星雨。
 *
 * 约一半是 group（3–5 颗一组，同一斜角、起点横向/纵深都错开、时间前后错开），
 * 剩下一半是 radiant（泊松间隔铺在 7 秒里）。
 */
export function planShower(options: PlanOptions): readonly FallPlanEntry[] {
  const { width, height } = options;
  const rand = options.rand ?? Math.random;
  const total = options.total ?? 12 + Math.round(rand() * 8);
  const entries: FallPlanEntry[] = [];
  const groupTarget = Math.round(total * 0.5);
  let grouped = 0;

  let groupSeq = 0;
  // 一组最少 3 颗，且不让小分队占比超过一半太多
  while (total - grouped >= GROUP_MIN && groupTarget - grouped >= GROUP_MIN) {
    const groupId = groupSeq;
    groupSeq += 1;
    const size = Math.max(
      GROUP_MIN,
      Math.min(
        total - grouped,
        groupTarget - grouped,
        GROUP_MIN + Math.round(rand() * (GROUP_MAX - GROUP_MIN)),
      ),
    );
    const fromLeft = rand() < 0.5;
    const tilt = pickTilt(rand);
    const speed = 380 + rand() * 170;
    let at = rand() * 3200;
    for (let k = 0; k < size; k += 1) {
      // 不同起跑线：横向按名次整段错开、纵深也逐颗错开（保证不在同一条线上）
      const laneX = 140 + k * (120 + rand() * 60);
      const laneY = 60 + k * (70 + rand() * 40) + rand() * 40;
      entries.push({
        kind: 'group',
        at,
        tilt,
        fromLeft,
        speed: speed * (0.94 + rand() * 0.18),
        x: fromLeft ? -laneX : width + laneX,
        y: -laneY,
        len: 140 + rand() * 130,
        groupId,
      });
      // 有前有后：累计推进 70–220ms，保证严格递增
      at += 70 + rand() * 150;
    }
    grouped += size;
  }

  // 剩下的一半：辐射点个体，按泊松（指数间隔）铺开
  const rest = total - grouped;
  let t = 0;
  for (let k = 0; k < rest; k += 1) {
    t += -Math.log(1 - rand() * 0.96) * (RADIANT_WINDOW_MS / Math.max(1, rest));
    entries.push({ kind: 'radiant', at: t });
  }

  // 高度只影响 group 的起点纵深范围，这里显式读一下避免参数未用（也便于将来按屏高调）
  void height;
  return entries;
}

/** 小流星雨：6–10 颗，5 秒内零星落下（只有辐射点个体）。 */
export function planSmallShower(total = 6 + Math.round(Math.random() * 4)): readonly FallPlanEntry[] {
  const entries: FallPlanEntry[] = [];
  let t = 0;
  for (let k = 0; k < total; k += 1) {
    t += -Math.log(1 - Math.random() * 0.96) * (5000 / total);
    entries.push({ kind: 'radiant', at: t });
  }
  return entries;
}

/** 画布 DPR 上限：面积越大越降，避免 4K 屏每帧重绘上千万像素（#性能）。 */
export function pickCanvasDpr(cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  const area = Math.max(1, cssWidth * cssHeight);
  const dpr = Math.max(1, devicePixelRatio || 1);
  if (area > 2_600_000) return Math.min(dpr, 1.25);
  if (area > 1_200_000) return Math.min(dpr, 1.5);
  return Math.min(dpr, 2);
}
