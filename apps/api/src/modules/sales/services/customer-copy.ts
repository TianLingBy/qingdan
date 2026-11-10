import type { SalesOrderDetail } from '@qingdan/contracts';

/**
 * 销售单客户联 HTML（prints.ts 契约）。
 *
 * 纯函数：只接收**已按看价权限脱敏**的详情实体 + 已取好的展示文案，
 * 不发请求、不读库。无 `sales.view_price` 时金额渲染「—」，不得回落成 0（D27 / D79）。
 */

/** 打印展示文案：商品名 / 批次号由调用方经 D70 端口取好再传进来。 */
export interface SalesOrderPrintLabels {
  readonly productName: Readonly<Record<string, string>>;
  readonly batchNo: Readonly<Record<string, string>>;
}

/** 无看价权限的占位符；不要改成 0 或空串。 */
const NO_VALUE = '—';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value: string | null): string {
  return value === null ? NO_VALUE : escapeHtml(value);
}

/**
 * 商品名：优先用端口取回的名称；取不到（端口未接线 / 商品已删）时退回 productId 前 8 位，
 * 保证打印永远有内容、且仍可追溯（禁止在 sales 模块直读 product 表，D70）。
 */
function productLabel(productId: string, labels: SalesOrderPrintLabels): string {
  const name = labels.productName[productId];
  return escapeHtml(name ?? productId.slice(0, 8));
}

/** 批次号同理：优先 batch_no，取不到退回 batchId 前 8 位，保留批次可追溯性。 */
function batchLabel(batchIds: readonly string[], labels: SalesOrderPrintLabels): string {
  if (batchIds.length === 0) return NO_VALUE;
  return batchIds
    .map((batchId) => escapeHtml(labels.batchNo[batchId] ?? batchId.slice(0, 8)))
    .join('<br>');
}

/** 日期取 ISO 的日期段；客户联不展示秒级时间。 */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function renderFees(detail: SalesOrderDetail): string {
  if (detail.fees.length === 0) return '';
  const rows = detail.fees
    .map(
      (fee) => `
        <tr>
          <td>${escapeHtml(fee.feeName)}</td>
          <td class="num">${escapeHtml(fee.qty)}</td>
          <td class="num">${money(fee.unitPrice)}</td>
          <td class="num">${money(fee.amount)}</td>
        </tr>`,
    )
    .join('');

  return `
    <section class="section">
      <h2>费用</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">费用名称</th>
            <th scope="col" class="num">数量</th>
            <th scope="col" class="num">单价</th>
            <th scope="col" class="num">金额</th>
          </tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
    </section>`;
}

/**
 * 渲染销售单客户联：自包含 HTML（内联样式），A4 打印友好。
 * 调用方负责先做金额脱敏；本函数不再判断权限。
 */
export function renderSalesOrderCustomerCopy(
  detail: SalesOrderDetail,
  companyName: string,
  labels: SalesOrderPrintLabels,
): string {
  const lineRows = detail.lines
    .map(
      (line) => `
        <tr>
          <td>${productLabel(line.productId, labels)}</td>
          <td class="batch">${batchLabel(line.batchIds, labels)}</td>
          <td class="num">${escapeHtml(line.qty)}</td>
          <td class="num">${money(line.unitPrice)}</td>
          <td class="num">${money(line.amount)}</td>
        </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>销售单（客户联）</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: #111827;
    background: #fff;
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
    font-size: 12px;
    line-height: 1.55;
  }
  .doc { width: 100%; max-width: 182mm; margin: 0 auto; }
  .doc-header { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 12px; }
  .doc-header h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 1px; }
  .doc-header .company { margin: 0; font-size: 14px; font-weight: 600; }
  .meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 24px;
    margin: 0 0 14px;
    padding: 0;
  }
  .meta div { display: flex; gap: 8px; min-width: 0; }
  .meta dt { flex: 0 0 4em; color: #4b5563; margin: 0; }
  .meta dd { margin: 0; overflow-wrap: anywhere; }
  .section h2 { margin: 16px 0 6px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #9ca3af; padding: 5px 6px; vertical-align: top; }
  thead th { background: #f3f4f6; font-weight: 600; text-align: left; }
  .num { text-align: right; white-space: nowrap; }
  .batch { font-size: 11px; color: #374151; }
  .total {
    display: flex;
    justify-content: flex-end;
    align-items: baseline;
    gap: 12px;
    margin: 14px 0 0;
    padding-top: 8px;
    border-top: 2px solid #111827;
    font-size: 14px;
  }
  .total strong { font-size: 18px; }
  .doc-footer {
    margin-top: 24px;
    padding-top: 8px;
    border-top: 1px dashed #9ca3af;
    text-align: right;
    color: #4b5563;
    font-size: 11px;
    letter-spacing: 2px;
  }
  @media print {
    body { font-size: 11px; }
    .doc { max-width: none; }
    .section, tr { break-inside: avoid; }
    .doc-footer { position: fixed; bottom: 0; left: 0; right: 0; }
  }
</style>
</head>
<body>
<main class="doc">
  <header class="doc-header">
    <h1>销售单（客户联）</h1>
    <p class="company">${escapeHtml(companyName)}</p>
  </header>

  <dl class="meta">
    <div><dt>单号</dt><dd>${escapeHtml(detail.orderNo)}</dd></div>
    <div><dt>日期</dt><dd>${escapeHtml(formatDate(detail.createdAt))}</dd></div>
    <div><dt>客户</dt><dd>${escapeHtml(detail.customerName)}</dd></div>
    <div><dt>经办人</dt><dd>${escapeHtml(detail.handlerId)}</dd></div>
  </dl>

  <section class="section">
    <h2>商品明细</h2>
    <table>
      <thead>
        <tr>
          <th scope="col">商品</th>
          <th scope="col">批次</th>
          <th scope="col" class="num">数量</th>
          <th scope="col" class="num">单价</th>
          <th scope="col" class="num">金额</th>
        </tr>
      </thead>
      <tbody>${lineRows}
      </tbody>
    </table>
  </section>
${renderFees(detail)}
  <p class="total"><span>合计</span><strong>${money(detail.totalAmount)}</strong></p>

  <footer class="doc-footer">客户联</footer>
</main>
</body>
</html>`;
}
