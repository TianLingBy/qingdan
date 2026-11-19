/**
 * 工作台（`/workbench`，22 页 IA 第 2 页，登录后的落地页）· v0.13 重做（#339）。
 *
 * 版式按 `design/v0.13/工作台.html` 重做：问候 hero → KPI 三卡 → 两栏（待我处理 / 下一步）
 * → 「常用界面」按功能域分组的入口。数据一条没变，仍是 `GET /auth/me` + `GET /api/v1/todos`（D89）。
 *
 * 与设计稿的三处取舍（都是「不画后端没有的东西」）：
 * - 设计稿 hero 右上角的「新建采购单」主按钮**不放**：工作台不该替单据页做开单入口，
 *   而且按身份过滤后不是谁都能建；
 * - 设计稿第三块 KPI「我负责的进行中」**不做**：需要 `handlerId=me` 过滤，契约里 `handlerId`
 *   只接受 uuid（#354 第 3 条），用假数据凑比不做更坏；
 * - 设计稿右栏「今天发生」时间线**不做**：`platform.audit.read` 没有 `objectType/objectId`
 *   过滤参数（lozy66 在 #154 查清），拉全租户日志再本地筛会假空白。右栏换成按真实待办
 *   推导的「下一步做什么」。
 *
 * 四态**由 CSS 驱动**（`app-v013.css` 的 `[data-state] > .st-block`）：容器挂 `data-state`，
 * 四个分支常驻 DOM，不写 `{loading ? … : …}` 的条件渲染 —— 条件渲染会让状态块频繁挂载卸载，
 * 还绕开设计稿给状态块的背景与间距（见 `apps/web/src/styles/README.md:50-116`）。
 */

import type { ScopeMatrix, TodoItem } from '@qingdan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { workbenchEntries } from '../../lib/access';
import { resolveListState } from '../../lib/list-state';
import { isImplementedPage } from '../../router/implemented';
import { ROUTE_TABLE, NAV_DOMAINS, type Domain, type RouteEntry } from '../../router/routes';
import { authApi, authKeys } from '../auth/auth-api';
import { workbenchApi, workbenchKeys } from './workbench-api';

/** 每个入口卡片的一句话说明（与 `ROUTE_TABLE` 的 22 条一一对应，编译期保证不漏）。 */
const PAGE_BLURB = {
  login: '手机号 + 验证码登录、企业注册与入企',
  workbench: '落地页：待办、入口卡片、我负责的进行中单据',
  flow: 'A → B → E → C → 冲正的全链路单据关系',
  'purchase-orders': '原材料采购，入库即锁批次价（D5）',
  'processing-orders': '加工投入产出、损耗与加工费（D35 / F3）',
  'sales-orders': '选批次出售、破下限审批、内嵌收款（D20 / D22）',
  'internal-trades': '集团内公司间调拨，双边成本归集',
  settlements: '按月归集收支与提成，确认后不可改',
  reversals: '客户退货 R / 供应商退货 S / 盘点盈亏 I',
  products: '商品与别名、规格、单位、默认售价',
  customers: '客户档案与联系人',
  suppliers: '供应商档案与结算口径',
  processors: '加工厂档案与加工费约定',
  'masterdata-dedupe': '判掉开单时攒下的疑似重复档案，可合并 / 撤销',
  inventory: '批次可用量 + 委外在途量',
  'inventory-flows': '每笔出入库流水，可追溯',
  stocktakes: '盘点录入与盘盈盘亏冲正（D47 / D71）',
  employees: '员工、岗位与个人权限覆盖',
  permissions: '岗位权限矩阵：功能域 × 动作（D15）',
  companies: '公司主体与数据可见范围',
  'profit-report': '按公司 / 商品 / 客户看毛利与费用',
  'audit-logs': '所有写操作的审计流水（D51）',
  'api-integration': 'API Token 与外部系统对接（D52）',
} as const satisfies Record<RouteEntry['id'], string>;

/** 功能域图标（20×20 线性图标，描边走 `currentColor`，跟 `.ent-ico` 的口径一致）。 */
const DOMAIN_ICON: Record<Domain, string> = {
  公共: 'M10 3.5 16.5 6.5v7L10 16.5 3.5 13.5v-7zM3.5 6.5 10 9.5l6.5-3M10 9.5v7',
  单据与结算: 'M11 3H5.5v14h9V6.5zM11 3v3.5h3.5M8 10.5h4.5M8 13.5h3',
  冲正: 'M7 4.5 4 7.5l3 3M4 7.5h8.5a3.75 3.75 0 0 1 0 7.5H9',
  主数据: 'M4 5.5h12M4 10h12M4 14.5h8',
  库存: 'M10 3l6.5 3v8L10 17l-6.5-3V6zM3.5 6 10 9l6.5-3M10 9v8',
  组织: 'M10 4.5a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5M4.5 16.5c0-2.4 2.5-3.8 5.5-3.8s5.5 1.4 5.5 3.8',
  报表: 'M4.5 16.5V8M10 16.5V4.5M15.5 16.5v-6',
  系统: 'M10 7.75a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5M10 3v2.2M10 14.8V17M3 10h2.2M14.8 10H17',
};

