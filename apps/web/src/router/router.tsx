import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { Suspense, type ComponentType } from 'react';
import { AppLayout } from '../layouts/AppLayout';
import { LoginPage } from '../pages/auth/LoginPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { WorkbenchPage } from '../pages/workbench/WorkbenchPage';
import type { ImplementedPageId } from './implemented';
import { DEFAULT_ROUTE_PATH, ROUTE_TABLE, type RouteEntry } from './routes';
import { readSession } from './session-guard';

/**
 * TanStack Router 编码路由（file-based 生成器不用，保持骨架无额外构建步骤）。
 * 22 条页面路由全部由 `ROUTE_TABLE` 生成；已实现的页面在 `IMPLEMENTED_PAGES` 里覆盖占位页。
 *
 * 登录态（#4）：
 *   - `/login` 独立于应用外壳（无侧边栏）：已登录访问 → 直接进工作台；
 *   - 其余页面挂在 `_app` 路径无关布局下，进页面前先确认会话，401 → 回 `/login`。
 *   判定只认 `GET /auth/me`，前端不自己推断权限（D4/D15/D27）。
 */

const LOGIN_PATH = '/login';

function NotFound() {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">页面不存在</h1>
      <p className="mt-2 text-sm text-slate-500">请从左侧导航进入；当前为骨架阶段，仅 22 页已登记的页面。</p>
    </section>
  );
}

function RootShell() {
  return <Outlet />;
}

/** 会话校验以外的异常（如 API 不可达）不应该把用户当成未登录踢走，这里给可重试的兜底页。 */
function RootError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : '未知错误';
  return (
    <section className="mx-auto max-w-xl p-8">
      <h1 className="text-xl font-semibold tracking-tight">页面加载失败</h1>
      <p className="mt-2 text-sm text-slate-600">{message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
      >
        重新加载
      </button>
    </section>
  );
}

const rootRoute = createRootRoute({
  component: RootShell,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: DEFAULT_ROUTE_PATH });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: LOGIN_PATH,
  component: LoginPage,
  beforeLoad: async () => {
    const me = await readSession();
    if (me) {
      throw redirect({ to: DEFAULT_ROUTE_PATH });
    }
  },
});

/** 路径无关布局：登录后的所有页面共用 AppLayout（侧边导航 + 顶栏）。 */
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  component: AppLayout,
  beforeLoad: async () => {
    const me = await readSession();
    if (!me) {
      throw redirect({ to: LOGIN_PATH });
    }
    return { me };
  },
});

/**
 * 已落地 id → 组件。键集合由 `implemented.ts` 的 `IMPLEMENTED_PAGE_IDS` 约束：
 * 加了 id 却没写组件，这里编译期就报错，避免「登记了但打不开 / 打了标却是占位页」。
 *
 * 首包只保留高频路径（登录、工作台）和外壳；其余页面用 `lazyRouteComponent` 按需加载，
 * 配合 `defaultPreload: 'intent'`，鼠标移到导航项就开始预取 chunk。
 */
const IMPLEMENTED_PAGES: { [K in ImplementedPageId]: ComponentType } = {
  workbench: WorkbenchPage,
  flow: lazyRouteComponent(() => import('../pages/flow/FlowPage'), 'FlowPage'),
  products: lazyRouteComponent(() => import('../pages/masterdata/MasterdataPage'), 'ProductsPage'),
  customers: lazyRouteComponent(
    () => import('../pages/masterdata/MasterdataPage'),
    'CustomersPage',
  ),
  suppliers: lazyRouteComponent(
    () => import('../pages/masterdata/MasterdataPage'),
    'SuppliersPage',
  ),
  processors: lazyRouteComponent(
    () => import('../pages/masterdata/MasterdataPage'),
    'ProcessorsPage',
  ),
  'purchase-orders': lazyRouteComponent(
    () => import('../pages/purchase/PurchaseOrdersPage'),
    'PurchaseOrdersPage',
  ),
  inventory: lazyRouteComponent(
    () => import('../pages/inventory/InventoryPage'),
    'InventoryPage',
  ),
  'inventory-flows': lazyRouteComponent(
    () => import('../pages/inventory/InventoryFlowsPage'),
    'InventoryFlowsPage',
  ),
  stocktakes: lazyRouteComponent(
    () => import('../pages/inventory/StocktakesPage'),
    'StocktakesPage',
  ),
  employees: lazyRouteComponent(
    () => import('../pages/employees/EmployeesPage'),
    'EmployeesPage',
  ),
  permissions: lazyRouteComponent(
    () => import('../pages/permissions/PermissionsPage'),
    'PermissionsPage',
  ),
  companies: lazyRouteComponent(
    () => import('../pages/companies/CompaniesPage'),
    'CompaniesPage',
  ),
  'audit-logs': lazyRouteComponent(
    () => import('../pages/audit/AuditLogsPage'),
    'AuditLogsPage',
  ),
  'api-integration': lazyRouteComponent(
    () => import('../pages/api-integration/ApiIntegrationPage'),
    'ApiIntegrationPage',
  ),
  'processing-orders': lazyRouteComponent(
    () => import('../pages/processing/ProcessingOrdersPage'),
    'ProcessingOrdersPage',
  ),
  'sales-orders': lazyRouteComponent(
    () => import('../pages/sales/SalesOrdersPage'),
    'SalesOrdersPage',
  ),
  'internal-trades': lazyRouteComponent(
    () => import('../pages/internal-trades/InternalTradeOrdersPage'),
    'InternalTradeOrdersPage',
  ),
  reversals: lazyRouteComponent(
    () => import('../pages/reversals/ReversalsPage'),
    'ReversalsPage',
  ),
  settlements: lazyRouteComponent(
    () => import('../pages/settlements/SettlementsPage'),
    'SettlementsPage',
  ),
};

// `IMPLEMENTED_PAGE_IDS` 是 as const 元组，键一定是上面这些；此处只是把窄类型放宽回路由 id。
const implementedPageMap: Partial<Record<RouteEntry['id'], ComponentType>> = IMPLEMENTED_PAGES;

/** 懒加载页面的挂载态：只占内容区，侧边导航保持可点。 */
function PageLoading() {
  return (
    <p className="p-8 text-sm text-slate-500" role="status">
      页面加载中…
    </p>
  );
}

function PageForEntry({ entry }: { entry: RouteEntry }) {
  const Page = implementedPageMap[entry.id];
  return (
    <Suspense fallback={<PageLoading />}>
      {Page ? <Page /> : <PlaceholderPage entry={entry} />}
    </Suspense>
  );
}

const pageRoutes = ROUTE_TABLE.filter((entry) => entry.path !== LOGIN_PATH).map((entry) =>
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: entry.path,
    component: () => <PageForEntry entry={entry} />,
  }),
);

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appLayoutRoute.addChildren(pageRoutes),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
