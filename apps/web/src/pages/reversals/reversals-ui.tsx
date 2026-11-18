/**
 * 冲正页的展示小组件。
 *
 * 三个分栏（R / S / I）的版式是一致的：筛选条 → 列表 → 详情 / 开单。
 * 抽出来的只有「长得一样、没有业务判断」的部分；带状态的都留在各分栏里，
 * 免得一个组件既管渲染又管三种单据的规则。
 *
 * 列表三态（#300）已统一到 `components/ListStates`；这里保留老名字做转出，
 * 三个分栏不用改 import，样式与其它列表页一致。
 */

import type { ReactNode } from 'react';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import type { ListState } from '../../lib/list-state';

export { ListEmpty as EmptyState, ListLoading as TableSkeleton } from '../../components/ListStates';

/** 输入控件统一样式（只在这里改，三个分栏一起变）。 */
export const FIELD_CLASS =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100';

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <label className={`block text-sm ${className ?? ''}`}>
      <span className="text-slate-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">{hint}</span> : null}
    </label>
  );
}

export function StatusPill({
  status,
  className,
}: {
  readonly status: string;
  readonly className: string;
}) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {status}
    </span>
  );
}

/* ------------------------------ 列表卡片（v0.13） ------------------------------ */

export interface ReversalPagerProps {
  /** 当前是第几批（从 0 起）。 */
  readonly batchIndex: number;
  /** 本批条数。 */
  readonly count: number;
  readonly hasNext: boolean;
  readonly onPrev: () => void;
  readonly onNext: () => void;
}

/**
 * 游标分页条 —— **不是页码条**。
 *
 * 三个 ListQuery 都是 `PageQuerySchema`（cursor / limit），服务端只回 `nextCursor`，
 * 既没有 total 也没有 pageCount。所以这里只能写「共 N 条 · 第 M 批」+ 上一批 / 下一批；
 * 画成「1 2 3 … 9」就得靠猜总页数，翻到空页时用户会以为系统坏了。
 */
export function ReversalPager({
  batchIndex,
  count,
  hasNext,
  onPrev,
  onNext,
}: ReversalPagerProps) {
  return (
    <div className="pager">
      <span className="count">
        共 {count} 条 · 第 {batchIndex + 1} 批
      </span>
      <div className="nav">
        <button
          type="button"
          className="btn btn-s"
          disabled={batchIndex === 0}
          onClick={onPrev}
        >
          上一批
        </button>
        <button type="button" className="btn btn-s" disabled={!hasNext} onClick={onNext}>
          下一批
        </button>
      </div>
    </div>
  );
}

export interface ReversalListCardProps {
  readonly title: string;
  /** 标题右侧小字（条数 / 看价权限提示）。 */
  readonly meta?: ReactNode;
  readonly state: ListState;
  /** 表头列数，三行状态行的 `colSpan` 必须等于它，否则表格会塌列。 */
  readonly colCount: number;
  /** `<tr>` 形式的表头单元格。 */
  readonly head: ReactNode;
  readonly minWidth?: string;
  /** 数据行（每条自带 `r-row`）。 */
  readonly children: ReactNode;
  readonly emptyText: string;
  readonly emptyHint?: ReactNode;
  readonly errorTitle: string;
  readonly error?: unknown;
  readonly onRetry: () => void;
  readonly pager?: ReactNode;
}

/**
 * 冲正页三栏共用的列表卡片。
 *
 * 四态**不写条件渲染**：容器与 `tbody` 挂同一个 `data-state`，数据行与三个状态行
 * 常驻 DOM，由 `app-v013.css` 的 `[data-state]` / `tbody > tr.st-tr` 规则决定谁可见
 * （见 `styles/README.md`）。这样切换状态时表头宽度与列宽都不跳。
 */
export function ReversalListCard({
  title,
  meta,
  state,
  colCount,
  head,
  minWidth,
  children,
  emptyText,
  emptyHint,
  errorTitle,
  error,
  onRetry,
  pager,
}: ReversalListCardProps) {
  return (
    <section className="card min-w-0" data-state={state}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
          {title}
        </h3>
        {meta ? (
          <span className="text-xs" style={{ color: 'var(--text-3)' }}>
            {meta}
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left" style={minWidth ? { minWidth } : undefined}>
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
      {pager}
    </section>
  );
}

/** 分栏内的口径说明条：一句话讲清这张单「是什么 / 不是什么」。 */
export function BasisNote({ children }: { readonly children: ReactNode }) {
  return (
    <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
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
export function Kv({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-700">{children}</dd>
    </div>
  );
}
