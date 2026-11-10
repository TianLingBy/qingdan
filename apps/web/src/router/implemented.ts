import type { ComponentType } from 'react';
import { ApiIntegrationPage } from '../pages/api-integration/ApiIntegrationPage';
import { AuditLogsPage } from '../pages/audit/AuditLogsPage';
import { CompaniesPage } from '../pages/companies/CompaniesPage';
import { EmployeesPage } from '../pages/employees/EmployeesPage';
import { InventoryFlowsPage } from '../pages/inventory/InventoryFlowsPage';
import { InventoryPage } from '../pages/inventory/InventoryPage';
import { StocktakesPage } from '../pages/inventory/StocktakesPage';
import {
  ProcessorsPage,
  ProductsPage,
  SuppliersPage,
} from '../pages/masterdata/MasterdataPage';
import { PermissionsPage } from '../pages/permissions/PermissionsPage';
import type { RouteEntry } from './routes';

/**
 * 已实现页面登记表。
 *
 * 只在这里增加页面映射；`router.tsx` 保持路由生成逻辑，避免多人的业务页面
 * 同时修改同一段路由实现。未登记的页面继续回退到 `PlaceholderPage`。
 */
export const IMPLEMENTED_PAGES: Partial<Record<RouteEntry['id'], ComponentType>> = {
  products: ProductsPage,
  suppliers: SuppliersPage,
  processors: ProcessorsPage,
  inventory: InventoryPage,
  'inventory-flows': InventoryFlowsPage,
  stocktakes: StocktakesPage,
  employees: EmployeesPage,
  permissions: PermissionsPage,
  companies: CompaniesPage,
  'audit-logs': AuditLogsPage,
  'api-integration': ApiIntegrationPage,
};
