import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { ApiError } from '../api/client';
import { queryClient } from '../api/query';
import { AppLayout } from '../layouts/AppLayout';
import { LoginPage } from '../pages/LoginPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { DEFAULT_ROUTE_PATH, ROUTE_TABLE } from './routes';
import { ensureSession, requireSession } from './guard';

/**
 * TanStack Router 编码路由（file-based 生成器不用，保持骨架无额外构建步骤）。
 *
 * 结构（M1-G 会话门禁接入后）：
 *   rootRoute（无壳）
 *   ├── /                → redirect 默认落地页
 *   ├── /login           → 登录页（公开；已登录访问则回工作台）
 *   └── 'authed'（无路径布局路由，beforeLoad 会话门禁 + AppLayout）
 *       └── ROUTE_TABLE 中其余 21 页 → PlaceholderPage
 *
 * 22 页仍以 `ROUTE_TABLE` 为唯一真源；/login 由 LoginPage 实装，其余 21 页为占位。
 */

function NotFound() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">页面不存在</h1>
      <p className="mt-2 text-sm text-slate-500">请从左侧导航进入；当前为骨架阶段，仅 22 页已登记的页面。</p>
    </section>
  );
}

/** 统一错误体兜底页：路由加载抛出的错误（含 5xx / 网络错误）在这里承接。 */
function RouteError({ error }: { error: unknown }) {
  const isApi = error instanceof ApiError;
  return (
    <section className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">页面加载失败</h1>
      <p className="mt-2 text-sm text-slate-700">
        {isApi && error.message.length > 0 ? error.message : '发生意外错误，请稍后重试。'}
      </p>
      {isApi && error.requestId ? (
        <p className="mt-1 font-mono text-xs text-slate-400">追踪号 {error.requestId}</p>
      ) : null}
      <p className="mt-4 text-xs text-slate-400">
        若持续出现，请联系管理员并附上页面地址与追踪号。
      </p>
    </section>
  );
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFound,
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
  path: '/login',
  component: LoginPage,
  beforeLoad: async () => {
    // 已登录访问登录页 → 直接回工作台。接口不可用（5xx/网络断）时也按未登录处理，
    // 保证登录页始终可渲染；错误留到提交时展示。
    const session = await ensureSession(queryClient).catch(() => null);
    if (session) {
      throw redirect({ to: DEFAULT_ROUTE_PATH });
    }
  },
});

const authedLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  component: AppLayout,
  beforeLoad: () => requireSession(queryClient),
});

const pageRoutes = ROUTE_TABLE.filter((entry) => entry.id !== 'login').map((entry) =>
  createRoute({
    getParentRoute: () => authedLayoutRoute,
    path: entry.path,
    component: () => <PlaceholderPage entry={entry} />,
  }),
);

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  authedLayoutRoute.addChildren(pageRoutes),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultErrorComponent: RouteError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
