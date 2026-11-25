import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ACTIONS, DOCUMENT_TYPES, DOMAINS, type SettingsOverview } from '@qingdan/contracts';
import { ApiError } from '../../api/client';
import { MeteorBackdrop } from '../../components/MeteorBackdrop';
import { SessionsBlock } from './SessionsBlock';
import { settingsApi } from './settings-api';

/**
 * 设置中心 `/settings`（第 23 页，#343 / D93）。
 *
 * 设计意图（`docs/design-settings-center.md`）：
 * - 单页滚动六个区块，不做 tab —— 正文只有一个聚合端点，一次拿全，分 tab 反而要多管一套状态；
 * - 五块正文**全部只读**（改资料、换号、改单号规则、勾权限，后端都还没有端点，画了就是假功能）；
 * - 第六块「我的登录设备」是**唯一可操作**的：后端有 `platform.settings.sessions` 与
 *   `.revoke_session`（`apps/api/src/modules/platform/usecases/settings-sessions.ts`），
 *   自己管四态（见 `SessionsBlock.tsx`）—— 它拉失败不该把整页五块正文一起打掉；
 * - 「我」的一切只作用于本人：路径写死不带任何员工 id，服务端从会话取身份。
 *
 * 四态用 v0.13 的 CSS 驱动写法（`data-state` + `st-block`），不写 `{!data && <Skeleton/>}`。
 * 理由见 `apps/web/src/styles/README.md:50-116`：条件渲染会让状态块频繁挂载卸载，
 * 且绕开设计稿给状态块的背景与间距。
 *
 * **不存在 empty 态**：请求成功时 `tenant` 与 `me` 一定有值（后端没有就抛
 * `UNAUTHENTICATED`）。所以这里没有「暂无数据」分支 —— 写了就是永远走不到的死代码。
 */

/** 403 是一个正常的业务分支，不是异常：后端用 403 表达「没有 company.read」。 */
function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/**
 * 当前是否暗色（`html[data-mode]`）。流星雨与星星按钮只在暗色出现，
 * 所以主题一换就要跟着变 —— 监听属性变化，而不是只在挂载时读一次。
 */
export function useIsDarkMode(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.mode === 'dark',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const sync = () => setDark(root.dataset.mode === 'dark');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-mode', 'data-theme'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => sync();
    media?.addEventListener?.('change', onChange);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', onChange);
    };
  }, []);
  return dark;
}

export function SettingsPage() {
  const query = useQuery({
    queryKey: ['settings', 'overview'],
    queryFn: settingsApi.overview,
    // 设置中心没有时效性，来回切页不必反复拉
    staleTime: 60_000,
  });

  const state = query.isPending ? 'loading' : query.isError ? 'error' : 'filled';
  const isDark = useIsDarkMode();
  const [skyOnly, setSkyOnly] = useState(false);
  const [firing, setFiring] = useState(false);
  const [burst, setBurst] = useState(0);

  // 切到亮色时自动退出「只看星空」（亮色不出现流星雨与按钮）
  useEffect(() => {
    if (!isDark) setSkyOnly(false);
  }, [isDark]);

  const toggleSky = () => {
    setSkyOnly((current) => {
      if (current) return false;
      setBurst((n) => n + 1);
      setFiring(true);
      window.setTimeout(() => setFiring(false), 700);
      return true;
    });
  };

  return (
    <>
      {/* 背景装饰层：不是卡片，fixed 铺满视口；只在暗色下挂载 */}
      {isDark && <MeteorBackdrop burst={burst} />}
      {isDark && (
        <>
          <button
            type="button"
            className={`sky-btn${skyOnly ? ' on' : ''}${firing ? ' is-firing' : ''}`}
            aria-pressed={skyOnly}
            aria-label="只看星空"
            title="只看星空"
            onClick={toggleSky}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3.4l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z" />
            </svg>
          </button>
          <div className="sky-hint" aria-hidden="true">
            只看星空 · 点击星星回到设置中心
          </div>
        </>
      )}
      <div className={`settings-sky${skyOnly ? ' is-sky' : ''}`}>
        <section className="mx-auto max-w-4xl">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">设置中心</h1>
            {query.data && (
              <span className="text-sm text-slate-500">{query.data.companies[0]?.name ?? '—'}</span>
            )}
          </div>

      <div data-state={state} className="mt-5 flex flex-col gap-5">
        <div className="st-block st-filled">
          {query.data && <OverviewBlocks overview={query.data} />}
        </div>

        <div className="st-block st-loading">
          <SkeletonBlocks />
        </div>

        <div className="st-block st-error">
          <SettingsErrorBlock error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </div>
        </div>
        </section>
      </div>
    </>
  );
}

