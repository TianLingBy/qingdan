/**
 * 工作台（`/workbench`，22 页 IA 第 2 页，登录后的落地页）。
 *
 * 版式对齐 `prototype.html` 的 `pages.home`：问候 + KPI 卡片区 + 「下一步做什么」，
 * 本轮按 #5 的验收拆成三段：身份条、入口卡片（按 scope 显隐）、待办 + 我负责的进行中单据。
 *
 * 三条与原型不同的取舍：
 * - 「角色切换」（老板/销售/财务…）是原型为了演示做的，真实产品里没有 ——
 *   #5 明确要求「不在前端写死角色名」，因此身份条只显示姓名 + 公司数 + 可进入页面数；
 * - 「下一步做什么」文案完全由待办与 scope 推导（有待办就说处理待办，没待办就说可浏览资料页）；
 * - **待办接的是真接口**（`GET /api/v1/todos`，D89）。这一块曾经用 `workbench-mock.ts`
 *   的占位数据，注释里还留着「接口待做」；接口早就做了，占位数据一直没换，等于首屏
 *   每天给人看假数字。现在换掉了。
 * - 「我负责的进行中单据」那一块**撤掉了**，理由写在该组件原位置（需要 `handlerId=me`
 *   过滤，后端还不支持，见 #354 第 3 条）。宁可少一块，不留一块假的。
 */

import type { ScopeMatrix, TodoItem } from '@qingdan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { workbenchEntries } from '../../lib/access';
import { isImplementedPage } from '../../router/implemented';
import type { RouteEntry } from '../../router/routes';
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

/* ------------------------------ 小组件 ------------------------------ */

function SkeletonBlock({ className }: { readonly className: string }) {
  return <div className={`animate-pulse rounded bg-slate-100 ${className}`} />;
}

interface KpiProps {
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
}

function Kpi({ label, value, unit }: KpiProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-1">
        {value === null ? (
          <SkeletonBlock className="h-6 w-10" />
        ) : (
          <>
            <span className="text-2xl font-semibold tabular-nums text-slate-900">{value}</span>
            <span className="text-xs text-slate-400">{unit}</span>
          </>
        )}
      </dd>
    </div>
  );
}

export interface EntryCardsProps {
  readonly entries: readonly RouteEntry[];
  readonly onOpen: (path: RouteEntry['path']) => void;
}

/** 入口卡片区：只渲染 `entries`（已按 scope 过滤），组件本身不判权限。 */
export function EntryCards({ entries, onOpen }: EntryCardsProps) {
  if (entries.length === 0) {
    return (
      <p className="mt-3 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
        当前身份没有可进入的业务页面，请联系管理员调整岗位权限（D15）。
      </p>
    );
  }

  return (
    <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map((entry) => (
        <li key={entry.id} className="min-w-0">
          <a
            href={entry.path}
            onClick={(event) => {
              // 保留 href 以便中键新开标签，左键走客户端路由（不整页刷新）。
              event.preventDefault();
              onOpen(entry.path);
            }}
            className="block h-full rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-slate-300 hover:bg-slate-50"
          >
            <span className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium text-slate-900">{entry.title}</span>
              {isImplementedPage(entry.id) ? null : (
                <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                  待实现
                </span>
              )}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-slate-500">
              {PAGE_BLURB[entry.id]}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export interface TodoPanelProps {
  readonly todos: readonly TodoItem[];
  readonly loading: boolean;
  /** 无待办时的补充说明（按权限不同说法不一样）。 */
  readonly emptyHint: string;
}

/** 待办区：加载骨架 / 空状态 / 列表 三态。 */
export function TodoPanel({ todos, loading, emptyHint }: TodoPanelProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">待我处理</h2>
        <span className="text-[11px] text-slate-400">共 {todos.length} 类</span>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        后端按权限点逐条判：审批类要 `approve`，低库存预警要 `inventory_qty.read`（D89 / #378）。
        没权限的类别直接不返回 —— 所以「没看到」可能是不归你，不是真的没有。
      </p>

      {loading ? (
        <ul className="mt-3 space-y-2" aria-label="待办加载中">
          {[0, 1, 2].map((index) => (
            <li key={index} className="rounded-lg border border-slate-100 px-3 py-2">
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="mt-2 h-3 w-44" />
            </li>
          ))}
        </ul>
      ) : todos.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center">
          <p className="text-sm text-slate-600">当前没有待办</p>
          <p className="mt-1 text-xs text-slate-400">{emptyHint}</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {todos.map((todo) => (
            // key 用 kind 不用 id：契约里 TodoItem 没有 id 字段，`kind` 才是这套待办的唯一标识
            // （`TODO_KINDS` 是枚举）。曾经写 key={todo.id} 是因为占位数据类型自带 id。
            <li
              key={todo.kind}
              className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">{todo.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">{todo.hint}</p>
              </div>
              <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium tabular-nums text-rose-700">
                {todo.count} 笔
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 「我负责的进行中单据」原来在这个位置，2026-11-18 撤掉。
 *
 * 撤掉的理由是**它做不出来真的**：要「负责人是本人且未完结」，需要
 * `GET /api/v1/sales-orders?handlerId=me&status=进行中` 这类过滤，而
 * `handlerId` 目前只接受 uuid（`packages/contracts/src/sales-orders.ts:204`
 * 是 `z.string().uuid()`，没有 `'me'` 魔法值）。前端拿不到自己的 employeeId 之外的
 * 身份信息固然能拼，但拼出来的是「我负责的单据」还是「我随便填的一个 id 的单据」取决于
 * 那一行代码，而契约说了「只接受 uuid」。所以这块等 #354 第 3 条做完再恢复。
 *
 * 留着占位数据的代价比撤掉更大：老板每天第一眼看到的是假单号、假对象、假状态，
 * 而且数字会随着假数据生成逻辑漂移，看起来像真的。
 */
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
}: WorkbenchViewProps) {
  const todoCount = todos.reduce((sum, todo) => sum + todo.count, 0);

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <header className="rounded-xl border border-slate-200 bg-white px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {greetingFor(now)}，{displayName}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {formatToday(now)} · 可访问 {companyCount} 家公司 · 你的身份可进入 {entries.length} 个页面
            </p>
          </div>
          <p className="max-w-xs text-xs leading-relaxed text-slate-400">
            工作台与业务全流程图对全部登录员工开放（D44），下面的入口按服务端下发的 scope
            显示；能不能真正打开由接口判定。
          </p>
        </div>
      </header>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="待我处理" value={loading ? null : todoCount} unit="笔" />
        <Kpi label="可进入页面" value={entries.length} unit="个" />
      </dl>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">我的入口</h2>
          <span className="text-xs text-slate-400">
            按权限域过滤（共 {entries.length} 个）· 带「待实现」标记的还没做完
          </span>
        </div>
        <EntryCards entries={entries} onOpen={onOpen} />
      </section>

      <TodoPanel
        todos={todos}
        loading={loading}
        emptyHint={
          entries.length > 0
            ? '你的权限里没有待审批的事项，可以先去上面的入口录单据。'
            : '当前身份没有审批类权限，待办会为空。'
        }
      />

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">下一步做什么</h2>
        {loading ? (
          <SkeletonBlock className="mt-3 h-4 w-64" />
        ) : todos.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            {todos.map((todo) => (
              <li key={todo.kind}>
                · 处理「{todo.title}」{todo.count} 笔
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            当前身份没有待审批事项，可浏览上方有权访问的资料页。
          </p>
        )}
      </section>
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
      onOpen={(path) => void navigate({ to: path })}
    />
  );
}
