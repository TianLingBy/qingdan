import type { ReactNode } from 'react';
import { ApiError } from '../../api/client';
import type { MeResult } from '../../api/platform';

export function allows(
  me: MeResult | undefined,
  domain: string,
  action: string,
): boolean {
  return me?.scope.some((entry) => entry.domain === domain && entry.actions.includes(action)) ?? false;
}

export function errorText(error: unknown, fallback = '操作失败'): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return `${fallback}：没有足够权限（${error.code}）`;
    if (error.status === 409) return `${fallback}：数据已被更新，请刷新后重试`;
    return `${fallback}：${error.message}（${error.code}）`;
  }
  return error instanceof Error ? `${fallback}：${error.message}` : fallback;
}

export function formatQuantity(value: string): string {
  return value;
}

export function formatDateTime(value: string): string {
  return value.slice(0, 19).replace('T', ' ');
}

export function shortId(value: string): string {
  return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function PageShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-7xl space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
            真实接口
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      </header>
      {children}
    </section>
  );
}

export function Pagination({
  pageIndex,
  nextCursor,
  onPrevious,
  onNext,
}: {
  pageIndex: number;
  nextCursor: string | null;
  onPrevious: () => void;
  onNext: (cursor: string) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        disabled={pageIndex === 0}
        onClick={onPrevious}
        className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-40"
      >
        上一页
      </button>
      <span className="text-sm text-slate-500">第 {pageIndex + 1} 页</span>
      <button
        type="button"
        disabled={!nextCursor}
        onClick={() => {
          if (nextCursor) onNext(nextCursor);
        }}
        className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-40"
      >
        下一页
      </button>
    </div>
  );
}
