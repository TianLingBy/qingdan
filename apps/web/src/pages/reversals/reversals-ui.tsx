/**
 * 冲正页的展示小组件。
 *
 * 三个分栏（R / S / I）的版式是一致的：筛选条 → 列表 → 详情 / 开单。
 * 抽出来的只有「长得一样、没有业务判断」的部分；带状态的都留在各分栏里，
 * 免得一个组件既管渲染又管三种单据的规则。
 *
 * 列表四态（#300 起）统一到 `components/ListStates`；这里保留老名字做转出，
 * 三个分栏不用改 import，样式与其它列表页一致。
 */

import type { ReactNode } from 'react';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import type { ListState } from '../../lib/list-state';

export {
  ListEmpty as EmptyState,
  ListLoading as TableSkeleton,
} from '../../components/ListStates';

/** 输入控件统一样式（只在这里改，三个分栏一起变）。 */
/* `.ipt` 是 v3.0 底座里的输入控件（`app-v30.css` §8.5），与 `.fm input` 同一套值；
   单独挂它也成立，所以不进 `.fm` 的字段（备注 / 取消原因）不用另写一份。 */
export const FIELD_CLASS = 'ipt';

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** 单个字段：标签 / 控件 / 一行提示。分列交给外层的 `.fm`，这里只管竖排与文字档。 */
export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <label className={className ? `fm-field ${className}` : 'fm-field'}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/* ------------------------------ 列表卡片（v3.0） ------------------------------ */

export interface ReversalListCardProps {
  readonly state: ListState;
  /** 表头列数，三行状态行的 `colSpan` 必须等于它，否则表格会塌列。 */
  readonly colCount: number;
  /** `<tr>` 形式的表头单元格。 */
  readonly head: ReactNode;
  /** 最小宽度（Tailwind 字面量类，如 `min-w-[680px]`）；列多时靠 `.tw` 横向滚动。 */
  readonly minWidthClass?: string;
  /** 数据行（每条自带 `r-row`）。 */
  readonly children: ReactNode;
  readonly emptyText: string;
  readonly emptyHint?: ReactNode;
  readonly errorTitle: string;
  readonly error?: unknown;
  readonly onRetry: () => void;
  /** 页脚左侧汇总：只写「共 N 条」，能合并合计时才追加（见下方注释）。 */
  readonly summary: ReactNode;
  /** 页脚右侧翻页器：冲正三栏都是游标契约，传 `BatchPager`。 */
  readonly pager?: ReactNode;
}

/**
 * 冲正页三栏共用的列表卡片（v3.0 `card.list-card` + `.tw` + `.tf`）。
 *
 * 三件必须做对的事：
 * 1. 四态**不写条件渲染**：容器与 `tbody` 挂同一个 `data-state`，数据行与三个状态行
 *    常驻 DOM，由 `app-v013.css` 的 `[data-state]` / `tbody > tr.st-tr` 规则决定谁可见。
 *    这样切换状态时表头宽度与列宽都不跳。
 * 2. 表格外层是 `.tw`（不是 `overflow-x-auto`）：列宽超屏时由它横向滚动，
 *    与其它五页单据列表同一条滚动轨道（#455/#458）。
 * 3. 页脚是 `.tf`：左边汇总、右边翻页器。`app-v30.css` 的
 *    `.list-card:not([data-state="filled"]) .tf .pager{display:none}` 会在
 *    空 / 加载 / 出错态自动收起分页，不用在 JSX 里判断。
 *
 * 为什么页脚**不写合计**：冲正三栏走游标分页（`PageQuerySchema`，服务端只回
 * `nextCursor`），拿不到全量条数，更拿不到全量金额。按本批行数求和标成「合计」
 * 是假数据——翻到第二批就变了。等后端把 D95 的 `page/pageSize` + 汇总铺到这三个
 * 模块，再按 #455 的口径（`total !== null && rows.length >= total`）补。
 */
export function ReversalListCard({
  state,
  colCount,
  head,
  minWidthClass,
  children,
  emptyText,
  emptyHint,
  errorTitle,
  error,
  onRetry,
  summary,
  pager,
}: ReversalListCardProps) {
  return (
    <div className="card list-card" data-state={state}>
      <div className="tw">
        {/* 表宽与左对齐按其余五页列表的同一条口径写（`w-full … text-left`）：
            `app-v013.css` 的 `th` 只给了字色字重，对齐仍是 UA 默认的居中，所以 `text-left` 不能省。
            列多时靠 `.tw` 横向滚动，最小宽度用 Tailwind 字面量类 —— 三栏列数不同，值分别是 680/620/720。 */}
        <table className={`w-full text-left ${minWidthClass ?? ''}`}>
          <thead>{head}</thead>
          <tbody data-state={state}>
            {children}
            <tr className="st-tr st-loading">
              <td colSpan={colCount}>
                <ListLoading label="正在加载…" />
              </td>
            </tr>
            <tr className="st-tr st-error">
              <td colSpan={colCount}>
                <ListError title={errorTitle} error={error} onRetry={onRetry} />
              </td>
            </tr>
            <tr className="st-tr st-empty">
              <td colSpan={colCount}>
                <ListEmpty title={emptyText} hint={emptyHint} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="tf">
        <span>{summary}</span>
        {pager}
      </div>
    </div>
  );
}

/** 分栏内的口径说明条：一句话讲清这张单「是什么 / 不是什么」。 */
export function BasisNote({ children }: { readonly children: ReactNode }) {
  // 说明条不是告警，用 `.alert-info`（中性底）；`alert-sm` 收到 12px，一栏顶部不抢眼睛。
  return <p className="alert alert-info alert-sm">{children}</p>;
}

export function ErrorBar({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="alert alert-bad alert-sm">
      <div className="alert-row">
        <span>{message}</span>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="btn btn-row">
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 校验错误列表：一次列全，不让用户改一个提交一次。 */
export function ErrorList({ errors }: { readonly errors: readonly string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="alert alert-warn alert-sm">
      <ul>
        {errors.map((error) => (
          <li key={error}>· {error}</li>
        ))}
      </ul>
    </div>
  );
}

/** 详情里的「键 → 值」不再单列组件：三栏都走 `OrderDetailUI` 的 `DocMeta`，
 *  `Kv` 一直没有调用点，随本轮换皮删掉（留着只是一个没人用的 Tailwind 残留）。 */
