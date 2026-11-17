import { z } from 'zod';
import { AppError } from './errors.js';
import { InventoryBatchListQuerySchema } from './inventory.js';
import { PurchaseOrderListQuerySchema } from './purchase-orders.js';
import { defineRoute, type RouteDef } from './registry.js';
import { SalesOrderListQuerySchema } from './sales-orders.js';

/**
 * 列表导出契约（#342）：销售单 / 采购单 / 库存批次 三个 CSV 导出端点。
 *
 * 口径：
 * - 查询参数与各自的列表端点**完全一致**，但去掉分页字段（`cursor` / `limit`）：
 *   导出是「当前筛选条件下的全量」，能分页的导出会被用户当成分页结果去对账；
 * - 上限 `EXPORT_MAX_ROWS`：超限一律报错，绝不静默截断——被截断的导出比报错更危险，
 *   用户会拿它当全量对账依据；
 * - 响应体是**原生 CSV 文本**（不是 JSON 信封）：浏览器 / Excel 直连即下载，
 *   前端不需要把内容再转一手落盘；
 * - 审计：CSV 导出会带走整表数据，属敏感读，必记审计（D54 ② / D96）；
 * - AI 凭证禁止调用（导出等于批量外带数据），reasonRequired 保持与既有打印口径一致。
 *
 * 关于 `audit.kind`：注册表校验规则里「GET + write 审计」是硬禁（写审计意味着有副作用），
 * 导出虽然落审计记录，但本身只读，所以用 `sensitive-read`，与 D54 ② 的分类一致。
 */

/**
 * 单次导出最多行数。
 *
 * **这个数从 5000 放宽到 50000 是刻意做的取舍，账要算给人看**（#342 review）：
 *
 * - 为什么不是沿用销售单旧版的 5000：采购单与库存批次原来**根本没有上限**，
 *   三个端点必须同一个口径，否则用户在不同列表看到不同的行数上限，
 *   还会出现「销售单 5000 报错、采购单 2 万照导」这种没法解释的差异。
 * - 5 万行到底多大：一行大约 `单号(20) + 日期(10) + 客户名(中文按 3 字节，约 24)
 *   + 状态(9) + 经办人 uuid(36) + 数量(6) + 金额(12) ≈ 150 字节`，
 *   5 万行 ≈ **7.5 MB 文本**。`toCsv` 是「一次性拼串」（`join` 内部还要复制一遍），
 *   峰值内存按 2～3 倍估 ≈ **20 MB 量级**，一次性峰值完全可接受。
 * - 为什么这版反而比旧版更省：旧版 `exportSalesOrders` 直接调 `listSalesOrders`
 *   拉到 5000 行——而它会把**每张单的明细行与费用行一起 hydrate 成对象**，
 *   单张单 2～5 KB 是常态，5 万张单就能撑到几百 MB。新版导出查询只取
 *   表头列 + 一个 `SUM(qty)` 聚合子查询，明细根本不进内存。
 * - 如果将来还要往上抬：**不要继续抬这个常数**。正确做法是分批查（按 `id` 游标
 *   每批 N 行）+ 边查边往响应流里写，让峰值内存与总行数解耦；
 *   那是一次真正的流式改造，不是把 50000 改成 500000。
 *
 * 超限时的行为始终是报错（422，提示缩小筛选范围），**绝不静默截断**：
 * 被截断的导出会被用户当全量对账依据，比报错危险得多。
 */
export const EXPORT_MAX_ROWS = 50000;

/** 导出响应头（服务端与测试共用同一份常量，避免两处各写一遍字符串写歪）。 */
export const EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8';

/**
 * 生成 `content-disposition`。
 * 文件名是中文（`销售单-20261117.csv`），HTTP 头只能是 ASCII，
 * 因此走 RFC 5987 的 `filename*=UTF-8''<percent-encoded>` 形式（RFC 5987 编码见 D96）。
 */
export function exportContentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 导出响应体：整段 CSV 文本，含 BOM，CRLF 分行。 */
export const CsvExportBodySchema = z
  .string()
  .describe('CSV 文本（UTF-8 BOM + CRLF）；响应头见 content-type / content-disposition');

