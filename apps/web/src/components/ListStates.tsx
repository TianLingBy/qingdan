import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

/**
 * 列表页统一的空态 / 加载态 / 错误态（#300 验收第 4 条）。
 *
 * 以前每个页面各写一套骨架条、空提示和红字，文案与留白都不一致；这里收成三个组件：
 * - `ListLoading`：骨架 + 一句「xx加载中…」，带 `aria-label="列表加载中"`，屏幕阅读器可读；
 * - `ListEmpty`：确定「查完了但没有数据」时才用（加载中不许出空态，避免给出错误结论）；
 * - `ListError`：显示错误文案 + **错误码** + 可选提示与「重试」，不吞错。
 *
 * 约定：错误态优先传原始 `error`（`ApiError` 会带出 `code`），页面不要自己拼红字；
 * 这样不同页面报同一个后端错误时，用户看到的码与文案一致。
 */

export interface ListLoadingProps {
  readonly label?: string;
  readonly rows?: number;
}

/** 列表加载态：3 条骨架（数量可按表格密度调整）。 */
export function ListLoading({ label = '加载中…', rows = 3 }: ListLoadingProps) {
  return (
    <div className="space-y-2 p-5" aria-busy="true" aria-label="列表加载中" role="status">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-9 animate-pulse rounded bg-slate-100" />
      ))}
      <p className="text-xs text-slate-400">{label}</p>
    </div>
  );
}

export interface ListEmptyProps {
  /** 主提示（沿用各页既有文案，便于用户和测试都按老文案找）。 */
  readonly title: string;
  /** 可选的下一步说明。 */
  readonly hint?: ReactNode;
}

/** 列表空态：明确「没有数据」并给出下一步，不用一句「暂无」打发。 */
export function ListEmpty({ title, hint }: ListEmptyProps) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center">
      <p className="text-sm text-slate-600">{title}</p>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-slate-400">{hint}</p> : null}
    </div>
  );
}

export interface ListErrorProps {
  /** 前缀，如「库存流水加载失败」；与后端文案拼接成完整提示。 */
  readonly title: string;
  readonly error?: unknown;
  /** 页面已有更细的错误翻译时传它；此时错误码单独一行展示，保证不丢码。 */
  readonly message?: ReactNode;
  /** 补充说明，例如缺哪个权限点、下一步怎么办。 */
  readonly hint?: ReactNode;
  readonly onRetry?: () => void;
}

/** 把任意错误翻成「标题 + 后端文案 + 错误码」；非 ApiError 也不吞成空白。 */
export function describeListError(title: string, error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.message.length > 0 ? error.message : '请求失败';
    return `${title}：${detail}（${error.code}）`;
  }
  if (error instanceof Error && error.message.length > 0) {
    return `${title}：${error.message}`;
  }
  return `${title}：未知错误`;
}

/** 列表错误态：错误码必出 + 重试按钮；不把失败伪装成空数据。 */
export function ListError({ title, error, message, hint, onRetry }: ListErrorProps) {
  return (
    <div className="p-6 text-center" role="alert">
      <p className="text-sm text-rose-600">
        {message ?? describeListError(title, error)}
      </p>
      {message && error instanceof ApiError ? (
        <p className="mt-1 font-mono text-[11px] text-rose-500">错误码 {error.code}</p>
      ) : null}
      {error instanceof ApiError && error.requestId ? (
        <p className="mt-1 text-[11px] text-slate-400">请求号 {error.requestId}</p>
      ) : null}
      {hint ? <p className="mt-1 text-xs leading-relaxed text-slate-400">{hint}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}
