/**
 * 单据详情区的三块公用版式（#337 v0.13 单据组）。
 *
 * 为什么单独成一个文件：六张单据（A / B / E / N / C / 冲正）的详情区原本各写一套
 * 「单号 + 状态 + 一排 dl」，同一个信息在不同页上字号、底色、间距都不一样。
 * 视觉稿 `design/v0.13/单据详情.html` 给了一套统一版式，这里把其中**与业务无关**的三块抽出来：
 *
 * - `DetailHead`：标题（单据名 + 单号）+ 状态徽标 + 右侧动作槽 + 关闭；
 * - `DocMeta`：`单据详情.html` 的「单据信息」三列网格（dt / dd）；
 * - `LinesFooter`：明细表的 `tfoot` 合计行（「共 N 行 · 数量合计 X」+ 金额合计）。
 *
 * **刻意不做的两块**（详见 #337 留言）：
 * - 右栏「走到哪一步了」的时间线：审计日志没有按单据 id 过滤的参数，画出来只能是假的；
 * - A4 打印版式：打印端点只有 `sales.order.print` / `processing.order.print` 两条，
 *   其余单据点了没东西可打，不画假按钮。
 *
 * 状态徽标用 v0.13 的 `.st` 系列（`styles/app-v013.css`）：浅底深字、高度固定 22px，
 * 比各页原先自拼的 Tailwind `bg-*-50` 更稳（同一个「在途」在不同页不会变两种黄）。
 */

import type { ReactNode } from 'react';

/* ------------------------------ 状态徽标 ------------------------------ */

/**
 * `.st` 的语义色档（对应 `app-v013.css` 的 `.st.now/.ok/.warn/.bad/.transit/.cancel/.draft`）。
 *
 * 选档规则（与视觉稿一致，别按「好看」挑）：
 * - `now` 进行中（还要人干活）→ 苔绿；`warn` 待确认 / 待审批 → 黄；
 * - `transit` 在途（货在路上）→ 蓝；`ok` 已完成 / 已结算 / 已批准 → 绿；
 * - `bad` 需要处理 / 被驳回 → 红；`cancel` 已取消 → 灰 + 删除线。
 */
export type DocPillTone = 'now' | 'ok' | 'warn' | 'bad' | 'transit' | 'cancel' | 'draft';

export interface DocPillProps {
  readonly label: string;
  readonly tone: DocPillTone;
  /** 悬停说明（为什么是这个状态、下一步该谁做），没有就留空。 */
  readonly title?: string;
}

export function DocPill({ label, tone, title }: DocPillProps) {
  return (
    <span className={`st ${tone}`} title={title}>
      {label}
    </span>
  );
}

/* ------------------------------ 详情头 ------------------------------ */

export interface DetailHeadProps {
  /** 单据名，如「内部交易单」。 */
  readonly docLabel: string;
  readonly orderNo: string;
  /** 状态徽标（一般传 `<DocPill …/>`）。 */
  readonly pill: ReactNode;
  /** 第二行：对接单位 / 经手人 / 时间等，一句话讲清这张单是谁的。 */
  readonly meta?: ReactNode;
  /** 右侧动作区（编辑 / 发货 / 确认…）。关闭按钮固定在最右，不用自己传。 */
  readonly actions?: ReactNode;
  readonly onClose: () => void;
  readonly closeLabel?: string;
}

export function DetailHead({
  docLabel,
  orderNo,
  pill,
  meta,
  actions,
  onClose,
  closeLabel = '关闭',
}: DetailHeadProps) {
  return (
    <header className="detail-head">
      <div className="detail-head-row">
        <h2 className="detail-title">
          {docLabel} <span className="no">{orderNo}</span>
        </h2>
        {pill}
        <div className="detail-tools">
          {actions}
          <button type="button" onClick={onClose} className="btn btn-ghost">
            {closeLabel}
          </button>
        </div>
      </div>
      {meta ? <p className="detail-meta">{meta}</p> : null}
    </header>
  );
}

/** 详情第二行里的分隔符（`·`），省得每页各写一个 `<span>|</span>`。 */
export function DetailMetaDot() {
  return <span className="detail-dot" aria-hidden="true">·</span>;
}

/* ------------------------------ 单据信息网格 ------------------------------ */

export interface DocMetaItem {
  readonly label: string;
  readonly value: ReactNode;
  /** 等宽（单号 / 数量 / 时间）。 */
  readonly mono?: boolean;
  /** `money` 用强调色（金额）；`dim` 是「还没发生 / 不适用」的弱化值。 */
  readonly tone?: 'money' | 'dim';
}

export interface DocMetaProps {
  readonly items: readonly DocMetaItem[];
  /** 一行放几列（视觉稿是 3 列；窄屏由 CSS 列宽压成 1 列）。 */
  readonly columns?: 2 | 3 | 4;
}

/**
 * 「单据信息」网格：`gap-px` + 底色描边模拟视觉稿的单元格分隔线
 * （v3.0 稿子 `.dl`：`background:var(--line)` + 每格自己的底色，
 * 比给每格加 border 少一半规则，圆角裁切也不会切出台阶）。
 *
 * 列数走 `data-cols` 而不是内联 `style={{gridTemplateColumns}}`：
 * 内联样式不参与媒体查询，窄屏时会硬撑成 4 列把格子挤成一条线。
 */
export function DocMeta({ items, columns = 3 }: DocMetaProps) {
  if (items.length === 0) return null;
  /**
   * 末尾补几个**空的**格子把最后一行填满。
   *
   * 为什么：网格的底色是 `--line-1`（用来当单元格分隔线），项目数不是列数整数倍时，
   * 最后一行右侧的空白区会把这块底色露出来 —— 看起来像「有两格数据没加载出来」。
   * 采购单 7 项 / 3 列时就是 2 个空洞（见 v0.13 采购单详情截图）。补同色空格最省事。
   */
  const filler = (columns - (items.length % columns)) % columns;
  return (
    <dl className="dl" data-cols={columns}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd
            className={[
              item.mono ? 'mono' : '',
              item.tone === 'money' ? 'money' : '',
              item.tone === 'dim' ? 'dim' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {item.value}
          </dd>
        </div>
      ))}
      {Array.from({ length: filler }, (_, index) => (
        <div key={`filler-${index}`} aria-hidden="true" />
      ))}
    </dl>
  );
}

/* ------------------------------ 明细表合计行 ------------------------------ */

export interface LinesFooterProps {
  /** 左侧说明覆盖的列数（一般 = 总列数 − 1，金额占最后一列）。 */
  readonly colSpan: number;
  readonly note: ReactNode;
  /** 金额合计；没有合计（无看价权限时为 `—`）也要显示，传 `null` 会整列不渲染。 */
  readonly sum?: ReactNode;
}

/** 明细表的 `tfoot`：左边一行小字（行数 / 数量合计），右边金额合计。 */
export function LinesFooter({ colSpan, note, sum }: LinesFooterProps) {
  return (
    <tfoot>
      <tr>
        <td colSpan={colSpan} className="ln-note">
          {note}
        </td>
        {sum === undefined ? null : <td className="ln-sum">{sum}</td>}
      </tr>
    </tfoot>
  );
}
