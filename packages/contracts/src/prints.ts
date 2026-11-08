import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';
import { SalesOrderListQuerySchema } from './sales-orders.js';

/**
 * 打印 / 导出契约（销售单打印、加工单打印、销售单列表导出）。
 *
 * 口径约束：
 * - 返回体统一为 `PrintDocumentSchema`：内容与文件名由服务端生成，前端只落盘 / 渲染；
 * - 销售单打印的金额受看价权限约束（D27 / D79）：无权限时金额为 null，不 403；
 * - 列表导出属敏感读，必记审计（D54 ②）；单张打印按普通读处理，不记审计。
 */

export const PrintDocumentSchema = z.object({
  contentType: z.enum(['text/html', 'text/csv']),
  content: z.string(),
  filename: z.string().min(1).max(200),
});
export type PrintDocument = z.infer<typeof PrintDocumentSchema>;

export const PRINT_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'sales',
    domain: 'sales',
    action: 'read',
    operationId: 'sales.order.print',
    method: 'GET',
    path: '/api/v1/sales-orders/{id}/print',
    summary: '销售单打印（客户联，HTML 文本；金额受看价权限约束，无权限为 null）',
    audit: { kind: 'none' },
    response: { status: 200, schema: PrintDocumentSchema },
  }),
  defineRoute({
    module: 'processing',
    domain: 'processing',
    action: 'read',
    operationId: 'processing.order.print',
    method: 'GET',
    path: '/api/v1/processing-orders/{id}/print',
    summary: '加工单打印（发厂联，HTML 文本）',
    audit: { kind: 'none' },
    response: { status: 200, schema: PrintDocumentSchema },
  }),
  defineRoute({
    module: 'sales',
    domain: 'sales',
    action: 'export',
    operationId: 'sales.order.export',
    method: 'GET',
    path: '/api/v1/sales-orders/export',
    summary: '销售单列表导出 CSV（按筛选条件；敏感读，记审计）',
    audit: { kind: 'sensitive-read' },
    request: { query: SalesOrderListQuerySchema },
    response: { status: 200, schema: PrintDocumentSchema },
  }),
];
