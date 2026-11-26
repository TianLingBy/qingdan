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

let failedPages = 0;
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

  // 源码里所有字符串字面量（单/双/反引号 + JSX 文本），统一去空白后比对
  const src = readFileSync(abs, 'utf8');
  const literals = src.match(/(?:'[^'\n]*'|"[^"\n]*"|`[^`]*`|>[^<>{}]{1,30}<)/g) || [];
  const haystack = norm(literals.join('|') + '|' + src);

  const missing = [];
  for (const th of spec.th || []) {
    if (!haystack.includes(norm(th))) missing.push(`表头「${th}」`);
  }
  for (const chip of spec.chips || []) {
    if (!haystack.includes(norm(chip))) missing.push(`筛选项「${chip}」`);
  }
  if (spec.title && !haystack.includes(norm(spec.title))) missing.push(`标题「${spec.title}」`);

  if (missing.length === 0) {
    lines.push(`PASS ${page}  (${spec.file})`);
  } else {
    failedPages++;
    lines.push(`FAIL ${page}  (${spec.file})\n      缺 ${missing.length} 项：${missing.join('、')}`);
  }
}

process.stdout.write(lines.join('\n') + '\n');
if (failedPages > 0) {
  process.stdout.write(`\n机器验收不通过：${failedPages} 个页面与设计稿结构不一致。\n`);
  process.exit(1);
}
process.stdout.write('\n机器验收通过：全部页面标题与表头与 design/v3.0 一致。\n');