/**
 * 错误态。**403 与其它错误必须分开**：
 *
 * - 403 是「你不被允许看」，说清缺哪个权限点，**绝不能说成「你还没有加入公司」** ——
 *   那会让人以为数据丢了，去翻半天；
 * - 其它错误（500 / 网络）给重试，**不能说成权限问题** —— 否则用户会去找管理员
 *   要一个他本来就有的权限，白跑一趟。
 *
 * 单独抽成组件是为了能直接测：SSR 渲染 `SettingsPage` 时 TanStack Query 会在
 * 渲染期触发一次 fetch，预置的 error 态会被打回 pending，测不到这两个分支。
 */
export function SettingsErrorBlock({
  error,
  onRetry,
  retrying = false,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
}) {
  if (isForbidden(error)) {
    return (
      <section className="panel">
        <p className="text-sm font-medium">你没有查看公司资料的权限</p>
        <p className="mt-1.5 text-xs text-slate-500">
          设置中心要 <code>company.read</code> 才能打开。联系管理员给你授予这个权限 ——
          这是「你不被允许看这份资料」，不是「公司数据丢了」。
        </p>
      </section>
    );
  }
  return (
    <section className="panel">
      <p className="text-sm font-medium">设置中心加载失败</p>
      <p className="mt-1.5 text-xs text-slate-500">
        {error instanceof Error ? error.message : '未知错误'}
      </p>
      {onRetry && (
        <button type="button" className="btn btn-s mt-3" onClick={onRetry} disabled={retrying}>
          {retrying ? '重试中…' : '重试'}
        </button>
      )}
    </section>
  );
}

/**
 * 六个区块。拆出来只是为了让 `SettingsPage` 的四态骨架看得清。
 *
 * 第六块 `SessionsBlock` 挂在 `data-state="filled"` 里 —— 只有概览拿到才渲染它。
 * 概览 403（连 `company.read` 都没有）时展示设备列表没有意义：那种身份连自己
 * 属于哪家公司都看不到，给他一个「踢设备」入口反而更容易误操作。
 * 它自己内部还有一层四态，所以概览正常、会话接口挂了时，只有这一块显示错误。
 */
function OverviewBlocks({ overview }: { readonly overview: SettingsOverview }) {
  return (
    <>
      <MyProfileBlock overview={overview} />
      <MyCompaniesBlock overview={overview} />
      <NumberingBlock overview={overview} />
      <PermissionsBlock overview={overview} />
      <TenantBlock overview={overview} />
      <SessionsBlock />
    </>
  );
}

function MyProfileBlock({ overview }: { readonly overview: SettingsOverview }) {
  const { me } = overview;
  return (
    <section className="panel">
      <h2 className="panel-h">我的资料</h2>
      <dl className="mt-3 grid grid-cols-[88px_1fr] gap-y-2 text-sm">
        <dt className="text-slate-500">姓名</dt>
        <dd>{me.name}</dd>

        <dt className="text-slate-500">手机号</dt>
        <dd className="flex items-center gap-2">
          <span className="font-mono">{me.phoneMasked}</span>
          <button
            type="button"
            className="btn btn-s"
            disabled
            title="后端还没有换号端点（#298 第 2 块）"
          >
            换号
          </button>
        </dd>

        <dt className="text-slate-500">岗位</dt>
        <dd className="flex flex-wrap gap-1.5">
          {me.positions.length === 0 ? (
            // 岗位可以是空的（老员工没挂岗位），这里说清「不是没加载出来」
            <span className="text-xs text-slate-400">未分配岗位，权限按个人覆盖计算</span>
          ) : (
            me.positions.map((p) => (
              <span key={p.id} className="badge">
                {p.name} · {p.companyName}
              </span>
            ))
          )}
        </dd>
      </dl>
    </section>
  );
}

