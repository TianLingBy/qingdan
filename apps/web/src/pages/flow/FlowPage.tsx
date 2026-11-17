/**
 * 业务全流程图（`/flow`，22 页 IA 第 19 页，D7 / D19 / D44）。
 *
 * 版式：主线横排（A 采购 → 入库 → B 加工 → 产出 → E 销售 → C 结算），
 * 下面接一排辅助单据（N 调货 / R 客户退货 / S 供应商退货 / I 盘点），
 * 最后用一张表把「已经能做什么、还缺什么」摊开——图负责看懂关系，表负责核对事实。
 *
 * 三个和「画个漂亮图」不同的取舍：
 * - **缺口画成虚线框**，不画成箭头。原料入库、产出结转这两步没有接口，
 *   画成实线会让人以为 A 单的货能直接给 B 单用；
 * - 节点能不能点是**接口权限**决定的，不是页面上写死「老板可点」；
 * - 图对全员开放（D44），但没权限的人点不开入口——这时给一条说明，而不是假装图坏了。
 */

import type { ScopeMatrix } from '@qingdan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment } from 'react';
import { allows, canAccessPage } from '../../lib/access';
import { isImplementedPage } from '../../router/implemented';
import { ROUTE_TABLE, type RouteEntry } from '../../router/routes';
import { authApi, authKeys } from '../auth/auth-api';
import {
  FLOW_DOCS,
  MAIN_FLOW,
  MAIN_LINKS,
  MATURITY_TEXT,
  SIDE_FLOW,
  maturityOf,
  type FlowDocStep,
  type FlowLink,
  type FlowTone,
} from './flow-map';

/* ------------------------------ 配色映射 ------------------------------ */

/**
 * 三组类名都写成完整字面量：Tailwind 只保留源码里出现过的类，
 * 用 `bg-${tone}-100` 这种拼串会在构建后丢样式。
 */
const TONE_CLASS: Record<
  FlowTone,
  { readonly bar: string; readonly badge: string; readonly code: string }
> = {
  sky: { bar: 'bg-sky-400', badge: 'bg-sky-50 text-sky-700', code: 'bg-sky-100 text-sky-800' },
  violet: {
    bar: 'bg-violet-400',
    badge: 'bg-violet-50 text-violet-700',
    code: 'bg-violet-100 text-violet-800',
  },
  emerald: {
    bar: 'bg-emerald-400',
    badge: 'bg-emerald-50 text-emerald-700',
    code: 'bg-emerald-100 text-emerald-800',
  },
  amber: {
    bar: 'bg-amber-400',
    badge: 'bg-amber-50 text-amber-800',
    code: 'bg-amber-100 text-amber-900',
  },
  indigo: {
    bar: 'bg-indigo-400',
    badge: 'bg-indigo-50 text-indigo-700',
    code: 'bg-indigo-100 text-indigo-800',
  },
  rose: { bar: 'bg-rose-400', badge: 'bg-rose-50 text-rose-700', code: 'bg-rose-100 text-rose-800' },
  orange: {
    bar: 'bg-orange-400',
    badge: 'bg-orange-50 text-orange-700',
    code: 'bg-orange-100 text-orange-800',
  },
  teal: { bar: 'bg-teal-400', badge: 'bg-teal-50 text-teal-700', code: 'bg-teal-100 text-teal-800' },
};

const MATURITY_CLASS = {
  ready: 'bg-emerald-50 text-emerald-700',
  partial: 'bg-amber-50 text-amber-800',
  blocked: 'bg-slate-100 text-slate-600',
} as const;

/* ------------------------------ 小组件 ------------------------------ */

function SkeletonCard() {
  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-3">
      <div className="animate-pulse rounded bg-slate-100 h-5 w-24" />
      <div className="animate-pulse mt-2 rounded bg-slate-100 h-3 w-full" />
      <div className="animate-pulse mt-1 rounded bg-slate-100 h-3 w-4/5" />
      <div className="animate-pulse mt-3 rounded bg-slate-100 h-3 w-2/3" />
    </div>
  );
}