// 分页字段剔除：单独抽出来给三个 schema 复用，改口径只改这里。
const PAGING_FIELDS = { cursor: true, limit: true } as const;

/**
 * 导出拒绝分页参数。
 *
 * 为什么要显式报错而不是静默忽略：schema 里 omits 掉 cursor/limit 后 zod 会把它们丢掉，
 * 客户端传了 `?limit=100` 却拿到全量，只会以为「导出坏了 / 导出行数不对」。
 * 一次 422 加上明确文案，比事后解释省事。
 */
const PAGING_QUERY_KEYS = ['cursor', 'limit', 'page', 'pageSize'] as const;

export function assertNoPagingParams(rawQuery: unknown): void {
  if (rawQuery === null || typeof rawQuery !== 'object') return;
  const present = PAGING_QUERY_KEYS.filter(
    (key) => key in (rawQuery as Record<string, unknown>),
  );
  if (present.length === 0) return;
  throw new AppError(
    'VALIDATION_FAILED',
    '导出取的是当前筛选条件下的全量，不接受分页参数（cursor/limit/page/pageSize）',
    { params: present },
  );
}

export const SalesExportQuerySchema = SalesOrderListQuerySchema.omit(PAGING_FIELDS);
export const PurchaseExportQuerySchema = PurchaseOrderListQuerySchema.omit(PAGING_FIELDS);
export const InventoryBatchExportQuerySchema = InventoryBatchListQuerySchema.omit(
  PAGING_FIELDS,
);

export type SalesExportQuery = z.infer<typeof SalesExportQuerySchema>;
export type PurchaseExportQuery = z.infer<typeof PurchaseExportQuerySchema>;
export type InventoryBatchExportQuery = z.infer<typeof InventoryBatchExportQuerySchema>;

export const EXPORT_ROUTES: readonly RouteDef[] = [
  defineRoute({
    module: 'sales',
    domain: 'sales',
    action: 'export',
    // 这条端点原先登记在 prints.ts（`sales.order.export`）。导出迁到本文件后
    // 保留同一个 operationId 与路径，避免前端 / 权限页 / 流程图的 key 断裂。
    operationId: 'sales.order.export',
    method: 'GET',
    path: '/api/v1/sales-orders/export',
    summary: '销售单列表导出 CSV（全量、按筛选条件；敏感读，记审计）',
    audit: { kind: 'sensitive-read' },
    ai: { policy: 'forbid', reasonRequired: true },
    request: { query: SalesExportQuerySchema },
    response: { status: 200, schema: CsvExportBodySchema },
  }),
  defineRoute({
    module: 'purchase',
    domain: 'purchase',
    action: 'export',
    operationId: 'purchase.order.export',
    method: 'GET',
    path: '/api/v1/purchase-orders/export',
    summary: '采购单列表导出 CSV（全量、按筛选条件；敏感读，记审计）',
    audit: { kind: 'sensitive-read' },
    ai: { policy: 'forbid', reasonRequired: true },
    request: { query: PurchaseExportQuerySchema },
    response: { status: 200, schema: CsvExportBodySchema },
  }),
  defineRoute({
    module: 'inventory',
    // operationId 必须带域名前缀，而库存批次没有独立的 `inventory` 域，
    // 归属的是 `inventory_qty`（数量域）。注册表对 inventory_qty / inventory_flow
    // 两个域允许用 `inventory.` 伞名，故这里是 `inventory.batch.export`。
    domain: 'inventory_qty',
    action: 'export',
    operationId: 'inventory.batch.export',
    method: 'GET',
    path: '/api/v1/inventory/batches/export',
    summary: '库存批次列表导出 CSV（全量、按筛选条件；敏感读，记审计）',
    audit: { kind: 'sensitive-read' },
    ai: { policy: 'forbid', reasonRequired: true },
    request: { query: InventoryBatchExportQuerySchema },
    response: { status: 200, schema: CsvExportBodySchema },
  }),
];