/* ------------------------------ 纯函数 ------------------------------ */

/** 时段问候（本地时间）。测试直接传固定 Date。 */
export function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 6) return '夜深了';
  if (hour < 9) return '早上好';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** `2026年11月9日 周一`。不用 toLocaleDateString：Node 与浏览器时区/语言包可能不一致。 */
export function formatToday(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()] ?? ''}`;
}

/** 待办笔数 = 各条 `count` 之和（不是条数）。只显示「2 类」会让人误读成「今天只有 2 件事」。 */
export function todoTotal(todos: readonly TodoItem[]): number {
  return todos.reduce((sum, todo) => sum + todo.count, 0);
}

/** `routeId` 是契约里的页面 id；只有真的在 `ROUTE_TABLE` 里才给链接，避免造出不存在的路由。 */
function pathOf(routeId: string): RouteEntry['path'] | undefined {
  return ROUTE_TABLE.find((route) => route.id === routeId)?.path;
}

/**
 * 按功能域分组（顺序与左侧导航同一份 `NAV_DOMAINS`）。
 * 不用 `routesByDomain`：那个函数收 `RouteSpec`，会把 `id` 退化成 `string`，
 * 后面 `PAGE_BLURB[entry.id]` 与 `onOpen(entry.path)` 都要补断言 —— 这里保留字面量类型。
 */
function groupEntries(entries: readonly RouteEntry[]) {
  return NAV_DOMAINS.map((domain) => ({
    domain,
    routes: entries.filter((entry) => entry.domain === domain),
  })).filter((group) => group.routes.length > 0);
}

/* ------------------------------ 小组件 ------------------------------ */

function DomainIcon({ domain }: { readonly domain: Domain }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      style={{
        width: 20,
        height: 20,
        display: 'block',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }}
    >
      <path d={DOMAIN_ICON[domain]} />
    </svg>
  );
}

/** 状态块骨架（加载态用，`aria-label` 供测试与读屏识别）。 */
function TodoSkeleton() {
  return (
    <ul aria-label="待办加载中" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {[0, 1, 2].map((index) => (
        <li
          key={index}
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--line-1)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span
            className="sk"
            style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--surf-2)' }}
          />
          <span style={{ flex: 1 }}>
            <span
              className="sk"
              style={{ display: 'block', width: 120, height: 12, borderRadius: 6, background: 'var(--surf-2)' }}
            />
            <span
              className="sk"
              style={{
                display: 'block',
                width: 180,
                height: 10,
                borderRadius: 6,
                marginTop: 8,
                background: 'var(--surf-2)',
              }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface EntryCardsProps {
  readonly entries: readonly RouteEntry[];
  readonly onOpen: (path: RouteEntry['path']) => void;
}

/**
 * 常用界面：按功能域分组（分组真源 `routesByDomain` / `NAV_DOMAINS`，与左侧导航同一套）。
 * 只渲染 `entries`（已按 scope 过滤），组件本身不判权限。
 */
export function EntryCards({ entries, onOpen }: EntryCardsProps) {
  if (entries.length === 0) {
    return (
      <p className="card" style={{ padding: '18px 20px', color: 'var(--text-3)' }}>
        当前身份没有可进入的业务页面，请联系管理员调整岗位权限（D15）。
      </p>
    );
  }

  return (
    <div>
      {groupEntries(entries).map((group) => (
        <section key={group.domain} style={{ marginTop: 20 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              marginBottom: 6,
              paddingBottom: 8,
              borderBottom: '1px solid var(--line-1)',
            }}
          >
            <b style={{ color: 'var(--text-2)', letterSpacing: '.05em' }}>{group.domain}</b>
            <i style={{ fontStyle: 'normal', color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>
              {group.routes.length} 个入口
            </i>
          </div>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
              gap: '2px 10px',
            }}
          >
            {group.routes.map((entry) => (
              <li key={entry.id} style={{ minWidth: 0 }}>
                <a
                  href={entry.path}
                  onClick={(event) => {
                    // 保留 href 以便中键新开标签，左键走客户端路由（不整页刷新）。
                    event.preventDefault();
                    onOpen(entry.path);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    minHeight: 44,
                    padding: '6px 8px',
                    borderRadius: 8,
                    color: 'inherit',
                    textDecoration: 'none',
                  }}
                >
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      flex: 'none',
                      display: 'grid',
                      placeItems: 'center',
                      color: 'var(--text-2)',
                    }}
                  >
                    <DomainIcon domain={entry.domain} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <b
                      style={{
                        display: 'block',
                        fontWeight: 600,
                        letterSpacing: '-.01em',
                        color: 'var(--text-1)',
                      }}
                    >
                      {entry.title}
                    </b>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: 'var(--text-3)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {PAGE_BLURB[entry.id]}
                    </span>
                  </span>
                  {isImplementedPage(entry.id) ? null : (
                    <span className="st draft" style={{ marginLeft: 'auto', flex: 'none' }}>
                      待实现
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export interface TodoPanelProps {
  readonly todos: readonly TodoItem[];
  readonly loading: boolean;
  /** 无待办时的补充说明（按权限不同说法不一样）。 */
  readonly emptyHint: string;
  /** 加载失败时的原文；不传按「加载失败」处理。 */
  readonly error?: string;
  /** 点待办去对应页面；不传则待办不可点。 */
  readonly onOpen?: (path: RouteEntry['path']) => void;
}

/**
 * 待我处理：四态同一条 DOM，靠容器上的 `data-state` 由 CSS 切显示。
 * 优先级 loading → error → empty → filled 由 `resolveListState` 统一（与列表页同一套）。
 */
export function TodoPanel({ todos, loading, emptyHint, error, onOpen }: TodoPanelProps) {
  const state = resolveListState({
    isPending: loading,
    hasError: error !== undefined,
    isEmpty: todos.length === 0,
  });

  return (
    <div data-state={state}>
      {/* filled：真实待办 */}
      <div className="st-block st-filled">
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {todos.map((todo) => {
            const path = pathOf(todo.routeId);
            return (
              <li key={todo.kind}>
                <a
                  href={path}
                  onClick={(event) => {
                    if (path === undefined || onOpen === undefined) {
                      event.preventDefault();
                      return;
                    }
                    event.preventDefault();
                    onOpen(path);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '11px 8px',
                    borderBottom: '1px solid var(--line-1)',
                    color: 'inherit',
                    textDecoration: 'none',
                  }}
                >
                  <span
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 9,
                      display: 'grid',
                      placeItems: 'center',
                      flex: 'none',
                      fontWeight: 600,
                      background: 'rgba(var(--accent-rgb),.14)',
                      color: 'var(--accent-light)',
                    }}
                  >
                    {todo.title.slice(0, 1)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ display: 'block', fontWeight: 550, color: 'var(--text-1)' }}>{todo.title}</b>
                    <i style={{ fontStyle: 'normal', color: 'var(--text-3)' }}>{todo.hint}</i>
                  </span>
                  <span style={{ color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>
                    {todo.count} 笔
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>

      {/* loading：骨架 */}
      <div className="st-block st-loading">
        <TodoSkeleton />
      </div>

      {/* empty：文案 + 授权口径说明 */}
      <div className="st-block st-empty" style={{ padding: '28px 18px', textAlign: 'center' }}>
        <b style={{ display: 'block', color: 'var(--text-1)', marginBottom: 6 }}>当前没有待办</b>
        <i style={{ fontStyle: 'normal', color: 'var(--text-3)', lineHeight: 1.7 }}>{emptyHint}</i>
        <p style={{ margin: '10px auto 0', maxWidth: '42em', fontSize: 12, color: 'var(--text-decor)' }}>
          看不到不等于没有：后端按权限点逐条过滤，没权限的类别直接不返回 —— 这些活不归你，不是公司今天没活。
        </p>
      </div>

      {/* error：错误原文 + 刷新 */}
      <div className="st-block st-error" style={{ padding: '28px 18px', textAlign: 'center' }}>
        <b style={{ display: 'block', color: 'var(--danger-on-surface)', marginBottom: 6 }}>
          {error ?? '加载失败'}
        </b>
        <i style={{ fontStyle: 'normal', color: 'var(--text-3)' }}>接口没通时不要当成「没有待办」。</i>
      </div>
    </div>
  );
}

/* ------------------------------ 页面 ------------------------------ */

export interface WorkbenchViewProps {
  readonly displayName: string;
  readonly companyCount: number;
  readonly entries: readonly RouteEntry[];
  readonly todos: readonly TodoItem[];
  readonly loading: boolean;
  readonly onOpen: (path: RouteEntry['path']) => void;
  /** 测试注入固定时间，避免问候语随跑测时段变化。 */
  readonly now?: Date;
  /** 待办接口的错误原文（有值即渲染错误态）。 */
  readonly todoError?: string;
}

/**
 * 纯展示层：不取数、不判权限，只按传入的 entries / todos 排版。
 * 拆出来是为了能在没有 Router 上下文的环境里直接 SSR 断言版式（同 `LoginPage` 的做法）。
 */
export function WorkbenchView({
  displayName,
  companyCount,
  entries,
  todos,
  loading,
  onOpen,
  now = new Date(),
  todoError,
}: WorkbenchViewProps) {
  const total = todoTotal(todos);
  const pending = loading ? null : total;

  return (
    <section>
      {/* ① 问候 hero */}
      <div className="hero" style={{ marginBottom: 16 }}>
        <div className="eyebrow">工作台</div>
        <h1 className="hero-h">
          {greetingFor(now)}，{displayName}
        </h1>
        <p className="hero-sub" style={{ color: 'var(--text-2)' }}>
          {formatToday(now)} · 可访问 {companyCount} 家公司 · 你的身份可进入 {entries.length} 个页面
        </p>
        <div className="hero-tags" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span className="chip">身份由账号决定</span>
          <span className="chip">工作台与业务全流程图对全部登录员工开放（D44）</span>
          <span className="chip">入口按服务端下发的 scope 显示</span>
        </div>
      </div>

      {/* ② KPI 三卡：都用真实数据，没有假指标 */}
      <div className="kpis">
        <div className="kpi">
          <span>待我处理</span>
          <b>{pending === null ? '—' : pending}</b>
          <i>共 {todos.length} 类</i>
        </div>
        <div className="kpi">
          <span>可进入页面</span>
          <b>{entries.length}</b>
          <i>按权限过滤后的入口</i>
        </div>
        <div className="kpi">
          <span>可访问公司</span>
          <b>{companyCount}</b>
          <i>数据隔离范围（D15）</i>
        </div>
      </div>

      {/* ③ 两栏：待我处理 / 下一步做什么 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1.35fr) minmax(0,1fr)',
          gap: 14,
          marginBottom: 18,
          alignItems: 'start',
        }}
      >
        <div className="card">
          <div
            className="card-h"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              padding: '14px 18px 0',
            }}
          >
            <b style={{ color: 'var(--text-1)' }}>待我处理</b>
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>共 {todos.length} 类</span>
          </div>
          <TodoPanel todos={todos} loading={loading} error={todoError} emptyHint="" onOpen={onOpen} />
        </div>

        <div className="card">
          <div
            className="card-h"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              padding: '14px 18px 0',
            }}
          >
            <b style={{ color: 'var(--text-1)' }}>下一步做什么</b>
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>按待办推导</span>
          </div>
          <div style={{ padding: '10px 18px 16px' }}>
            {loading ? (
              <p style={{ color: 'var(--text-3)', fontSize: 12 }}>正在取待办…</p>
            ) : todos.length > 0 ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {todos.map((todo) => (
                  <li key={todo.kind} style={{ padding: '6px 0', color: 'var(--text-2)' }}>
                    · 处理「{todo.title}」{todo.count} 笔
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ color: 'var(--text-2)' }}>
                当前身份没有待审批事项，可浏览下方有权访问的资料页。
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ④ 常用界面（按功能域分组） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          marginTop: 26,
          paddingBottom: 10,
          borderBottom: '1px solid var(--line-1)',
        }}
      >
        <b style={{ color: 'var(--text-1)' }}>常用界面</b>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
          按账号身份过滤 · 共 {entries.length} 个入口
        </span>
      </div>
      <EntryCards entries={entries} onOpen={onOpen} />
    </section>
  );
}

export function WorkbenchPage() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me() });

  const scope: ScopeMatrix | undefined = me.data?.scope;
  const entries = useMemo(() => workbenchEntries(scope), [scope]);

  // 真接口：`GET /api/v1/todos`（D89）。等身份下来再发 —— 没登录时发出去只会拿 401。
  const todos = useQuery({
    queryKey: workbenchKeys.todos,
    queryFn: () => workbenchApi.todos(),
    enabled: me.data !== undefined,
  });

  return (
    <WorkbenchView
      displayName={me.data?.displayName ?? '同事'}
      companyCount={me.data?.companyIds.length ?? 0}
      entries={entries}
      todos={todos.data?.items ?? []}
      loading={me.data === undefined || todos.isPending}
      todoError={todos.error instanceof Error ? todos.error.message : undefined}
      onOpen={(path) => void navigate({ to: path })}
    />
  );
}
