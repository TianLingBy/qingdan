import { BROWSER_BASELINE_LABEL } from '../browser-baseline';
import type { RouteEntry } from '../router/routes';

export interface PlaceholderPageProps {
  readonly entry: RouteEntry;
}

/** 22 页统一占位页：标题 + 待实现 + 所属功能域。不写业务逻辑。 */
export function PlaceholderPage({ entry }: PlaceholderPageProps) {
  return (
    <section className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{entry.page}</h1>
        <span className="rounded-full border border-slate-300 bg-white/60 px-2.5 py-0.5 text-xs font-medium tracking-wide text-slate-600">
          待实现
        </span>
      </div>

      <dl className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <dt className="text-xs text-slate-400">所属功能域</dt>
          <dd className="mt-1 text-sm font-medium">{entry.domain}</dd>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <dt className="text-xs text-slate-400">路由</dt>
          <dd className="mt-1 font-mono text-sm">{entry.path}</dd>
        </div>
      </dl>

      <p className="mt-6 text-sm text-slate-500">
        页面骨架已就位，业务逻辑、字段校验与权限判定待对应模块实现（权限与数据隔离一律服务端判定，
        前端隐藏不算数）。业务能力直接对接 <code className="font-mono text-slate-700">/api/v1</code>。
      </p>
      <p className="mt-2 text-xs text-slate-400">{BROWSER_BASELINE_LABEL}</p>
    </section>
  );
}
