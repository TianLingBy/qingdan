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
