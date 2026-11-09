import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { AppLayout } from '../layouts/AppLayout';
import { ApiIntegrationPage } from '../pages/api-integration/ApiIntegrationPage';
import { AuditLogsPage } from '../pages/audit/AuditLogsPage';
import { EmployeesPage } from '../pages/employees/EmployeesPage';
import {
  ProcessorsPage,
  ProductsPage,
  SuppliersPage,
} from '../pages/masterdata/MasterdataPage';
import { PermissionsPage } from '../pages/permissions/PermissionsPage';
import { CompaniesPage } from '../pages/companies/CompaniesPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { DEFAULT_ROUTE_PATH, ROUTE_TABLE, type RouteEntry } from './routes';

/**
 * TanStack Router 编码路由（file-based 生成器不用，保持骨架无额外构建步骤）。
 * 22 条页面路由全部由 `ROUTE_TABLE` 生成；已实现的页面在 `IMPLEMENTED_PAGES` 里覆盖占位页。
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
  employees: EmployeesPage,
  permissions: PermissionsPage,
  companies: CompaniesPage,
  'audit-logs': AuditLogsPage,
  'api-integration': ApiIntegrationPage,
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
