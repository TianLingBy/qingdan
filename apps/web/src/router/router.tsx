import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { AppLayout } from '../layouts/AppLayout';
import {
  ProcessorsPage,
  ProductsPage,
  SuppliersPage,
} from '../pages/masterdata/MasterdataPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { DEFAULT_ROUTE_PATH, ROUTE_TABLE, type RouteEntry } from './routes';

/**
 * TanStack Router 编码路由（file-based 生成器不用，保持骨架无额外构建步骤）。
 * 22 条页面路由全部由 `ROUTE_TABLE` 生成，新增页面只改路由表。
 */

function NotFound() {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">页面不存在</h1>
      <p className="mt-2 text-sm text-slate-500">请从左侧导航进入；当前为骨架阶段，仅 22 页已登记的页面。</p>
    </section>
  );
}

const rootRoute = createRootRoute({
  component: AppLayout,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: DEFAULT_ROUTE_PATH });
  },
});

const IMPLEMENTED_PAGES: Partial<Record<RouteEntry['id'], ComponentType>> = {
  products: ProductsPage,
  suppliers: SuppliersPage,
  processors: ProcessorsPage,
};

function PageForEntry({ entry }: { entry: RouteEntry }) {
  const Page = IMPLEMENTED_PAGES[entry.id];
  return Page ? <Page /> : <PlaceholderPage entry={entry} />;
}

const pageRoutes = ROUTE_TABLE.map((entry) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: entry.path,
    component: () => <PageForEntry entry={entry} />,
  }),
);

const routeTree = rootRoute.addChildren([indexRoute, ...pageRoutes]);

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
