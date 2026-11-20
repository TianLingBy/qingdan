#!/usr/bin/env node
/**
 * 后端功能表生成器：把接口真源渲染成人能读的「域 × 端点 × 权限 × If-Match × 前端已接」矩阵。
 *
 * 功能
 *   读 `packages/contracts/openapi.json`（`pnpm openapi` 的产物，与 `docs/api/openapi.yaml` 同源、
 *   由 CI 的 `spec-drift` 保证不漂移），逐域输出 Markdown 表格到 `docs/api/feature-matrix.md`，
 *   并另开两节：① 后端已就绪但前端没接的端点 ② 后端确实没有的能力（前端不许画）。
 *
 * 原理
 *   1. 权限列直接用规范里的 `x-scope`，它就是后端 `requireScope` 的动作，不另做映射——
 *      两处各写一份必然漂移（本项目已因「前端按角色猜权限」栽过）。
 *   2. `x-requires-if-match` 为真 = 写端点要乐观锁，前端不带 `If-Match` 会被 412 拒。
 *   3. 「前端已接」的判据是在 `apps/web/src/**` 里搜路径模板（`{id}` 允许被 `${...}` 或任意段替换）。
 *      这是**粗判**：命中代表前端源码里出现过这个 URL，不代表页面一定挂了组件 —— 所以
 *      联想类端点（路径以 suggest 结尾）单独列一节，它们的封装在 `apps/web/src/components/masterdata-suggest-api.ts`，
 *      但开单页还没挂 `<SuggestHint>`。
 *
 * 用法
 *   pnpm openapi                    # 先重生成 openapi.json（spec 改了必跑）
 *   node tools/gen-feature-matrix.mjs            # 默认写 docs/api/feature-matrix.md
 *   node tools/gen-feature-matrix.mjs --dir <repo> --out <file>
 *
 * 退出码：0 成功；2 用法错误或缺 openapi.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const ROOT = path.resolve(arg('dir', path.join(here, '..')));
const SPEC = path.join(ROOT, 'packages/contracts/openapi.json');
const OUT = path.resolve(arg('out', path.join(ROOT, 'docs/api/feature-matrix.md')));

if (!fs.existsSync(SPEC)) {
  console.error(`缺 ${SPEC}：先跑 pnpm openapi`);
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

const DOMAIN_CN = {
  api_integration: 'API 对接', employee: '员工与登录', permission: '权限与岗位', company: '公司',
  audit: '操作日志', product: '商品', customer: '客户', supplier: '供应商', processor: '加工厂',
  inventory_qty: '库存批次', inventory_flow: '库存流水', stocktake: '盘点', sales: '销售单 E',
  customer_return: '客户退货 R', purchase: '采购单 A', supplier_return: '供应商退货 S',
  processing: '加工单 B', internal_trade: '内部交易 N', settlement: '结算单 C', commission: '提成',
  payment: '支付', billing: '订阅计费', workbench: '工作台', profit_report: '利润报表'
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
}
const webFiles = [];
walk(path.join(ROOT, 'apps/web/src'), webFiles);
const webText = webFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const rows = [];
for (const [p, item] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
    const core = p.replace(/^\/api\/v1/, '');
    const re = new RegExp(
      core.replace(/\{[^}]+\}/g, '(?:\\$\\{[^}]*\\}|\\[[^\\]]*\\]|[A-Za-z0-9_.:\\-]+)').replace(/\//g, '\\/')
    );
    rows.push({
      method: m.toUpperCase(),
      core,
      tag: (op.tags || ['untagged'])[0],
      scope: op['x-scope'] || '—',
      ifMatch: !!op['x-requires-if-match'],
      summary: (op.summary || '').replace(/\s+/g, ' ').replace(/\|/g, '／'),
      used: re.test(webText) || webText.includes(core)
    });
  }
}

const tags = Object.keys(DOMAIN_CN).filter((t) => rows.some((r) => r.tag === t));
const uiMissing = rows.filter(
  (r) => !r.used && !['/health', '/payments/', '/openapi.json'].some((x) => r.core.startsWith(x))
);
const notMounted = rows.filter((r) => /suggest$/.test(r.core));
const main = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, '.git/HEAD'), 'utf8').trim();
  } catch {
    return '';
  }
})();

const PAGE_HINT = [
  [/\/contacts$/, '档案页 → 对接人抽屉'],
  [/contactId\}/, '档案页 → 对接人抽屉'],
  [/\/summary$/, '档案页 → 汇总卡（单数／累计金额／最近单据／流水）'],
  [/stocktakes\/.*\/reject/, '冲正页 → 盘点单驳回'],
  [/purchase-orders\/export/, '采购单列表 → 导出 CSV'],
  [/inventory\/batches\/export/, '库存列表 → 导出 CSV'],
  [/billing\/subscription/, '设置中心 → 订阅套餐'],
  [/employees\/me\/phone/, '设置中心 → 我的账号 → 换手机号']
];
const hintOf = (core) => (PAGE_HINT.find(([re]) => re.test(core)) || [, '待定'])[1];

const md = [];
md.push('# 后端功能表（给前端）');
md.push('');
md.push('> 由 `node tools/gen-feature-matrix.mjs` 从接口真源重生成（`packages/contracts/openapi.json`，');
md.push('> 与 `docs/api/openapi.yaml` 同源，CI `spec-drift` 保证不漂移）。不要手改本文件，改 spec 再重生成。');
md.push('>');
md.push('> 三条约定：');
md.push('> 1. **权限**列就是后端 `requireScope` 的动作，前端按钮的「能不能点」照它判：`allows(scope, 域, 动作)`；');
md.push('>    `read_all` 只影响列表「看谁的」，不改变单个动作能不能做。');
md.push('> 2. **If-Match** 为「是」的写端点必须带乐观锁 `If-Match: <etag>`（取自上一次 GET 的响应头），不带会被 412 拒。');
md.push('> 3. 无 `view_price` 权限时后端把金额字段置 `null`，前端显示「—」，不要当 0。');
md.push('');
md.push('## 总览');
md.push('');
md.push(`- 端点合计 **${rows.length}** 个，分布在 **${tags.length}** 个域。`);
md.push(`- 前端源码里已出现 **${rows.length - rows.filter((r) => !r.used).length}** 个；`);
md.push(`  **${uiMissing.length}** 个后端已就绪但前端没接（见文末清单）。`);
md.push('');
for (const t of tags) {
  const list = rows.filter((r) => r.tag === t);
  md.push(`## ${DOMAIN_CN[t]}（\`${t}\`，${list.length} 个端点）`);
  md.push('');
  md.push('| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of list) {
    md.push(
      `| ${r.method} | \`${r.core}\` | ${r.scope === '—' ? '—' : '`' + r.scope + '`'} | ${r.ifMatch ? '是' : '—'} | ${r.used ? '✓' : '**未接**'} | ${r.summary.slice(0, 90)} |`
    );
  }
  md.push('');
}
md.push('## 前端还没接的端点（后端已就绪）');
md.push('');
md.push('| 方法 | 路径 | 权限 | 归属页面 |');
md.push('| --- | --- | --- | --- |');
for (const r of uiMissing) {
  md.push(`| ${r.method} | \`${r.core}\` | ${r.scope === '—' ? '—' : '`' + r.scope + '`'} | ${hintOf(r.core)} |`);
}
md.push('');
md.push('## 封装已写、页面没挂的端点（最省力的活）');
md.push('');
md.push('联想端点前端已有客户端封装与组件，只差挂到开单表单里：');
md.push('');
md.push('- 客户端：`apps/web/src/components/masterdata-suggest-api.ts`（`masterdataSuggestApi.suggest(kind, { companyId, name })`）');
md.push('- 组件：`apps/web/src/components/SuggestHint.tsx`（`<SuggestHint kind="customer" name={name} companyId={companyId} onPick={...} />`）');
md.push('- 要挂的位置：销售开单（客户）、采购开单（供应商）、加工开单（加工厂）、商品录入（商品）');
md.push('');
md.push('| 方法 | 路径 | 权限 |');
md.push('| --- | --- | --- |');
for (const r of notMounted) md.push(`| ${r.method} | \`${r.core}\` | \`${r.scope}\` |`);
md.push('');
md.push('## 后端确实没有的能力（前端不许画）');
md.push('');
md.push('| 想画的东西 | 后端现状 |');
md.push('| --- | --- |');
md.push('| 销售单「审批」按钮 | 销售单没有审批端点，只有 `ship`（出库）与 `cancel`（取消）；审批只存在于采购 `complete`、加工 `complete`、退货 `complete`、盘点 `approve` |');
md.push('| 单据「删除」 | 一律软停用／取消，没有物理删除端点 |');
md.push('| 批量操作（批量发货／批量取消） | 没有批量端点，只能逐单 |');
md.push('| 附件／图片上传 | 没有上传端点 |');
md.push('| 打印 PDF | 打印是服务端渲染的 HTML 文本（`/print`），没有 PDF 端点 |');
md.push('| 销售／客户统计图表 | 只有 `profit_report` 两个端点与 `commission` 三个，其余图表没有数据源 |');
md.push('');

fs.writeFileSync(OUT, md.join('\n') + '\n', 'utf8');
console.log(`written ${OUT}  rows=${rows.length}  missing=${uiMissing.length}  ${main ? 'HEAD=' + main : ''}`);
