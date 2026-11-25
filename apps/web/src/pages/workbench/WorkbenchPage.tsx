/**
 * 工作台（`/workbench`，22 页 IA 第 2 页，登录后的落地页），按 **v3.0** 实现（#435）。
 *
 * 版式按负责人 2026-11-24 拍板（`docs/ui/frontend-change-rules.md` §四 第 7 条）：
 *   1. 顶部 KPI 四卡 → 2. 待办事项 → 3. 主业务链路（A→B→E→C）→ 4. 近 6 个月毛利趋势 → 5. 最近动态
 *
 * 三条硬口径：
 *   - **整块不渲染**：KPI / 链路 / 趋势 / 动态每块都先看 `allows(scope, domain, action)`，
 *     没权限就整块不出现，**不留「—」「已脱敏」这类占位**（比稿子严，负责人拍板）。
 *   - **待办接真接口** `GET /api/v1/todos`（权限 `workbench.read`，负责人 2026-11-24 确认：
 *     `workbench.todos.read` 是 operationId，不是 scope）；空态 `data-state="empty"` 文案「暂无待办」；
 *     点击用后端下发的 `routeId` 拼路由，前端不维护 domain → path 映射。
 *   - **入口卡片区删除**：工作台不再消费 `/auth/me` 的 `entries`（`servedEntries()` 保留给别处用）。
 *
 * 数据缺口（已在 PR 里报给负责人，不臆造）：
 *   - 「本月销售总额」后端没有销售汇总端点，`/reports/profit` 也只回毛利、不回收入；
 *   - 「可用库存」没有「按公司汇总可用量」的端点（批次列表是明细）。
 *   所以 KPI 四卡用**四个都有真源**的口径：待我处理、待签收、已结算单、期间毛利。
 */

import type { AuditLog, ProfitReport, ScopeMatrix, TodoItem } from '@qingdan/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Icon } from '../../components/icons/Icon';
import { platformAdminApi } from '../../api/platform-admin';
import { allows } from '../../lib/access';
import { authApi, authKeys } from '../auth/auth-api';
import { profitReportApi, profitReportQueryKeys } from '../report/profit-report-api';
import { salesApi, salesQueryKeys } from '../sales/sales-api';
import { workbenchApi, workbenchKeys } from './workbench-api';

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

/** `2026-11-01`（本地时间，不走 toISOString，避免 UTC 偏移把月份挪一天）。 */
export function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface MonthWindow {
  /** 显示用：`11 月`。 */
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

/**
 * 近 N 个月（含本月）的期间窗口，**按自然月首尾日**。
 * `/reports/profit` 必填 `periodStart`/`periodEnd`，漏传 422（负责人 2026-11-24 提醒）。
 */
export function lastMonths(now: Date, count = 6): readonly MonthWindow[] {
  const windows: MonthWindow[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0);
    windows.push({
      label: `${start.getMonth() + 1} 月`,
      periodStart: isoDate(start),
      periodEnd: isoDate(end),
    });
  }
  return windows;
}

/** 金额展示：decimal 字符串原样加 ¥，不在前端做四则运算（D54）。`null` = 脱敏/无权限。 */
export function moneyText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return value.startsWith('-') ? `−¥${value.slice(1)}` : `¥${value}`;
}

/* ------------------------------ 小组件 ------------------------------ */

