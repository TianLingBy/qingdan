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
export const FIELD_CLASS =
  'mt-1 w-full rounded-lg border border-[var(--line-2)] bg-[var(--surf-1)] px-3 py-2 text-sm text-[var(--text-1)] disabled:bg-[var(--surf-2)]';

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <label className={`block text-sm ${className ?? ''}`}>
      <span className="text-[var(--text-2)]">{label}</span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-3)]">
          {hint}
        </span>
      ) : null}
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
  return (
    <p className="rounded-lg bg-[var(--surf-2)] px-3 py-2 text-xs leading-relaxed text-[var(--text-3)]">
      {children}
    </p>
  );
}

export function ErrorBar({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
      <p className="text-xs text-rose-800">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-rose-300 bg-white px-2 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}

/** 校验错误列表：一次列全，不让用户改一个提交一次。 */
export function ErrorList({ errors }: { readonly errors: readonly string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      {errors.map((error) => (
        <li key={error}>· {error}</li>
      ))}
    </ul>
  );
}

/** 详情里的一行「键 → 值」。 */
export function Kv({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-700">{children}</dd>
    </div>
  );
}