export interface NodeCardProps {
  readonly node: FlowDocStep;
  /** 当前身份能否打开这张单（false 时卡片变灰且不可点）。 */
  readonly openable: boolean;
  readonly loading: boolean;
  readonly onOpen: (path: RouteEntry['path']) => void;
}

/** 一张单据卡：代号 + 名称 + 成熟度 + 做什么 + 对批次的影响 + 接口计数。 */
export function NodeCard({ node, openable, loading, onOpen }: NodeCardProps) {
  const tone = TONE_CLASS[node.tone];
  const maturity = maturityOf(node);
  const pageDone = isImplementedPage(node.routeId);

  const body = (
    <>
      <span className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} aria-hidden />
      <div className="flex items-start justify-between gap-2 pl-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${tone.code}`}
          >
            {node.code}
          </span>
          <span className="truncate text-sm font-medium text-slate-900">{node.name}</span>
        </div>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${MATURITY_CLASS[maturity]}`}
        >
          {MATURITY_TEXT[maturity]}
        </span>
      </div>

      <p className="mt-2 pl-1 text-xs leading-relaxed text-slate-600">{node.summary}</p>
      <p className="mt-1.5 pl-1 text-xs leading-relaxed text-slate-400">
        <span className="text-slate-500">批次 · </span>
        {node.stock}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2 pl-1 text-[11px] text-slate-400">
        <span className={`rounded px-1.5 py-0.5 ${tone.badge}`}>{node.done.length} 条接口已通</span>
        {node.gaps.length > 0 ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">
            缺 {node.gaps.length} 项
          </span>
        ) : null}
        {pageDone ? null : (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">页面待做</span>
        )}
        {openable ? null : (
          <span className="rounded bg-slate-200 px-1.5 py-0.5 font-medium text-slate-600">
            无权限
          </span>
        )}
      </div>
    </>
  );

  const shell = 'relative flex h-full flex-col overflow-hidden rounded-xl border py-3 pr-3';

  if (loading) {
    return <SkeletonCard />;
  }

  if (!openable) {
    return (
      <div className={`${shell} border-dashed border-slate-300 bg-slate-50`} aria-disabled>
        {body}
      </div>
    );
  }

  return (
    <a
      href={pathOf(node)}
      onClick={(event) => {
        event.preventDefault();
        // 统一按路由表取路径，避免在数据里再写一份 path 与 routes.ts 漂移。
        onOpen(pathOf(node));
      }}
      className={`${shell} border-slate-200 bg-white transition hover:border-slate-300 hover:bg-slate-50`}
    >
      {body}
    </a>
  );
}

/**
 * 两张单据之间的连接带。
 *
 * 通的一步画实线箭头；断的一步画琥珀色虚线，并在下面写「未接 · 原料入库」——
 * 这样图上能看出「这里该有一步，但还没有」，又不会让人误以为它是一个可打开的单据。
 */
function LinkBand({ link }: { readonly link: FlowLink }) {
  const broken = link.gap !== undefined;
  return (
    <div
      className="flex shrink-0 items-center justify-center gap-1 px-2 py-1 lg:w-28 lg:flex-col lg:gap-1 lg:px-1 lg:py-0"
      title={link.gap?.detail}
    >
      <span
        aria-hidden
        className={`text-sm leading-none ${broken ? 'text-amber-500' : 'text-slate-300'}`}
      >
        <span className="lg:hidden">↓</span>
        <span className="hidden lg:inline">{broken ? '┄┄┄' : '→'}</span>
      </span>
      <span
        className={`text-center text-[10px] leading-tight ${
          broken ? 'font-medium text-amber-700' : 'text-slate-400'
        }`}
      >
        {broken ? `未接 · ${link.gap?.label}` : link.label}
      </span>
    </div>
  );
}

/* ------------------------------ 路径查询 ------------------------------ */

/**
 * `RouteEntry['path']` 与 routeId 的对应关系取自路由表本身。
 * 放成模块级常量只算一次；`routes.ts` 是纯数据，不会引入循环依赖。
 */
const PATH_BY_ID = new Map<string, RouteEntry['path']>(
  ROUTE_TABLE.map((entry) => [entry.id, entry.path]),
);

export function pathOf(node: FlowDocStep): RouteEntry['path'] {
  const path = PATH_BY_ID.get(node.routeId);
  if (!path) {
    // 编译期已由 `routeId: RouteEntry['id']` 收窄，这里只是运行时的兜底。
    throw new Error(`流程图节点 ${node.id} 指向了不存在的路由 ${node.routeId}`);
  }
  return path;
}

/** 断开的连接带（补上接口后，删掉对应 link 的 gap 就会自动从这里消失）。 */
const NAME_BY_ID = new Map(FLOW_DOCS.map((node) => [node.id, node.name]));

const BROKEN_LINKS = MAIN_LINKS.filter((link) => link.gap !== undefined).map((link) => ({
  link,
  fromName: NAME_BY_ID.get(link.from) ?? link.from,
  toName: NAME_BY_ID.get(link.to) ?? link.to,
}));

/* ------------------------------ 视图 ------------------------------ */

export interface FlowViewProps {
  readonly scope: ScopeMatrix | undefined;
  readonly loading: boolean;
  /** 身份读取失败时的提示；非空表示「能不能点」暂时判不了。 */
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onOpen: (path: RouteEntry['path']) => void;
}

function canOpenNode(scope: ScopeMatrix | undefined, node: FlowDocStep): boolean {
  if (!canAccessPage(scope, node.routeId)) return false;
  return node.domains.some((domain) => allows(scope, domain, 'read'));
}

export function FlowView({ scope, loading, error, onRetry, onOpen }: FlowViewProps) {
  // 身份没读到时不能断言「你没权限」，所以放行；真跳过去页面自己会 401 回登录。
  const judge = !loading && error === null;
  const openable = (node: FlowDocStep) => (judge ? canOpenNode(scope, node) : true);
  const noneOpenable = judge && FLOW_DOCS.every((node) => !canOpenNode(scope, node));

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <header className="rounded-xl border border-slate-200 bg-white px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">业务全流程图</h1>
            <p className="mt-1 text-sm text-slate-500">
              采购 A → 加工 B → 销售 E → 结算 C；辅助是内部交易 N、冲正 R / S / I。
            </p>
          </div>
          <p className="max-w-sm text-xs leading-relaxed text-slate-400">
            本期只做业务全流程图（D7），实时看板与集团看板二期。图对全部登录员工开放（D44），
            节点能不能点取决于你的岗位权限。
          </p>
        </div>
      </header>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
          <p className="text-sm text-rose-800">
            身份读取失败：{error}。下面的入口暂时无法判断可用性，点进去会被接口拦下。
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-rose-300 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
          >
            重试
          </button>
        </div>
      ) : null}

      {noneOpenable ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          当前身份没有任何单据权限，图仍然可以看（D44），但下面的入口都点不开。要录单请联系管理员调整岗位权限。
        </p>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">主线：一张货的流向</h2>
          <span className="text-xs text-slate-400">
            四张单据卡都能点进对应页面；卡与卡之间的「未接」是还没有人做的一步，不是单据
          </span>
        </div>

        <div className="mt-3 flex flex-col lg:flex-row lg:items-stretch">
          {MAIN_FLOW.map((step, index) => (
            <Fragment key={step.id}>
              <div className="min-w-0 flex-1">
                <NodeCard node={step} openable={openable(step)} loading={loading} onOpen={onOpen} />
              </div>
              {index === MAIN_FLOW.length - 1 ? null : (
                <LinkBand link={MAIN_LINKS[index] as FlowLink} />
              )}
            </Fragment>
          ))}
        </div>

        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          批次是这条链上唯一的数量载体：可用量 = 入库量 − 在途占用 − 待执行占用（D41）。
          目前只有 E 单完成与 I 盘审批会真正改数量，两者走同一个库存写入服务（D67 / D70）。
        </p>
      </section>

      <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-amber-900">链路断点（{BROKEN_LINKS.length} 处）</h2>
          <span className="text-xs text-amber-700/80">断点不是单据，所以没有入口，也不能点</span>
        </div>
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {BROKEN_LINKS.map(({ link, fromName, toName }) => (
            <li
              key={`${link.from}-${link.to}`}
              className="rounded-lg border border-dashed border-amber-300 bg-white/70 p-3"
            >
              <p className="text-xs font-medium text-amber-900">
                {fromName} → {toName}：{link.gap?.label}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-amber-800/80">{link.gap?.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">辅助与冲正</h2>
          <span className="text-xs text-slate-400">
            不接在主链上：N 走跨公司调货，R / S 只退钱，I 直接调批次数量
          </span>
        </div>
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SIDE_FLOW.map((node) => (
            <li key={node.id} className="min-w-0">
              <NodeCard node={node} openable={openable(node)} loading={loading} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      </section>

      <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">落地情况</h2>
          <span className="text-xs text-slate-400">图的可读版：每条链路缺什么，以这张表为准</span>
        </div>

        <div className="mt-3 -mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="text-xs text-slate-400">
                <th className="py-1.5 pr-3 font-medium">单据</th>
                <th className="py-1.5 pr-3 font-medium">已经能做什么</th>
                <th className="py-1.5 pr-3 font-medium">还缺什么</th>
                <th className="py-1.5 font-medium">页面</th>
              </tr>
            </thead>
            <tbody>
              {FLOW_DOCS.map((node) => (
                <tr key={node.id} className="border-t border-slate-100 align-top">
                  <td className="whitespace-nowrap py-2 pr-3">
                    <span className="font-medium text-slate-800">
                      {node.code} {node.name}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs leading-relaxed text-slate-600">
                    {node.summary}
                    {node.limits?.length ? (
                      <span className="mt-1 block text-slate-400">
                        有意不做：{node.limits.join('；')}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-xs leading-relaxed">
                    {node.gaps.length === 0 ? (
                      <span className="text-emerald-700">无</span>
                    ) : (
                      <ul className="space-y-0.5 text-amber-800">
                        {node.gaps.map((gap) => (
                          <li key={gap}>· {gap}</li>
                        ))}
                      </ul>
                    )}
                    {node.note ? (
                      <span className="mt-1 block text-slate-400">{node.note}</span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap py-2 text-xs">
                    {isImplementedPage(node.routeId) ? (
                      <span className="text-slate-500">已上线</span>
                    ) : (
                      <span className="text-slate-400">占位页</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">怎么看这张图</h2>
        <ul className="mt-2 space-y-1 text-xs leading-relaxed text-slate-500">
          <li>· 箭头只表示单据的业务先后，不代表系统会自动跑批；每一步都要有人开单或确认。</li>
          <li>· 「已通」= 这张单的核心动作接口都在；「缺动作」= 单能开，但有关键动作还返回 501。</li>
          <li>· 灰色卡片是你没有权限进入的单据；图本身不拦人，接口会拦（D15 / D27）。</li>
          <li>· 金额一律以接口返回为准；图上不写示例数字，避免和真实账目混淆。</li>
        </ul>
      </section>
    </section>
  );
}

/* ------------------------------ 页面 ------------------------------ */

export function FlowPage() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me(), retry: false });

  return (
    <FlowView
      scope={me.data?.scope}
      loading={me.isPending}
      error={me.isError ? (me.error instanceof Error ? me.error.message : '未知错误') : null}
      onRetry={() => void me.refetch()}
      onOpen={(path) => void navigate({ to: path })}
    />
  );
}