function CardHead({ title, hint }: { readonly title: string; readonly hint?: string }) {
  return (
    <div className="card-h">
      <h3>{title}</h3>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export interface KpiCard {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly hint?: string;
}

/** 主业务链路节点：只用路由直跳，不带数字（数字来自各页列表，不在这里臆造）。 */
const CHAIN = [
  { id: 'purchase', path: '/purchase-orders', letter: 'A', label: '采购单', note: '原料入库 · 锁批次价' },
  { id: 'processing', path: '/processing-orders', letter: 'B', label: '加工单', note: '委外加工 · 记损耗' },
  { id: 'sales', path: '/sales-orders', letter: 'E', label: '销售单', note: '批次出库 · 两步签收' },
  { id: 'settlement', path: '/settlements', letter: 'C', label: '结算单', note: '一单一成本 · 自动生成' },
] as const;

/* ------------------------------ 展示层 ------------------------------ */

export interface WorkbenchTodo {
  readonly routeId: string;
  readonly title: string;
  readonly hint: string;
  readonly count: number;
}

export interface WorkbenchViewProps {
  readonly displayName: string;
  readonly companyCount: number;
  readonly scope?: ScopeMatrix;
  readonly todos: readonly TodoItem[];
  readonly todosLoading: boolean;
  /** 已发货待签收的销售单笔数；null = 无权限/未取数。 */
  readonly transitCount: number | null;
  /** 本月利润报表；null = 无权限或未就绪。 */
  readonly profit: ProfitReport | null;
  /** 近 6 个月毛利（金额可能为 null = 该月无看价权限）。 */
  readonly trends: readonly { readonly label: string; readonly grossProfit: string | null }[];
  /** 最近动态（审计日志前 5 条）。 */
  readonly feed: readonly AuditLog[];
  readonly onOpen: (path: string) => void;
  /** 测试注入固定时间，避免问候语随跑测时段变化。 */
  readonly now?: Date;
}

/**
 * 纯展示层：不取数、只按传入的数据 + scope 排版。
 * 判权在这里做（`allows`），这样 SSR 测试能直接断言「没权限整块不出现」。
 */
export function WorkbenchView({
  displayName,
  companyCount,
  scope,
  todos,
  todosLoading,
  transitCount,
  profit,
  trends,
  feed,
  onOpen,
  now = new Date(),
}: WorkbenchViewProps) {
  const canSales = allows(scope, 'sales', 'read');
  const canProfit = allows(scope, 'profit_report', 'read');
  const canAudit = allows(scope, 'audit', 'read');
  const canWorkbench = allows(scope, 'workbench', 'read');
  const canViewPrice = allows(scope, 'sales', 'view_price') || allows(scope, 'profit_report', 'view_price');

  const todoCount = todos.reduce((sum, todo) => sum + todo.count, 0);

  /* 1. KPI 四卡：每张都要「有权限 + 有真数据」，缺任一就不出这张卡 */
  const kpis: KpiCard[] = [];
  if (canWorkbench) {
    kpis.push({ key: 'todos', label: '待我处理', value: todosLoading ? '…' : String(todoCount), unit: '笔' });
  }
  if (canSales && transitCount !== null) {
    kpis.push({ key: 'transit', label: '待签收', value: String(transitCount), unit: '笔', hint: '已发货待客户签收' });
  }
  if (canProfit && profit) {
    kpis.push({
      key: 'settled',
      label: '本月已结算',
      value: String(profit.settledOrderCount),
      unit: '单',
      hint: '参与毛利汇总的 C 单',
    });
    // 无 view_price 时后端把金额置 null，按拍板整张卡不渲染（不是显示「—」）
    if (canViewPrice && profit.grossProfit !== null) {
      kpis.push({ key: 'gross', label: '本月毛利', value: moneyText(profit.grossProfit), hint: '已结算 C 单毛利合计' });
    }
  }

  /* 3. 链路：只渲染有 read 的域 */
  const chain = CHAIN.filter((node) => allows(scope, node.id, 'read'));

  /* 5. 动态：无 audit 权限整块不出现 */
  const feedRows = canAudit ? feed.slice(0, 5) : [];

  const todosState = todosLoading ? 'loading' : todos.length === 0 ? 'empty' : 'filled';

  return (
    <section className="wrap">
      <header className="p-head">
        <div>
          <h1>
            {greetingFor(now)}，{displayName}
          </h1>
          <p className="sub">
            {formatToday(now)} · 可访问 {companyCount} 家公司 · 每一笔内部交易，都算得清成本
          </p>
        </div>
        {canSales && (
          <div className="acts">
            <button type="button" className="btn btn-ghost" onClick={() => onOpen('/inventory')}>
              查看库存批次
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onOpen('/sales-orders')}>
              进入销售单 E
            </button>
          </div>
        )}
      </header>

      {kpis.length > 0 && (
        <div className="kpis" aria-label="关键指标">
          {kpis.map((kpi) => (
            <div key={kpi.key} className="kpi">
              <span className="kpi-label">{kpi.label}</span>
              <div className="kpi-v num">
                {kpi.value}
                {kpi.unit && <i>{kpi.unit}</i>}
              </div>
              {kpi.hint && <p className="kpi-m">{kpi.hint}</p>}
            </div>
          ))}
        </div>
      )}

      {/* 2. 待办：真接口 + data-state 四态之一（loading / empty / filled） */}
      {canWorkbench && (
        <div className="card" data-state={todosState} aria-label="待办事项">
          <CardHead title="待办事项" hint={`共 ${todos.length} 类 · 按权限点逐条判，没看到不等于没有`} />
          <div className="st-block st-filled">
            <ul className="wb-list">
              {todos.map((todo) => (
                <li key={todo.kind}>
                  <button
                    type="button"
                    className="wb-row"
                    onClick={() => onOpen(`/${todo.routeId}`)}
                  >
                    <span>
                      <b>{todo.title}</b>
                      <small>{todo.hint}</small>
                    </span>
                    <span className="wb-num">{todo.count} 笔</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="st-block st-loading">
            <p className="hint">正在加载待办…</p>
          </div>
          <div className="st-block st-empty">
            <div className="st-ico">
              <Icon name="check" size={96} />
            </div>
            <div className="st-title">暂无待办</div>
            <p className="st-desc">当前权限范围内没有待处理事项，可以先去主业务链路录单。</p>
          </div>
        </div>
      )}

      {/* 3. 主业务链路：按域 read 过滤，一个都没有就整块不渲染 */}
      {chain.length > 0 && (
        <div className="card">
          <CardHead title="主业务链路" hint="点击直达" />
          <ul className="wb-chain">
            {chain.map((node) => (
              <li key={node.id}>
                <button type="button" onClick={() => onOpen(node.path)}>
                  <span className="lt">{node.letter}</span>
                  <span>
                    <b>{node.label}</b>
                    <small>{node.note}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 4. 近 6 个月毛利趋势：无 profit_report.read 整块不出现 */}
      {canProfit && trends.length > 0 && (
        <div className="card">
          <CardHead title="近 6 个月毛利" hint="按自然月首尾日汇总已结算 C 单" />
          <ul className="wb-list">
            {trends.map((month) => (
              <li key={month.label} className="wb-trend">
                <span>{month.label}</span>
                <b className="num">{moneyText(month.grossProfit)}</b>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 5. 最近动态：无 audit.read 整块不出现 */}
      {canAudit && (
        <div className="card">
          <CardHead title="最近动态" hint="审计日志前 5 条" />
          {feedRows.length === 0 ? (
            <p className="wb-note">最近没有可展示的操作记录。</p>
          ) : (
            <ul className="wb-feed">
              {feedRows.map((log) => (
                <li key={log.id} className="wb-feed-row">
                  <time className="num">{log.time.slice(11, 16)}</time>
                  <span>
                    <b className="mono">{log.action}</b>
                    <small>
                      {log.objectType}
                      {log.objectId ? ` · ${log.objectId}` : ''} · {log.result}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------ 页面（取数） ------------------------------ */

export function WorkbenchPage() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me() });
  const scope = me.data?.scope;
  const ready = me.data !== undefined;

  const canSales = allows(scope, 'sales', 'read');
  const canProfit = allows(scope, 'profit_report', 'read');
  const canAudit = allows(scope, 'audit', 'read');

  // 待办：`GET /api/v1/todos`（workbench.read）。
  const todos = useQuery({
    queryKey: workbenchKeys.todos,
    queryFn: () => workbenchApi.todos(),
    enabled: ready,
  });

  // 待签收 = 已发货（状态是中文枚举，见 SALES_ORDER_STATES）。
  const transit = useQuery({
    queryKey: salesQueryKeys.list({ status: '已发货', page: 1, pageSize: 1 }),
    queryFn: () => salesApi.list({ status: '已发货', page: 1, pageSize: 1 }),
    enabled: ready && canSales,
  });

  const months = useMemo(() => lastMonths(new Date()), []);

  // 本月利润（KPI 用）。
  const profit = useQuery({
    queryKey: profitReportQueryKeys.report(months[months.length - 1]!),
    queryFn: () => profitReportApi.get(months[months.length - 1]!),
    enabled: ready && canProfit,
  });

  // 近 6 个月趋势：逐月一次（`/reports/profit` 是单期间聚合，没有按月数组）。
  const trendQueries = useQueries({
    queries: months.map((month) => ({
      queryKey: profitReportQueryKeys.report(month),
      queryFn: () => profitReportApi.get(month),
      enabled: ready && canProfit,
    })),
  });

  const feed = useQuery({
    queryKey: ['audit', 'recent'] as const,
    queryFn: () => platformAdminApi.listAuditLogs(),
    enabled: ready && canAudit,
  });

  const trends = months.map((month, index) => ({
    label: month.label,
    grossProfit: trendQueries[index]?.data?.grossProfit ?? null,
  }));

  const loading = !ready || todos.isPending;

  return (
    <WorkbenchView
      displayName={me.data?.displayName ?? '同事'}
      companyCount={me.data?.companyIds.length ?? 0}
      scope={scope}
      todos={todos.data?.items ?? []}
      todosLoading={loading}
      transitCount={canSales && transit.data ? transit.data.total : null}
      profit={canProfit ? (profit.data ?? null) : null}
      trends={canProfit ? trends : []}
      feed={feed.data?.items ?? []}
      onOpen={(path) => void navigate({ to: path })}
    />
  );
}
