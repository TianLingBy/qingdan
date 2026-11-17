import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 打印契约（销售单打印、加工单打印）。
 * 列表导出（sales.order.export / purchase.order.export / inventory.batch.export）
 * 见 exports.ts（#342）。
 *
 * 口径约束：
 * - 返回体统一为 `PrintDocumentSchema`：内容与文件名由服务端生成，前端只落盘 / 渲染；
 * - 销售单打印的金额受看价权限约束（D27 / D79）：无权限时金额为 null，不 403；
 * - 单张打印按普通读处理，不记审计；
 * - 打印禁止 AI 凭证直接调用（与 sales 模块写路径口径一致，D52①）。
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
    ai: { policy: 'forbid', reasonRequired: true },
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
  // 销售单列表导出（sales.order.export）已迁到 exports.ts（#342）：
  // 三个导出端点统一为「原生 CSV + 全量上限」，与打印的 JSON 信封不是一回事，
  // 留在本文件会让人误以为导出也走 PrintDocumentSchema。
];
