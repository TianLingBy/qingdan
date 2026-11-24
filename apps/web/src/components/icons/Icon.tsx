/**
 * v3.0 图标组件（#443 第 0 步）。
 *
 * 路径全部逐条抄自 `design/v3.0/四态与组件对照-给repo.md` §五（23 枚），
 * **不引任何图标库**（#443 边界：不加依赖）。
 *
 * 规格与稿子一致：`viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、
 * `stroke-width="1.6"`、`round` 端点，默认 18px，跟随父级 `font-size` 之外的显式尺寸。
 *
 * 数量为什么是 23 而不是 issue 标题写的 24：
 * §五 表格里有 name + path 的只有 23 枚（分页 4 + 功能 19），「第 24 枚」在 #445 待负责人拍板
 * （梁海俊已在 #443 注明先别按 24 写测试）。若最终取 24，把那一枚的 path 补进 `ICONS`
 * 与 `ICON_NAMES` 即可，`IconName` 会自动扩，调用方无需改。
 */
import type { CSSProperties } from 'react';

/** 图标名 → path 的 `d`。新增一枚只改这里 + `ICON_NAMES`。 */
const ICONS = {
  /** 分页：首页 */
  'pg-first': 'M17 6l-6 6 6 6M8 6v12',
  /** 分页：上一页 */
  'pg-prev': 'M15 6l-6 6 6 6',
  /** 分页：下一页 */
  'pg-next': 'M9 6l6 6-6 6',
  /** 分页：末页 */
  'pg-last': 'M7 6l6 6-6 6M16 6v12',
  /** 库龄 */
  clock: 'M12 8v4l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',
  /** 趋势 */
  trend: 'M4 17l6-6 4 4 6-7M20 8h-4M20 8v4',
  /** 删除 / 吊销 */
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  /** 编辑 */
  pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  /** 密钥 */
  key: 'M9 15a3 3 0 100-6 3 3 0 000 6zM11.1 12.9L20 4M17 7l3 3M15 9l2 2',
  /** 只追加 / 受保护 */
  shield: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM9 12l2 2 4-4',
  /** 重试 / 重发 / 加载 */
  refresh: 'M20 11a8 8 0 10-2.3 7M20 5v6h-6',
  /** 统计周期 */
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  /** 筛选无结果 */
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  /** 入库 */
  'arrow-in': 'M12 4v13m0 0l-5-5m5 5l5-5',
  /** 出库 */
  'arrow-out': 'M12 20V7m0 0l-5 5m5-5l5 5',
  /** 调整 */
  adjust: 'M4 8h9m4 0h3M4 16h3m4 0h9M15 5v6M9 13v6',
  /** 邀请码 / 入企 */
  ticket: 'M4 8h16v3a2 2 0 000 4v3H4v-3a2 2 0 000-4z',
  /** 允许 / 批准 */
  check: 'M5 13l4 4L19 7',
  /** 驳回 */
  undo: 'M9 14l-4-4 4-4M5 10h9a5 5 0 010 10h-4',
  /** 复制密钥 */
  copy: 'M9 9h11v11H9zM15 5H4v11',
  /** 主对接人 */
  star: 'M12 4l2.4 5 5.6.8-4 4 .9 5.6-4.9-2.7-4.9 2.7.9-5.6-4-4 5.6-.8z',
  /** 锁定 */
  pin: 'M12 3v9m0 0l4 3v-3H8v3zM9 15h6M12 15v6',
  /** 拆分 / 调拨 */
  split: 'M4 5v14M20 5v14M8 9l4 3-4 3M16 12H8',
} as const;

export type IconName = keyof typeof ICONS;

/**
 * 导出给测试与页面做数量断言 / 下拉枚举用。
 * **当前 23 枚**（§五 里带 path 的全部）；#445 拍板取 24 后这里会变 24。
 */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** 图标名 → path，页面上要自己画 SVG 时可直接取。 */
export function iconPath(name: IconName): string {
  return ICONS[name];
}

export interface IconProps {
  readonly name: IconName;
  /** 边长，默认 18（稿子 `.ic` 的默认尺寸）。 */
  readonly size?: number;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** 默认 true：图标本身不承载语义，旁边一定有文字或 aria-label。
   *  纯图标按钮请传 `aria-label` 给按钮，并把这里保持 true。 */
  readonly decorative?: boolean;
}

/**
 * 用法：
 * ```tsx
 * <Icon name="pencil" />                 // 18px，跟随 currentColor
 * <Icon name="refresh" size={14} className="spin" />
 * <button aria-label="删除"><Icon name="trash" /></button>
 * ```
 */
export function Icon({ name, size = 18, className, style, decorative = true }: IconProps) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
