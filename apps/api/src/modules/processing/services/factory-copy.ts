import type { ProcessingMaterialInput, ProcessingOrder } from '@qingdan/contracts';

/**
 * 加工单发厂联 HTML（prints.ts 契约）。
 *
 * 纯函数：只接收详情实体与公司名，不发请求、不读库。
 * processing 无 `view_price` 脱敏口径，数量 / 金额按实体原样渲染；
 * 可空字段（损耗量 / 可售量 / 辅料 / 归属单）一律渲染「—」，不回落成 0 或空串。
 */

/** 可空字段的占位符；不要改成 0 或空串。 */
const NO_VALUE = '—';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function text(value: string | null): string {
  return value === null ? NO_VALUE : escapeHtml(value);
}

/** 材料批次按契约顺序逗号分隔，每行渲染「批号 × 数量」；空数组（契约不允许）也回落「—」。 */
function batchList(materialBatchIds: readonly ProcessingMaterialInput[]): string {
  if (materialBatchIds.length === 0) return NO_VALUE;
  return materialBatchIds
    .map((row) => `${escapeHtml(row.batchId)} × ${escapeHtml(row.qty)}`)
    .join(', ');
}

/** 日期取 ISO 的日期段；发厂联不展示秒级时间。 */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function renderFees(order: ProcessingOrder): string {
  const rows = order.fees
    .map(
      (fee) => `
        <tr>
          <td>${escapeHtml(fee.feeName)}</td>
          <td class="num">${escapeHtml(fee.qty)}</td>
          <td class="num">${escapeHtml(fee.unitPrice)}</td>
          <td class="num">${escapeHtml(fee.amount)}</td>
        </tr>`,
    )
    .join('');

  return `
    <section class="section">
      <h2>费用明细</h2>
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
 * 渲染加工单发厂联：自包含 HTML（内联样式），A4 打印友好。
 */
export function renderProcessingOrderFactoryCopy(
  order: ProcessingOrder,
  companyName: string,
): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>加工单（发厂联）</title>
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
    <h1>加工单（发厂联）</h1>
    <p class="company">${escapeHtml(companyName)}</p>
  </header>

  <dl class="meta">
    <div><dt>单号</dt><dd>${escapeHtml(order.orderNo)}</dd></div>
    <div><dt>日期</dt><dd>${escapeHtml(formatDate(order.createdAt))}</dd></div>
    <div><dt>加工厂</dt><dd>${escapeHtml(order.processorName)}</dd></div>
    <div><dt>经手人</dt><dd>${escapeHtml(order.handlerId ?? '—')}</dd></div>
    <div><dt>材料批次</dt><dd>${batchList(order.materialBatchIds)}</dd></div>
    <div><dt>辅料</dt><dd>${text(order.auxMaterials)}</dd></div>
  </dl>

  <section class="section">
    <h2>产出</h2>
    <table>
      <thead>
        <tr>
          <th scope="col" class="num">投入量</th>
          <th scope="col" class="num">损耗量</th>
          <th scope="col" class="num">可售量</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="num">${escapeHtml(order.inputQty)}</td>
          <td class="num">${text(order.lossQty)}</td>
          <td class="num">${text(order.sellableQty)}</td>
        </tr>
      </tbody>
    </table>
  </section>
${renderFees(order)}

  <dl class="meta">
    <div><dt>归属单据</dt><dd>${text(order.attributionDoc)}</dd></div>
  </dl>

  <footer class="doc-footer">发厂联</footer>
</main>
</body>
</html>`;
}