function MyCompaniesBlock({ overview }: { readonly overview: SettingsOverview }) {
  const { companies } = overview;
  return (
    <section className="panel">
      <h2 className="panel-h">我的公司</h2>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {companies.map((company, index) => (
          // 当前公司取第一个：后端按「登录时选的那家」排在首位。这里只做展示，
          // 切换器在顶栏（#300 已做）—— 两处都能切会让人以为有两个开关。
          <div
            key={company.id}
            className={`relative rounded-xl border p-3 ${
              index === 0 ? 'border-slate-800' : 'border-slate-200'
            }`}
          >
            {index === 0 && (
              <span className="absolute right-2 top-2 rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-white">
                当前
              </span>
            )}
            <p className="font-mono text-xs text-slate-400">{company.code}</p>
            <p className="mt-1 text-sm font-medium">{company.name}</p>
            {/* 公司没有启停状态：CompanySchema 只有 id/tenantId/code/name/地址四项/version。
                「状态」是租户级字段（tenant.status），画在公司卡上会让人以为公司能单独停用。 */}
            {company.address && <p className="mt-1 text-xs text-slate-500">{company.address}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function NumberingBlock({ overview }: { readonly overview: SettingsOverview }) {
  return (
    <section className="panel">
      <h2 className="panel-h">单号规则</h2>
      <table className="table mt-3">
        <thead>
          <tr>
            <th>单据类型</th>
            <th>规则</th>
            <th className="num">下一个号</th>
          </tr>
        </thead>
        <tbody data-state="filled">
          {overview.numbering.map((row) => {
            // next === null 的语义是「本月流水用满了」，不是「还没生成」——
            // 单号当月上限 9999，跨月才重新从 1 开始。
            const exhausted = row.next === null;
            return (
              <tr key={row.type} className="r-row">
                {/* row.type 是 A/B/E/C/N/R/S/I 的单字母代码（DOCUMENT_TYPES 的键），
                    显示必须走 DOCUMENT_TYPES 取中文 —— 页面上出现裸的 "E" 没人看得懂。 */}
                <td>{DOCUMENT_TYPES[row.type]}</td>
                <td className="font-mono text-xs">{row.rule}</td>
                <td className={`num font-mono ${exhausted ? 'text-rose-600' : ''}`}>
                  {exhausted ? '本月已用满' : row.next}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {overview.numbering.some((row) => row.next === null) && (
        <p className="mt-2 text-xs text-rose-600">
          单号当月上限 9999，已用满需等下个月，或联系管理员处理。
        </p>
      )}
    </section>
  );
}

function PermissionsBlock({ overview }: { readonly overview: SettingsOverview }) {
  // 后端已按 domain、action 排序；这里再分组一次，因为要一行一个 domain。
  const byDomain = new Map<string, string[]>();
  for (const permission of overview.permissions) {
    const actions = byDomain.get(permission.domain) ?? [];
    actions.push(permission.action);
    byDomain.set(permission.domain, actions);
  }

  return (
    <section className="panel">
      <h2 className="panel-h">我的权限</h2>
      <table className="table mt-3">
        <thead>
          <tr>
            <th>功能域</th>
            <th>可用动作</th>
          </tr>
        </thead>
        <tbody data-state="filled">
          {[...byDomain.entries()].map(([domain, actions]) => (
            <tr key={domain} className="r-row">
              <td>{DOMAINS[domain as keyof typeof DOMAINS] ?? domain}</td>
              <td className="flex flex-wrap gap-1.5 py-1.5">
                {actions.map((action) => (
                  <span key={action} className="badge">
                    {ACTIONS[action as keyof typeof ACTIONS] ?? action}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400">
        这里只显示你当前生效的权限，含岗位并集、个人覆盖与令牌收窄的结果。
        改权限在「权限设置」页。
      </p>
    </section>
  );
}

function TenantBlock({ overview }: { readonly overview: SettingsOverview }) {
  return (
    <section className="panel">
      <h2 className="panel-h">租户信息</h2>
      <dl className="mt-3 grid grid-cols-[88px_1fr] gap-y-1.5 text-xs text-slate-500">
        <dt>租户</dt>
        <dd>{overview.tenant.name}</dd>
        <dt>状态</dt>
        <dd>{overview.tenant.status}</dd>
      </dl>
    </section>
  );
}

/** 骨架：五块各一条灰条，不是转圈 —— 转圈让人不知道等的是什么。 */
function SkeletonBlocks() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((index) => (
        <section key={index} className="panel">
          <div className="h-3 w-24 animate-pulse rounded bg-slate-200" />
          <div className="mt-3 h-16 w-full animate-pulse rounded bg-slate-100" />
        </section>
      ))}
    </>
  );
}
