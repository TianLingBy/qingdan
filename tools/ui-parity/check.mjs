#!/usr/bin/env node
/**
 * 机器验收：页面结构锚点比对（Issue 前端重做第一批前置门槛）
 *
 * 干什么：把 design/v3.0/index.html 每页的「标题 + 表头」锚点，逐条到对应 tsx 里找。
 *          找不到 = 该页没按稿子做（少列、改列名、没做这一块），直接判失败。
 * 为什么静态查：不引新依赖、CI 能跑、秒级完成；视觉像素级差异交给人工双页比对。
 *
 * 用法：
 *   node tools/ui-parity/check.mjs            # 全量，失败退出 1
 *   node tools/ui-parity/check.mjs 采购单     # 只查文件名/页名含关键字的
 *   node tools/ui-parity/check.mjs --files a.tsx,b.tsx  # CI 用：只查本次改动到的页面文件
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const anchors = JSON.parse(readFileSync(join(here, 'anchors.json'), 'utf8'));

const argv = process.argv.slice(2);
const filesFlag = argv.indexOf('--files');
const changedFiles = filesFlag >= 0 ? (argv[filesFlag + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const filter = filesFlag >= 0 ? '' : argv[0] || '';
const norm = (s) => String(s).replace(/\s+/g, '');

/**
 * 剥掉注释再当证据（见下面 `haystack` 的注释）。
 *
 * 只处理三种稳妥的形态，不追求完整的词法分析：
 * 1. `/* … *\/` 块注释（JSX 的 `{/* … *\/}` 也是它）；
 * 2. 整行 `// …`；
 * 3. 行尾 ` // …`（前面是空白、且该行没有引号把它包进去的那种）。
 * 字符串里出现 `//`（例如 URL）时不剥 —— 宁可漏剥，也不要把真文案删掉。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      if (/^\s*\/\//.test(line)) return '';
      const trailing = line.match(/^(.*?[^:])\s\/\/.*$/);
      if (trailing && !/['"`]/.test(trailing[1].replace(/\/\/.*/g, ''))) return trailing[1];
      return line;
    })
    .join('\n');
}

let failedPages = 0;
let waivedCount = 0;
const lines = [];

for (const [page, spec] of Object.entries(anchors)) {
  if (page.startsWith('_')) continue;
  if (changedFiles && !changedFiles.some((f) => spec.file.endsWith(f) || f.endsWith(spec.file))) {
    continue;
  }
  if (filter) {
    const hay = `${page} ${spec.file} ${spec.title}`;
    if (!hay.includes(filter)) continue;
  }

  const abs = join(repoRoot, spec.file);
  if (!existsSync(abs)) {
    lines.push(`FAIL ${page}  ← 文件不存在：${spec.file}`);
    failedPages++;
    continue;
  }

  // 源码里所有字符串字面量（单/双/反引号 + JSX 文本），统一去空白后比对。
  // **先剥注释**：不然在注释里写一句「稿子这里是『毛利率』，本仓没有」就能把锚点「混」过去，
  // 机器验收就成了文字游戏。注释（含 JSX 的 {/* … */}）一律不参与判定。
  const src = stripComments(readFileSync(abs, 'utf8'));
  const literals = src.match(/(?:'[^'\n]*'|"[^"\n]*"|`[^`]*`|>[^<>{}]{1,30}<)/g) || [];
  const haystack = norm(literals.join('|') + '|' + src);

  const missing = [];
  const waived = [];
  for (const th of spec.th || []) {
    if (haystack.includes(norm(th))) continue;
    const reason = spec.waivers?.[`th:${th}`];
    if (reason) waived.push({ key: `表头「${th}」`, reason });
    else missing.push(`表头「${th}」`);
  }
  for (const chip of spec.chips || []) {
    if (haystack.includes(norm(chip))) continue;
    const reason = spec.waivers?.[`chips:${chip}`];
    if (reason) waived.push({ key: `筛选项「${chip}」`, reason });
    else missing.push(`筛选项「${chip}」`);
  }
  if (spec.title && !haystack.includes(norm(spec.title))) {
    const reason = spec.waivers?.[`title:${spec.title}`];
    if (reason) waived.push({ key: `标题「${spec.title}」`, reason });
    else missing.push(`标题「${spec.title}」`);
  }

  // waiver 是「这一条对不上，原因写在这」的显式记录，不是静默放行：
  // 每次跑都把它打印出来（谁都能看见），并且一旦源码里补齐了就提醒删掉 waiver，
  // 免得它变成永久的遮羞布。key 形如 `th:毛利率` / `chips:待审批` / `title:销售单 E`。
  const staleWaivers = Object.keys(spec.waivers || {}).filter((key) =>
    haystack.includes(norm(key.slice(key.indexOf(':') + 1))),
  );

  if (missing.length === 0) {
    lines.push(`PASS ${page}  (${spec.file})`);
    waivedCount += waived.length;
    for (const item of waived) lines.push(`      WAIVE ${item.key} —— ${item.reason}`);
    for (const key of staleWaivers) {
      lines.push(`      NOTE  ${key} 已经对齐，请从 anchors.json 删掉这条 waiver`);
    }
  } else {
    failedPages++;
    lines.push(`FAIL ${page}  (${spec.file})\n      缺 ${missing.length} 项：${missing.join('、')}`);
    for (const item of waived) lines.push(`      另有已登记 waiver：${item.key}`);
  }
}

process.stdout.write(lines.join('\n') + '\n');
if (failedPages > 0) {
  process.stdout.write(`\n机器验收不通过：${failedPages} 个页面与设计稿结构不一致。\n`);
  process.exit(1);
}
process.stdout.write(
  waivedCount === 0
    ? '\n机器验收通过：全部页面标题与表头与 design/v3.0 一致。\n'
    : `\n机器验收通过：全部页面标题与表头与 design/v3.0 一致（其中 ${waivedCount} 项按 anchors.json 的 waiver 放过，原因见上）。\n`,
);
